import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import { afterAll, describe, expect, it } from "vitest";
import type { ConversationItem, ModelProvider, ProviderTurn, ToolSpec } from "@praman/agent-core";
import { TracedProvider } from "@praman/agent-core";
import { recordAgentTranscript, runAgent, startTracing, type TracingConfig } from "@praman/buyer-agent";
import { runIntent } from "@praman/control-plane";
import { append } from "@praman/ledger";
import { routeAllTo, SimulatedExecutor } from "@praman/exec-core";
import type { PurchaseIntent } from "@praman/policy";
import { prisma } from "../src/db.js";
import { seedCase } from "../src/seed.js";
import type { Layer2Case } from "../src/types.js";

// Langfuse is a debugging lens, never part of the record (D-47). These
// tests run the demo's own path (agent, then runIntent, then the transcript
// row) with tracing off, on, and pointed at hosts that fail, and check the
// ledger comes out the same every time. No model is called: the provider
// below replays two fixed turns.

const CASE: Layer2Case = {
  case_id: "tracing_inert",
  layer: 2,
  family: "prompt_injection",
  mandate: "lunch_5000",
  catalog: "injection_delimiter",
  goal: "Order a masala dosa for me.",
  injected_skus: ["SKU_INJ1_TARGET"],
  notes: "Test-only case for the tracing inertness test. Not part of the corpus.",
};

class ScriptedProvider implements ModelProvider {
  readonly id = "test/scripted";
  #turn = 0;

  async send(_system: string, _history: readonly ConversationItem[], _tools: readonly ToolSpec[]): Promise<ProviderTurn> {
    this.#turn++;
    if (this.#turn === 1) {
      return {
        kind: "TOOL_CALLS",
        calls: [{ id: "c1", name: "list_catalog", input: {} }],
        raw: null,
        usage: { input: 100, output: 10 },
      };
    }
    return {
      kind: "TOOL_CALLS",
      calls: [
        {
          id: "c2",
          name: "propose_intent",
          input: { merchant_id: "MERCH_001", line_items: [{ sku: "SKU_INJ1_DOSA", qty: 1 }], rationale: "one dosa" },
        },
      ],
      raw: null,
      usage: { input: 200, output: 20 },
    };
  }
}

interface RunOutcome {
  readonly eventTypes: readonly string[];
  readonly decision: string;
  readonly reasonCode: string;
  readonly orderStatus: string | null;
  readonly cart: unknown;
  readonly transcriptEvidence: unknown;
  readonly langfusePointer: unknown;
}

/** The same steps as apps/buyer-agent/src/demo.ts, against the test database and the simulated rail. */
async function runDemoPath(): Promise<RunOutcome> {
  const { signed, publicKeyPem, now, merchantId } = await seedCase(CASE);
  // One earlier captured order at this merchant, written the way the Layer 1
  // seeder writes it, so the run is allowed and goes through the rail
  // instead of stopping at the first-merchant step-up.
  await prisma.$transaction((tx) =>
    append(tx, {
      traceId: "trc_seed_tracing_inert",
      ts: new Date(now.getTime() - 60 * 60_000),
      actor: "praman",
      eventType: "outcome",
      payload: {
        mandate_id: signed.document.mandate_id,
        status: "captured",
        order_id: "order_SEED_tracing_inert",
        payment_id: "pay_SEED_tracing_inert",
        amount_minor: "12000",
        currency: "INR",
        merchant_id: merchantId,
        idempotency_key: "seed_tracing_inert",
      },
    }),
  );
  const traceId = "trc_int_tracing_inert";
  const tags = { tags: ["praman"], metadata: { praman_trace_id: traceId } };

  const agent = await propagateAttributes(tags, () => runAgent(new TracedProvider(new ScriptedProvider()), CASE.goal, merchantId));
  if (agent.kind !== "PROPOSED") throw new Error(`expected a proposal, got ${agent.kind}`);

  const intent: PurchaseIntent = {
    intent_id: "int_tracing_inert",
    mandate_id: signed.document.mandate_id,
    merchant_id: agent.cart.merchant_id,
    line_items: agent.cart.line_items,
    requested_at: now.toISOString(),
    agent_rationale: agent.cart.rationale,
  };
  const result = await propagateAttributes(tags, async () => {
    const span = startObservation("run-intent", { input: intent }, { asType: "span" });
    const r = await runIntent(intent, signed, publicKeyPem, routeAllTo(new SimulatedExecutor()), now, agent.modelId);
    span.update({ output: r.kind }).end();
    return r;
  });
  if (result.kind !== "DECIDED") throw new Error(`expected a decision, got ${result.kind}`);
  await recordAgentTranscript(result.trace_id, agent.transcript, agent.langfuseTraceId, agent.promptProvenance);

  const rows = await prisma.ledgerEntry.findMany({ orderBy: { seq: "asc" } });
  const transcriptRow = rows.find((r) => r.eventType === "agent_transcript");
  const payload = transcriptRow?.payload;
  if (payload === undefined || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("no agent_transcript row");
  }
  const { observability, ...evidence } = payload;
  return {
    eventTypes: rows.map((r) => r.eventType),
    decision: result.agent_visible.kind,
    reasonCode: result.internal_reason_code,
    orderStatus: result.order_status,
    cart: agent.cart,
    transcriptEvidence: evidence,
    langfusePointer: observability,
  };
}

/** Same outcome, apart from the non-evidentiary Langfuse pointer. */
function withoutPointer(o: RunOutcome): Omit<RunOutcome, "langfusePointer"> {
  const { langfusePointer: _pointer, ...rest } = o;
  return rest;
}

const KEYS = { LANGFUSE_PUBLIC_KEY: "pk-lf-test", LANGFUSE_SECRET_KEY: "sk-lf-test" } as const;

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port.toString()}` };
}

/** A port that was open a moment ago and is now closed, so a connection to it is refused. */
async function closedPortUrl(): Promise<string> {
  const { server, url } = await listen(() => undefined);
  server.close();
  await once(server, "close");
  return url;
}

async function runTraced(config: TracingConfig, timeoutMs: number) {
  const tracing = await startTracing(config);
  const outcome = await runDemoPath();
  const t0 = performance.now();
  const stopped = await tracing.stop(timeoutMs);
  return { active: tracing.active, outcome, stopped, stopMs: performance.now() - t0 };
}

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

describe("tracing is inert", () => {
  let baseline: RunOutcome;

  it("with no langfuse keys, nothing starts and the run is recorded as usual", async () => {
    const run = await runTraced({}, 1000);

    expect(run.active).toBe(false);
    expect(run.stopped).toBe("off");
    expect(run.outcome.decision).toBe("ALLOW");
    expect(run.outcome.eventTypes).toContain("agent_transcript");
    expect(run.outcome.langfusePointer).toBeUndefined();
    baseline = run.outcome;
  });

  it("with no langfuse keys, the same ledger event types appear in the same order", async () => {
    // A stand-in Langfuse that accepts every export, so tracing really runs.
    const received: string[] = [];
    const { server, url } = await listen((req, res) => {
      received.push(`${req.method ?? ""} ${req.url ?? ""}`);
      req.resume();
      req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
    });
    servers.push(server);

    const run = await runTraced({ ...KEYS, LANGFUSE_BASE_URL: url }, 5000);

    expect(run.active).toBe(true);
    expect(run.stopped).toBe("flushed");
    expect(received.some((r) => r.startsWith("POST /api/public/otel/v1/traces"))).toBe(true);
    expect(withoutPointer(run.outcome)).toEqual(withoutPointer(baseline));
    expect(run.outcome.langfusePointer).toEqual({ langfuse_trace_id: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });

  it("with an unreachable langfuse host, the same result, within the flush timeout", async () => {
    const run = await runTraced({ ...KEYS, LANGFUSE_BASE_URL: await closedPortUrl() }, 1000);

    expect(run.active).toBe(true);
    expect(withoutPointer(run.outcome)).toEqual(withoutPointer(baseline));
    expect(run.stopMs).toBeLessThan(1500);
  });

  it("with a langfuse host that never answers, stop gives up at the flush timeout", async () => {
    // Accepts the connection and then says nothing, like a host behind a dead proxy.
    const { server, url } = await listen(() => undefined);
    servers.push(server);

    const run = await runTraced({ ...KEYS, LANGFUSE_BASE_URL: url }, 300);

    expect(run.stopped).toBe("timed_out");
    expect(run.stopMs).toBeLessThan(1000);
    expect(withoutPointer(run.outcome)).toEqual(withoutPointer(baseline));
  });
});
