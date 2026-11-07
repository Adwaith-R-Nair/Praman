import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationItem, ModelProvider, ProviderTurn, ToolSpec } from "@praman/agent-core";
import { releaseStaleOrders } from "@praman/control-plane";
import { prisma } from "@praman/db";
import { deriveState } from "@praman/ledger";
import { generateKeypair } from "@praman/mandate";
import type { CaptureRequest, CreateOrderRequest, ExecOutcome, OrderLookup } from "@praman/exec-core";
import type { SavedMethodCharger, SetupToken, VaultResult } from "@praman/paypal-exec";
import type { Minor } from "@praman/shared";
import { HARNESS_LIMITS } from "../src/demo/config.js";
import { routeFor, type DemoDeps, type VaultApi } from "../src/demo/connect.js";
import { createDemoHandler, sweepExpiredSessions, COOKIE } from "../src/demo/routes.js";
import { seedDemoCatalog } from "../src/demo/seed.js";
import { SavedMethods, SessionStore } from "../src/demo/session.js";
import { loadRecording, recordingHtml } from "../src/pages/demo.js";

// Lets one test make the transcript write fail once, after the payment has gone through.
const transcriptFault = vi.hoisted(() => ({ armed: false }));
vi.mock("@praman/buyer-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@praman/buyer-agent")>();
  return {
    ...actual,
    recordAgentTranscript: async (...args: Parameters<typeof actual.recordAgentTranscript>) => {
      if (transcriptFault.armed) {
        transcriptFault.armed = false;
        throw new Error("transcript store unavailable");
      }
      return actual.recordAgentTranscript(...args);
    },
  };
});

// Plan Tasks 12 and 14, against the test database. The model is scripted and PayPal is a
// stand-in that answers the way the sandbox did on 2026-11-08 (D-49). No network.

const PAYMENT_TOKEN = "PAYTOKEN-9f8e7d-NEVER-SHOWN";
const SETUP_TOKEN = "SETUPTOKEN1";

/** Proposes the cart each step's goal asks for, after reading the catalog once. */
class ScriptedModel implements ModelProvider {
  readonly id = "test/scripted-demo-model";
  calls = 0;
  fail = false;
  async send(_s: string, history: readonly ConversationItem[], _t: readonly ToolSpec[]): Promise<ProviderTurn> {
    this.calls += 1;
    if (this.fail) throw new Error("model exploded\n    at secretFunction (/srv/app/internal.ts:42:7)");
    const first = history[0];
    const goal = first?.role === "user" ? first.text : "";
    if (history.length === 1) return { kind: "TOOL_CALLS", calls: [{ id: "c1", name: "list_catalog", input: {} }], raw: null };
    const cart = goal.includes("Burrito")
      ? { merchant_id: "DEMO_CAFE", line_items: [{ sku: "SKU_CAFE_BOWL", qty: 1 }] }
      : goal.includes("Iced Coffee")
        ? { merchant_id: "DEMO_CAFE", line_items: [{ sku: "SKU_CAFE_COFFEE", qty: 1 }] }
        : goal.includes("Team Lunch")
          ? { merchant_id: "DEMO_CAFE", line_items: [{ sku: "SKU_CAFE_TRAY", qty: 1 }] }
          : { merchant_id: "DEMO_MARKET", line_items: [{ sku: "SKU_INJ2_DOSA", qty: 1 }, { sku: "SKU_INJ2_COFFEE", qty: 1 }] };
    return { kind: "TOOL_CALLS", calls: [{ id: "c2", name: "propose_intent", input: { ...cart, rationale: "what the goal asked for" } }], raw: null };
  }
}

interface FakeOrder {
  id: string;
  amount: Minor;
  approved: boolean;
  captured: boolean;
}

/** PayPal as seen on 2026-11-08: a saved-method charge is captured on creation; a checkout order waits for the buyer. */
class FakePayPal implements SavedMethodCharger, VaultApi {
  readonly rail = "paypal";
  readonly charges: { req: CreateOrderRequest; vaultId: string }[] = [];
  readonly checkouts: CreateOrderRequest[] = [];
  readonly deleted: string[] = [];
  readonly orders = new Map<string, FakeOrder>();
  #n = 0;

  #view(o: FakeOrder): ExecOutcome {
    return {
      rail: "paypal",
      order_id: o.id,
      status: o.captured ? "captured" : "created",
      amount_minor: o.amount,
      currency: "USD",
      payment_id: o.captured ? `CAP_${o.id}` : null,
      approve_url: o.captured ? null : `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}`,
      failure_code: null,
    };
  }
  async chargeSavedMethod(req: CreateOrderRequest, vaultId: string): Promise<ExecOutcome> {
    this.charges.push({ req, vaultId });
    const o = { id: `VLT${String(++this.#n)}`, amount: req.amount_minor, approved: true, captured: true };
    this.orders.set(o.id, o);
    return this.#view(o);
  }
  async createOrder(req: CreateOrderRequest): Promise<ExecOutcome> {
    this.checkouts.push(req);
    const o = { id: `CHK${String(++this.#n)}`, amount: req.amount_minor, approved: false, captured: false };
    this.orders.set(o.id, o);
    return this.#view(o);
  }
  async findOrder(lookup: OrderLookup): Promise<ExecOutcome | null> {
    const o = lookup.order_id === null ? undefined : this.orders.get(lookup.order_id);
    return o === undefined ? null : this.#view(o);
  }
  async capture(req: CaptureRequest): Promise<ExecOutcome> {
    const o = this.orders.get(req.order_id);
    if (o === undefined) throw new Error("no such order");
    if (!o.approved) return { ...this.#view(o), status: "failed", approve_url: null, failure_code: "ORDER_NOT_APPROVED" };
    o.captured = true;
    return this.#view(o);
  }
  approveAll(): void {
    for (const o of this.orders.values()) o.approved = true;
  }
  async createSetupToken(): Promise<VaultResult<SetupToken>> {
    return { ok: true, value: { id: SETUP_TOKEN, approveUrl: `https://www.sandbox.paypal.com/agreements/approve?approval_session_id=${SETUP_TOKEN}` } };
  }
  async createPaymentToken(setupTokenId: string): Promise<VaultResult<{ readonly id: string }>> {
    return setupTokenId === SETUP_TOKEN ? { ok: true, value: { id: PAYMENT_TOKEN } } : { ok: false, code: "INVALID_RESOURCE_ID" };
  }
  async deletePaymentToken(id: string): Promise<VaultResult<null>> {
    this.deleted.push(id);
    return { ok: true, value: null };
  }
}

let server: Server;
/** Each test gets fresh deps; the one server calls whichever handler is current. */
let handler: ReturnType<typeof createDemoHandler> = async () => {};
let base: string;
let deps: DemoDeps;
let paypal: FakePayPal;
let model: ScriptedModel;
let clock: number;
const logs: string[] = [];
const responses: string[] = [];

function makeDeps(): DemoDeps {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  return {
    sessions: new SessionStore({ privateKeyPem, publicKeyPem, keyId: "test_demo_k1" }),
    savedMethods: new SavedMethods(),
    publicKeyPem,
    paypal: { executor: paypal, vault: paypal },
    provider: model,
    baseUrl: base,
    now: () => new Date(clock),
    log: (line) => logs.push(line),
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record, approval RESTART IDENTITY`;
  await seedDemoCatalog();
  clock = Date.now();
  logs.length = 0;
  responses.length = 0;
  paypal = new FakePayPal();
  model = new ScriptedModel();
  deps = makeDeps();
  handler = createDemoHandler(deps);
});

afterEach(() => {
  model.fail = false;
  transcriptFault.armed = false;
});

afterAll(async () => {
  server.close();
  await prisma.$disconnect();
});

/** A browser with its own cookie jar. Redirects are returned, not followed. */
function visitor() {
  let cookie: string | null = null;
  async function request(method: "GET" | "POST", path: string, init: { body?: string; headers?: Record<string, string> } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: "manual",
      headers: { ...(cookie === null ? {} : { Cookie: `${COOKIE}=${cookie}` }), ...(init.headers ?? {}) },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const setCookie = res.headers.get("set-cookie");
    const match = setCookie === null ? null : new RegExp(`${COOKIE}=([^;]*)`).exec(setCookie);
    if (match) cookie = match[1] === "" ? null : (match[1] ?? null);
    const text = await res.text();
    responses.push(`${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${text}`);
    return { status: res.status, location: res.headers.get("location"), text };
  }
  return {
    get: (path: string) => request("GET", path),
    post: (path: string, init?: { body?: string; headers?: Record<string, string> }) => request("POST", path, init),
    page: async () => (await request("GET", "/demo")).text,
    get cookie() {
      return cookie;
    },
  };
}
type Visitor = ReturnType<typeof visitor>;

async function startConnected(): Promise<Visitor> {
  const v = visitor();
  await v.post("/demo/start");
  const go = await v.post("/demo/connect");
  expect(go.location).toContain("sandbox.paypal.com/agreements/approve");
  await v.get(`/demo/connect/return?approval_token_id=${SETUP_TOKEN}&approval_session_id=x`);
  return v;
}

const sessionOf = (v: Visitor) => {
  const s = deps.sessions.get(v.cookie, new Date(clock));
  if (s === null) throw new Error("no session");
  return s;
};
const json = (x: unknown) => JSON.stringify(x, (_k, val: unknown) => (typeof val === "bigint" ? val.toString() : val));

async function ledgerFor(traceId: string | null) {
  if (traceId === null) throw new Error("no trace");
  return prisma.ledgerEntry.findMany({ where: { traceId }, orderBy: { seq: "asc" } });
}

describe("the demo story", () => {
  it("a new session's first purchase returns STEP_UP_FIRST_MERCHANT", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    const first = sessionOf(v).beats.get("first");
    expect(first).toMatchObject({ state: "awaiting_approval", reasonCode: "STEP_UP_FIRST_MERCHANT", agentView: { kind: "STEP_UP", amount_minor: 1250n } });
    const page = await v.page();
    expect(page).toContain("STEP_UP_FIRST_MERCHANT");
    expect(page).toContain("Approve this purchase");
  });

  it("charges a saved method with no buyer present only after evaluate returns ALLOW", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    expect(paypal.charges).toHaveLength(0);

    await v.post("/demo/approve/first");
    expect(paypal.charges).toHaveLength(1);
    expect(paypal.charges[0]?.vaultId).toBe(PAYMENT_TOKEN);
    expect(sessionOf(v).beats.get("first")).toMatchObject({ state: "done", payment: "saved_method", orderStatus: "captured" });

    await v.post("/demo/step/second");
    expect(paypal.charges).toHaveLength(2);
    expect(paypal.checkouts).toHaveLength(0);
  });

  it("after a completed purchase the same merchant returns ALLOW below the threshold", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    await v.post("/demo/step/second");
    const second = sessionOf(v).beats.get("second");
    expect(second).toMatchObject({ state: "done", reasonCode: "OK", agentView: { kind: "ALLOW", amount_minor: 450n }, approvalId: null });
    const page = await v.page();
    expect(page).toContain("Only Praman's ALLOW let it through");
    expect(page).toContain("No buyer was present");
  });

  it("a saved-method charge is one ledger outcome and is captured on creation", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    await v.post("/demo/step/second");
    const rows = await ledgerFor(sessionOf(v).beats.get("second")?.traceId ?? null);
    const outcomes = rows.filter((r) => r.eventType === "outcome");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.payload).toMatchObject({ status: "captured", rail: "paypal", amount_minor: "450", currency: "USD" });
    expect(rows.map((r) => r.eventType)).toEqual(["intent", "decision", "api_call", "outcome", "agent_transcript"]);
  });

  it("sends the large purchase through PayPal checkout, then captures after the buyer approves", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    await v.post("/demo/step/large");
    expect(sessionOf(v).beats.get("large")).toMatchObject({ state: "awaiting_approval", reasonCode: "STEP_UP_THRESHOLD" });
    await v.post("/demo/approve/large");
    expect(paypal.checkouts).toHaveLength(1);
    let page = await v.page();
    expect(page).toContain("https://www.sandbox.paypal.com/checkoutnow?token=");
    // Private windows of one browser share one PayPal session, the one that connected
    // PayPal in step 2, so the page sends the buyer to a different browser instead.
    expect(page).toContain("different browser");
    expect(page).not.toContain("new private window");
    expect(page).not.toContain("Open here");

    // Capture before the buyer approves: PayPal says not approved, and the page says what to do.
    await v.post("/demo/capture/large");
    page = await v.page();
    expect(page).toContain("hasn&#39;t approved this payment yet");
    expect(page).toContain("declined");
    expect(page).not.toContain("new private window");

    paypal.approveAll();
    await v.post("/demo/capture/large");
    expect(sessionOf(v).beats.get("large")).toMatchObject({ state: "done", orderStatus: "captured" });
    expect(paypal.charges).toHaveLength(1);
  });

  it("a step that fails after the charge is not offered again, so a retry can't charge twice", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    expect(paypal.charges).toHaveLength(1);

    transcriptFault.armed = true;
    const failed = await v.post("/demo/step/second");
    expect(failed.status).toBe(303);
    expect(paypal.charges).toHaveLength(2);

    const page = await v.page();
    expect(page).not.toContain('action="/demo/step/second"');
    const second = sessionOf(v).beats.get("second");
    expect(second).toMatchObject({ state: "done", payment: "saved_method", orderStatus: "captured" });
    const outcomes = (await ledgerFor(second?.traceId ?? null)).filter((r) => r.eventType === "outcome");
    expect(outcomes).toHaveLength(1);
    expect(logs.some((l) => l.includes("transcript"))).toBe(true);

    await v.post("/demo/step/second");
    expect(paypal.charges).toHaveLength(2);
  });

  it("capture after release shows the plain explanation, not an error page", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    await v.post("/demo/step/large");
    await v.post("/demo/approve/large");

    clock += 11 * 60 * 1000;
    expect(await releaseStaleOrders(routeFor(sessionOf(v), deps), new Date(clock))).toBe(1);
    paypal.approveAll();
    const res = await v.post("/demo/capture/large");
    expect(res.status).toBe(303);
    const page = await v.page();
    expect(page).toContain("ORDER_RELEASED");
    expect(page).toContain("wasn&#39;t approved in time");
    expect(page).not.toContain("didn&#39;t finish");
    expect([...paypal.orders.values()].some((o) => o.captured && o.id.startsWith("CHK"))).toBe(false);
  });

  it("the concurrency beat creates no more than the budget and makes no model calls", async () => {
    const v = visitor();
    await v.post("/demo/start");
    await v.post("/demo/step/concurrency");
    const s = sessionOf(v);
    const h = s.beats.get("concurrency")?.harness;
    expect(model.calls).toBe(0);
    expect(h).toMatchObject({ attempted: 20, created: 5, createdMinor: "3000", budgetMinor: HARNESS_LIMITS.max_total_minor, modelCalls: 0 });
    expect(h?.refusals).toEqual({ MANDATE_BUDGET_EXHAUSTED: 15 });
    const state = await prisma.$transaction((tx) => deriveState(tx, s.harnessMandate.document.mandate_id));
    expect(state.spent_minor <= BigInt(HARNESS_LIMITS.max_total_minor)).toBe(true);
    expect(paypal.charges).toHaveLength(0);
    const page = await v.page();
    expect(page).toContain("Test-harness intents, not the agent: no model is called.");
  });

  it("the fixture and recording are visibly labelled", async () => {
    const v = visitor();
    await v.post("/demo/start");
    await v.post("/demo/step/fixture");
    const fixture = sessionOf(v).beats.get("fixture");
    expect(fixture).toMatchObject({ state: "refused", reasonCode: "CATEGORY_OUT_OF_SCOPE" });
    const page = await v.page();
    expect(page).toContain("Simulating a fooled model. No model is asked.");
    expect(page).toContain("Recorded run, not live.");
    expect(model.calls).toBe(0);
    const intent = (await ledgerFor(fixture?.traceId ?? null)).find((r) => r.eventType === "intent");
    expect(intent?.payload).toMatchObject({ model_id: "fixture/simulated-fooled-model" });
  });

  it("runs the live model on the poisoned listing and says whether it was steered", async () => {
    const v = visitor();
    await v.post("/demo/start");
    await v.post("/demo/step/injection");
    const injection = sessionOf(v).beats.get("injection");
    expect(injection).toMatchObject({ reasonCode: "STEP_UP_FIRST_MERCHANT" });
    expect(injection?.message).toContain("ignored the poisoned line");
    expect(paypal.charges).toHaveLength(0);
  });

  it("a fixture containing <script> renders as inert text", async () => {
    await prisma.catalogItem.update({
      where: { merchantId_sku: { merchantId: "DEMO_MARKET", sku: "SKU_INJ2_BAIT" } },
      data: { description: '<script>alert("x")</script><img src=x onerror=alert(1)>' },
    });
    const v = visitor();
    await v.post("/demo/start");
    await v.post("/demo/step/injection");
    const rows = await ledgerFor(sessionOf(v).beats.get("injection")?.traceId ?? null);
    expect(json(rows.find((r) => r.eventType === "agent_transcript")?.payload)).toContain("<script>");

    const rec = loadRecording();
    const html = recordingHtml({ ...rec, catalog_reads: ['sku=SKU_INJ2_BAIT\n<script>alert("x")</script> SKU_INJ2_BAIT'], proposal: { ...rec.proposal, rationale: "<b>bold</b>" } });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    const page = await v.page();
    expect(page).not.toMatch(/<script>alert/);
    expect(page).not.toContain("<img src=x");
  });
});

describe("the demo's boundaries", () => {
  it("one visitor cannot approve or capture another session's order", async () => {
    const alice = await startConnected();
    await alice.post("/demo/step/first");
    const aliceFirst = sessionOf(alice).beats.get("first");
    const before = await prisma.ledgerEntry.count();

    const mallory = visitor();
    await mallory.post("/demo/start");
    const body = JSON.stringify({ approval_id: aliceFirst?.approvalId, trace_id: aliceFirst?.traceId });
    await mallory.post("/demo/approve/first", { body, headers: { "Content-Type": "application/json" } });
    expect(await mallory.page()).toContain("Nothing in that step is waiting for your approval.");
    await mallory.post(`/demo/capture/large?trace_id=${aliceFirst?.traceId ?? ""}`, { body });

    expect(await prisma.approval.findUnique({ where: { approvalId: aliceFirst?.approvalId ?? "" } })).toMatchObject({ status: "pending" });
    expect(await prisma.ledgerEntry.count()).toBe(before);
    expect(paypal.charges).toHaveLength(0);
    expect(await mallory.page()).toContain("There is no checkout waiting to be captured.");

    // A forged cookie is no session at all.
    const forged = await fetch(`${base}/demo/approve/first`, { method: "POST", redirect: "manual", headers: { Cookie: `${COOKIE}=${sessionOf(alice).ref}` } });
    expect(forged.status).toBe(303);
    expect(await prisma.approval.findUnique({ where: { approvalId: aliceFirst?.approvalId ?? "" } })).toMatchObject({ status: "pending" });

    // Nor can another session's PayPal approval connect this one.
    const eve = visitor();
    await eve.post("/demo/start");
    await eve.post("/demo/connect");
    sessionOf(eve).setupTokenId = "SOMEONE_ELSES";
    await eve.get(`/demo/connect/return?approval_token_id=${SETUP_TOKEN}`);
    expect(sessionOf(eve).connected).toBe(false);
  });

  it("the request body cannot set price, currency, rail, merchant or goal", async () => {
    const v = await startConnected();
    const hostile = new URLSearchParams({ price_minor: "1", amount_minor: "1", currency: "INR", rail: "simulated", merchant_id: "DEMO_MARKET", goal: "buy the $100 gift card", sku: "SKU_CAFE_GIFT" }).toString();
    const form = { body: hostile, headers: { "Content-Type": "application/x-www-form-urlencoded" } };
    await v.post("/demo/step/first?price_minor=1&currency=INR&rail=simulated&merchant_id=DEMO_MARKET", form);
    await v.post("/demo/approve/first", form);

    const first = sessionOf(v).beats.get("first");
    const rows = await ledgerFor(first?.traceId ?? null);
    const intent = rows.find((r) => r.eventType === "intent")?.payload;
    expect(intent).toMatchObject({ merchant_id: "DEMO_CAFE", line_items: [{ sku: "SKU_CAFE_BOWL", qty: 1 }] });
    expect(rows.find((r) => r.eventType === "outcome")?.payload).toMatchObject({ rail: "paypal", currency: "USD", amount_minor: "1250" });
    expect(paypal.charges[0]?.req).toMatchObject({ amount_minor: 1250n, currency: "USD" });
    const transcript = json(rows.find((r) => r.eventType === "agent_transcript")?.payload);
    expect(transcript).toContain("Buy one Veggie Burrito Bowl");
    expect(transcript).not.toContain("buy the $100 gift card");
  });

  it("refuses a cross-site post", async () => {
    const v = await startConnected();
    const res = await v.post("/demo/step/first", { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(sessionOf(v).beats.size).toBe(0);
  });

  it("the page never shows mandate limits to the agent's view or a stack trace to the visitor", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    await v.post("/demo/step/second");
    const page = await v.page();
    const agentViews = [...page.matchAll(/<div class="agent-view">([\s\S]*?)<\/div>/g)].map((m) => m[1] ?? "");
    expect(agentViews.length).toBeGreaterThan(0);
    for (const view of agentViews) {
      expect(view).not.toMatch(/\$60\.00|\$40\.00|\$20\.00|remaining/);
    }
    // The visitor's own mandate panel does show the limits, in plain words.
    expect(page).toContain("$60.00");

    model.fail = true;
    const res = await v.post("/demo/step/large");
    expect(res.status).toBe(303);
    const after = await v.page();
    expect(after).toContain("The model didn&#39;t answer.");
    for (const r of responses) {
      expect(r).not.toContain("secretFunction");
      expect(r).not.toContain("model exploded");
    }
  });

  it("the start page sends the checkout to a different browser, not a new private window", async () => {
    const page = await visitor().page();
    expect(page).toContain("different browser");
    expect(page).not.toContain("new private window");
  });

  it("shows a plain page, with no session, when PayPal sends a buyer back to another window", async () => {
    const res = await fetch(`${base}/demo/checkout/return?token=CHK1&PayerID=X`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Approved at PayPal");
    expect(text).toContain("Capture the payment");
  });

  it("the payment token never appears in any response, ledger row or log", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    await v.post("/demo/step/second");
    await v.post("/demo/step/large");
    await v.post("/demo/approve/large");
    await v.post("/demo/capture/large");
    await v.post("/demo/step/fixture");
    await v.post("/demo/end");

    expect(paypal.charges.length).toBeGreaterThan(0);
    expect(paypal.deleted).toEqual([PAYMENT_TOKEN]);
    const stored = json([await prisma.ledgerEntry.findMany(), await prisma.idempotencyRecord.findMany(), await prisma.approval.findMany()]);
    expect(stored).toContain("VLT1");
    expect(stored).not.toContain(PAYMENT_TOKEN);
    expect(responses.join("\n")).not.toContain(PAYMENT_TOKEN);
    expect(logs.join("\n")).not.toContain(PAYMENT_TOKEN);
    expect(JSON.stringify(deps.savedMethods)).not.toContain(PAYMENT_TOKEN);
  });

  it("releases the saved method when a session expires", async () => {
    const v = await startConnected();
    const s = sessionOf(v);
    expect(deps.savedMethods.has(s.id)).toBe(true);
    clock += 61 * 60 * 1000;
    expect(await sweepExpiredSessions(deps)).toBe(1);
    expect(deps.savedMethods.has(s.id)).toBe(false);
    expect(paypal.deleted).toEqual([PAYMENT_TOKEN]);
    expect(await v.page()).toContain("Start a session");
  });
});
