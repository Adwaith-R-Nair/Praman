import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseStaleOrders } from "@praman/control-plane";
import { prisma } from "@praman/db";
import { deriveState } from "@praman/ledger";
import { generateKeypair } from "@praman/mandate";
import { HARNESS_LIMITS } from "../src/demo/config.js";
import { routeFor, type DemoDeps } from "../src/demo/connect.js";
import { createDemoHandler, releaseAllSessions, sweepExpiredSessions, COOKIE } from "../src/demo/routes.js";
import { seedDemoCatalog } from "../src/demo/seed.js";
import { createApp } from "../src/app.js";
import { MemoryDailyUsage } from "../src/demo/limits.js";
import { DemoActivity, scheduleSweeps } from "../src/sweeps.js";
import { routeByRail } from "@praman/exec-core";
import { SavedMethods, SessionStore } from "../src/demo/session.js";
import { loadRecording, recordingHtml } from "../src/pages/demo.js";
import { renderTracePage } from "../src/pages/trace.js";
import { readFileSync } from "node:fs";
import { CONTENT_SECURITY_POLICY } from "../src/csp.js";
import { VENDOR, vendorPath } from "../src/assets.js";
import { FakePayPal, PAYMENT_TOKEN, ScriptedModel, SETUP_TOKEN } from "./stand-ins.js";

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

/** Today's allowance. Generous by default; a test that needs the cap sets its own. */
let usage: MemoryDailyUsage;

function makeDeps(): DemoDeps {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  return {
    sessions: new SessionStore({ privateKeyPem, publicKeyPem, keyId: "test_demo_k1" }),
    savedMethods: new SavedMethods(),
    publicKeyPem,
    usage,
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
  usage = new MemoryDailyUsage({ session: 1000, model_call: 1000 });
  deps = makeDeps();
  handler = createDemoHandler(deps);
});

afterEach(() => {
  model.fail = false;
  model.override = null;
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

describe("the live model step on the poisoned listing", () => {
  it("says Praman would ask, not that it asked", async () => {
    const v = visitor();
    await v.post("/demo/start");
    await v.post("/demo/step/injection");
    const page = await v.page();
    expect(page).toContain("Would ask you first");
    expect(page).not.toContain("Asked you first");
  });
});

describe("after revoking, with no PayPal connected", () => {
  it("says the session is finished and offers a new one, and won't start a connection", async () => {
    const v = visitor();
    await v.post("/demo/start");
    await v.post("/demo/step/revoke");
    const page = await v.page();
    expect(page).not.toContain("Connect PayPal in step 2 first.");
    expect(page).not.toContain('action="/demo/connect"');
    expect(page).toContain("mandate is revoked");
    expect(page).toContain('action="/demo/start"');
    const go = await v.post("/demo/connect");
    expect(go.location).toBe("/demo#connect");
  });
});

describe("addresses that don't exist", () => {
  it("answers 404 under /demo with and without a session", async () => {
    expect((await visitor().get("/demo/nonexistent")).status).toBe(404);
    const v = visitor();
    await v.post("/demo/start");
    const page = await v.get("/demo/nonexistent");
    expect(page.status).toBe(404);
    expect(page.text).toContain("Not found");
  });

  it("still sends a visitor with no session from a real route to the start page", async () => {
    expect((await visitor().post("/demo/approve/first")).location).toBe("/demo");
    expect((await visitor().get("/demo/r/first")).location).toBe("/demo");
  });
});

describe("a session ended while PayPal answers the connect", () => {
  it("deletes the saved method at PayPal instead of leaving it", async () => {
    const v = visitor();
    await v.post("/demo/start");
    await v.post("/demo/connect");
    const original = paypal.createPaymentToken.bind(paypal);
    paypal.createPaymentToken = async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return original(id);
    };
    const returning = v.get(`/demo/connect/return?approval_token_id=${SETUP_TOKEN}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await v.post("/demo/end");
    await returning;
    expect(paypal.deleted).toEqual([PAYMENT_TOKEN]);
    await sweepExpiredSessions(deps);
    expect(deps.savedMethods.takeAll()).toEqual([]);
  });
});

describe("the fooled cart", () => {
  it("shows the items, their prices and the category refused, as the front page does", async () => {
    const v = visitor();
    await v.post("/demo/start");
    await v.post("/demo/step/fixture");
    const page = await v.page();
    expect(page).toContain("Masala Dosa");
    expect(page).toContain("$6.00");
    expect(page).toContain("Promo Card, a gift card");
    expect(page).toContain("$100.00");
    expect(page).toContain("A gift card is outside the categories");
  });
});

describe("a session lost to a restart", () => {
  async function restarted(): Promise<Visitor> {
    const v = await startConnected();
    await v.post("/demo/step/first");
    deps = makeDeps();
    handler = createDemoHandler(deps);
    return v;
  }

  it("tells the visitor plainly that the session ended and the button did nothing, once", async () => {
    const v = await restarted();
    const pressed = await v.post("/demo/approve/first");
    expect(pressed.location).toBe("/demo");
    const page = await v.page();
    expect(page).toContain("Your demo session has ended");
    expect(page).toContain("was not run");
    expect(paypal.charges).toHaveLength(0);
    expect(await v.page()).not.toContain("Your demo session has ended");
  });

  it("says nothing to a visitor who never had a session", async () => {
    expect(await visitor().page()).not.toContain("Your demo session has ended");
  });

  it("doesn't tell someone with no session that they can still capture", async () => {
    const text = (await visitor().get("/demo/checkout/return")).text;
    expect(text).toContain("If your demo session is still open");
    expect(text).toContain("can&#39;t be captured any more");
  });
});

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
    // Step 2 logged this window in to PayPal, and the sandbox declines a checkout in a
    // session that is already logged in (D-49). A private window starts a fresh session
    // unless the demo is itself in one, and then only another browser does.
    expect(page).toContain("a window that is not logged in to PayPal");
    expect(page).toContain("a private window if this demo is open in a normal one");
    expect(page).toContain("another browser if this demo is already in a private window");
    expect(page).not.toContain("new private window");
    expect(page).not.toContain("Open here");

    // Capture before the buyer approves: PayPal says not approved, and the page says what to do.
    await v.post("/demo/capture/large");
    page = await v.page();
    expect(page).toContain("hasn&#39;t approved this payment yet");
    expect(page).toContain("declined");
    expect(page).toContain("close every private window");
    expect(page).not.toContain("new private window");

    paypal.approveAll();
    await v.post("/demo/capture/large");
    expect(sessionOf(v).beats.get("large")).toMatchObject({ state: "done", orderStatus: "captured" });
    expect(paypal.charges).toHaveLength(1);
  });

  it("a first purchase that reaches the approval line becomes a checkout the visitor can capture", async () => {
    const v = await startConnected();
    // Two bowls, $25.00: at or over the $20.00 line, so PayPal's checkout instead of the saved account.
    model.override = { merchant_id: "DEMO_CAFE", line_items: [{ sku: "SKU_CAFE_BOWL", qty: 2 }], rationale: "one for later" };
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    model.override = null;
    expect(sessionOf(v).beats.get("first")).toMatchObject({ state: "awaiting_checkout", payment: "checkout", amountMinor: "2500" });
    let page = await v.page();
    expect(page).toContain("https://www.sandbox.paypal.com/checkoutnow?token=");
    expect(page).toContain('action="/demo/capture/first"');

    paypal.approveAll();
    await v.post("/demo/capture/first");
    expect(sessionOf(v).beats.get("first")).toMatchObject({ state: "done", orderStatus: "captured" });
    expect(paypal.charges).toHaveLength(0);

    // The story goes on from there.
    await v.post("/demo/step/second");
    expect(sessionOf(v).beats.get("second")).toMatchObject({ state: "done", payment: "saved_method" });
    page = await v.page();
    expect(page).toContain("Only Praman's ALLOW let it through");
  });

  it("a second purchase that needs approval can be approved and paid at PayPal", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    // Five coffees, $22.50.
    model.override = { merchant_id: "DEMO_CAFE", line_items: [{ sku: "SKU_CAFE_COFFEE", qty: 5 }], rationale: "coffee for everyone" };
    await v.post("/demo/step/second");
    model.override = null;
    expect(sessionOf(v).beats.get("second")).toMatchObject({ state: "awaiting_approval", reasonCode: "STEP_UP_THRESHOLD" });
    let page = await v.page();
    expect(page).toContain('action="/demo/approve/second"');

    await v.post("/demo/approve/second");
    expect(sessionOf(v).beats.get("second")).toMatchObject({ state: "awaiting_checkout" });
    paypal.approveAll();
    await v.post("/demo/capture/second");
    expect(sessionOf(v).beats.get("second")).toMatchObject({ state: "done", orderStatus: "captured" });
    page = await v.page();
    // A person approved this one, so the page must not say nobody did.
    expect(page).not.toContain("Only Praman's ALLOW let it through");
  });

  it("a purchase step that was refused can be asked again, so the story never gets stuck", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    await v.post("/demo/reject/first");
    expect(sessionOf(v).beats.get("first")).toMatchObject({ state: "refused" });
    let page = await v.page();
    expect(page).toContain('action="/demo/step/first"');

    await v.post("/demo/step/first");
    expect(sessionOf(v).beats.get("first")).toMatchObject({ state: "awaiting_approval" });
    await v.post("/demo/approve/first");
    expect(sessionOf(v).beats.get("first")).toMatchObject({ state: "done" });
    expect(paypal.charges).toHaveLength(1);
    page = await v.page();
    expect(page).not.toContain('action="/demo/step/first"');

    // A step that charged is never offered again.
    await v.post("/demo/step/first");
    expect(paypal.charges).toHaveLength(1);
  });

  it("every ask of a step gets its own intent and trace, even on recorded answers", async () => {
    // Two live calls: the first ask uses both, and every later ask replays a recording,
    // which uses no model call and adds no new step. The ids must still differ.
    usage = new MemoryDailyUsage({ session: 1000, model_call: 2 });
    deps = makeDeps();
    handler = createDemoHandler(deps);
    const v = await startConnected();
    const traces: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      await v.post("/demo/step/first");
      const asked = sessionOf(v).beats.get("first");
      expect(asked).toMatchObject({ state: "awaiting_approval" });
      traces.push(asked?.traceId ?? null);
      if (i < 2) await v.post("/demo/reject/first");
    }
    expect(new Set(traces).size).toBe(3);
    await v.post("/demo/approve/first");
    expect(sessionOf(v).beats.get("first")).toMatchObject({ state: "done" });

    // The charged trace holds one intent and the one approval that let it through.
    const rows = await ledgerFor(traces[2] ?? null);
    expect(rows.filter((r) => r.eventType === "intent")).toHaveLength(1);
    expect(rows.filter((r) => r.eventType === "step_up_resolved").map((r) => r.payload)).toEqual([expect.objectContaining({ verdict: "approve" })]);
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
    expect(page).toContain("approved by the test harness, not a person");
    // The arithmetic, in the order it happened, and the refusals in words with their code.
    expect(h).toMatchObject({ priorMinor: "500" });
    expect(page).toContain("$5.00 + $25.00 = $30.00");
    expect(page).toContain("15 refused: This is over the mandate&#39;s total budget.");
    expect(page).toContain("MANDATE_BUDGET_EXHAUSTED");
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
    // The recording is in rupees inside a dollar demo. The page says so before the listing, not after.
    const rupees = page.indexOf("In rupees, not US dollars.");
    expect(rupees).toBeGreaterThan(-1);
    expect(rupees).toBeLessThan(page.indexOf("price_paise=12000"));
    expect(page).toContain('price_paise=12000 means <span class="rupee">₹</span>120.00');
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
    // The hostile text reached the model, inside the wrapper with its brackets neutralised.
    const transcript = json(rows.find((r) => r.eventType === "agent_transcript")?.payload);
    expect(transcript).toContain("‹script›alert");
    expect(transcript).not.toContain("<script>");

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

describe("revoking the mandate", () => {
  const revocations = (mandateId: string) =>
    prisma.ledgerEntry.findMany({ where: { eventType: "mandate_revoked", payload: { path: ["mandate_id"], equals: mandateId } }, orderBy: { seq: "asc" } });

  it("the visitor revokes, the agent tries again, and gets DENY MANDATE_REVOKED with no charge", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    expect(paypal.charges).toHaveLength(1);
    const mandateId = sessionOf(v).mandate.document.mandate_id;

    await v.post("/demo/step/revoke");
    const rows = await revocations(mandateId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "issuer", payload: { mandate_id: mandateId } });
    expect(sessionOf(v).beats.get("revoke")).toMatchObject({ state: "done", traceId: rows[0]?.traceId });
    expect(rows[0]?.traceId.startsWith(`trc_demo_${sessionOf(v).ref}`)).toBe(true);

    const callsBefore = model.calls;
    await v.post("/demo/step/after_revoke");
    expect(model.calls).toBeGreaterThan(callsBefore);
    const retry = sessionOf(v).beats.get("after_revoke");
    expect(retry).toMatchObject({ state: "refused", reasonCode: "MANDATE_REVOKED", agentView: { kind: "DENY", reason_code: "MANDATE_REVOKED" }, orderId: null });
    expect(paypal.charges).toHaveLength(1);
    expect(paypal.checkouts).toHaveLength(0);
    const retryRows = await ledgerFor(retry?.traceId ?? null);
    expect(retryRows.map((r) => r.eventType)).not.toContain("api_call");
    expect(retryRows.map((r) => r.eventType)).not.toContain("outcome");

    const page = await v.page();
    expect(page).toContain("MANDATE_REVOKED");
    expect(page).toContain("This mandate has been revoked.");
    expect(page).toContain("Nothing charged.");
    expect(page).toContain(`/r/${encodeURIComponent(rows[0]?.traceId ?? "")}`);
    expect(page).toContain('href="/demo/console"');
    expect(page).toContain(`/demo/console#trace=${encodeURIComponent(rows[0]?.traceId ?? "")}`);
  });

  it("revokes once, however many times it is pressed", async () => {
    const v = visitor();
    await v.post("/demo/start");
    await v.post("/demo/step/revoke");
    await v.post("/demo/step/revoke");
    expect(await revocations(sessionOf(v).mandate.document.mandate_id)).toHaveLength(1);
  });

  it("the agent's retry waits until the mandate is revoked", async () => {
    const v = visitor();
    await v.post("/demo/start");
    await v.post("/demo/step/after_revoke");
    expect(sessionOf(v).beats.get("after_revoke")).toBeUndefined();
    expect(model.calls).toBe(0);
    expect(await v.page()).toContain("Revoke the mandate first");
  });

  it("revokes only the visitor's own mandate", async () => {
    const a = visitor();
    const b = visitor();
    await a.post("/demo/start");
    await b.post("/demo/start");
    await a.post("/demo/step/revoke");
    expect(await revocations(sessionOf(a).mandate.document.mandate_id)).toHaveLength(1);
    expect(await revocations(sessionOf(b).mandate.document.mandate_id)).toHaveLength(0);
    expect(await prisma.$transaction((tx) => deriveState(tx, sessionOf(b).mandate.document.mandate_id))).toMatchObject({ revoked: false });
  });

  it("a checkout waiting at PayPal is refused at capture once the mandate is revoked", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    await v.post("/demo/step/large");
    await v.post("/demo/approve/large");
    expect(sessionOf(v).beats.get("large")).toMatchObject({ state: "awaiting_checkout" });

    await v.post("/demo/step/revoke");
    paypal.approveAll();
    await v.post("/demo/capture/large");
    expect(sessionOf(v).beats.get("large")).toMatchObject({ state: "refused", reasonCode: "MANDATE_REVOKED" });
    expect([...paypal.orders.values()].some((o) => o.captured && o.id.startsWith("CHK"))).toBe(false);
  });
});

describe("refunding a purchase from its trace page (D-66, D-67)", () => {
  const refundRows = (traceId: string) =>
    prisma.ledgerEntry.findMany({ where: { traceId, eventType: { in: ["refund_requested", "refund_outcome"] } }, orderBy: { seq: "asc" } });

  async function paidSecond(): Promise<Visitor> {
    const v = await startConnected();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    await v.post("/demo/step/second");
    expect(sessionOf(v).beats.get("second")).toMatchObject({ state: "done", payment: "saved_method" });
    return v;
  }

  it("the visitor refunds a paid purchase from its trace page, once, and the budget still counts it", async () => {
    const v = await paidSecond();
    const second = sessionOf(v).beats.get("second");
    const traceId = second?.traceId ?? "";
    const mandateId = sessionOf(v).mandate.document.mandate_id;

    // The demo page sends the visitor to their own view of the trace, by step, not by trace id.
    expect(await v.page()).toContain('href="/demo/r/second"');
    const before = await v.get("/demo/r/second");
    expect(before.status).toBe(200);
    expect(before.text).toContain(traceId);
    expect(before.text).toContain('action="/demo/refund/second"');
    expect(before.text).toContain("Refund $4.50");
    expect(before.text).toContain("the agent has no way to ask for one");

    const spentBefore = (await prisma.$transaction((tx) => deriveState(tx, mandateId))).spent_minor;
    const res = await v.post("/demo/refund/second");
    expect(res.status).toBe(303);
    expect(res.location).toBe("/demo/r/second#refund");
    expect(paypal.refunds).toEqual([expect.objectContaining({ payment_id: "CAP_VLT2", amount_minor: 450n, currency: "USD" })]);

    const after = await v.get("/demo/r/second");
    expect(after.text).toContain("Refunded in full. $4.50 went back to the buyer.");
    expect(after.text).toContain("Asked for by the demo visitor, on this trace page");
    expect(after.text).not.toContain('action="/demo/refund/second"');
    const rows = await refundRows(traceId);
    expect(rows.map((r) => [r.eventType, r.actor])).toEqual([
      ["refund_requested", "demo_visitor"],
      ["refund_outcome", "praman"],
    ]);
    expect((await prisma.$transaction((tx) => deriveState(tx, mandateId))).spent_minor).toBe(spentBefore);
    expect(await v.page()).toContain("Refunded to the buyer");

    // Pressed again: answered from the ledger, nothing sent, nothing written.
    await v.post("/demo/refund/second");
    expect(paypal.refunds).toHaveLength(1);
    expect(await refundRows(traceId)).toHaveLength(2);
  });

  it("refunds a purchase the buyer paid at PayPal's checkout", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    await v.post("/demo/step/large");
    await v.post("/demo/approve/large");
    paypal.approveAll();
    await v.post("/demo/capture/large");
    expect(sessionOf(v).beats.get("large")).toMatchObject({ state: "done", payment: "checkout" });

    await v.post("/demo/refund/large");
    expect(paypal.refunds).toEqual([expect.objectContaining({ amount_minor: 3200n })]);
    expect((await v.get("/demo/r/large")).text).toContain("Refunded in full. $32.00 went back to the buyer.");
  });

  it("has nothing to refund on a step that hasn't paid", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    expect(sessionOf(v).beats.get("first")).toMatchObject({ state: "awaiting_approval" });

    expect((await v.get("/demo/r/first")).text).not.toContain('action="/demo/refund/first"');
    await v.post("/demo/refund/first");
    await v.post("/demo/refund/large");
    expect(paypal.refunds).toHaveLength(0);
    expect(await v.page()).toContain("There is no paid purchase in that step to refund.");
    // A step that never ran has no trace to show.
    expect((await v.get("/demo/r/large")).location).toBe("/demo");
  });

  it("one visitor cannot see the refund button on, or refund, another session's purchase", async () => {
    const a = await paidSecond();
    const traceId = sessionOf(a).beats.get("second")?.traceId ?? "";
    const b = visitor();
    await b.post("/demo/start");

    expect((await b.get("/demo/r/second")).location).toBe("/demo");
    await b.post("/demo/refund/second", { body: JSON.stringify({ trace_id: traceId, step: "second" }), headers: { "Content-Type": "application/json" } });
    await b.post(`/demo/refund/second?trace=${encodeURIComponent(traceId)}`);
    expect(paypal.refunds).toHaveLength(0);
    expect(await refundRows(traceId)).toHaveLength(0);
  });

  it("the public trace page shows the refund and never offers one", async () => {
    const v = await paidSecond();
    const traceId = sessionOf(v).beats.get("second")?.traceId ?? "";
    expect((await renderTracePage(traceId)).html).not.toContain("/demo/refund/");
    await v.post("/demo/refund/second");
    const { html } = await renderTracePage(traceId);
    expect(html).toContain("Refunded in full. $4.50 went back to the buyer.");
    expect(html).not.toContain("/demo/refund/");
  });

  it("still refunds after the visitor has revoked the mandate", async () => {
    const v = await paidSecond();
    await v.post("/demo/step/revoke");
    await v.post("/demo/refund/second");
    expect(paypal.refunds).toHaveLength(1);
    expect((await v.get("/demo/r/second")).text).toContain("Refunded in full.");
  });

  it("a refund with no answer from PayPal says so in plain words and isn't sent twice", async () => {
    const v = await paidSecond();
    paypal.failNextRefund = true;
    const res = await v.post("/demo/refund/second");
    expect(res.status).toBe(303);
    const page = await v.get("/demo/r/second");
    expect(page.text).toContain("has no answer yet");
    expect(page.text).not.toContain("ETIMEDOUT");
    expect(page.text).not.toContain('action="/demo/refund/second"');
    await v.post("/demo/refund/second");
    expect(paypal.refunds).toHaveLength(1);
  });
});

describe("the ledger console", () => {
  const getRaw = (path: string, cookie: string | null = null) => fetch(`${base}${path}`, { redirect: "manual", headers: cookie === null ? {} : { Cookie: `${COOKIE}=${cookie}` } });
  /** The app around the demo, as server.ts builds it, with or without the operator console. */
  function appServer(operatorConsole: boolean) {
    handler = createApp({
      demo: createDemoHandler(deps),
      webhooks: { webhookId: null, verify: async () => false, apply: async () => "unmatched", now: () => new Date(clock) },
      hsts: false,
      proxyHops: 0,
      onDemoRequest: () => {},
      log: (line) => logs.push(line),
      operatorConsole,
    });
  }
  const consoleData = async (cookie: string | null) => {
    const res = await getRaw("/demo/console/data", cookie);
    return { status: res.status, body: (await res.json()) as { rows: { traceId: string; mandateId: string | null; eventType: string; hashVerdict: string; chainVerified: boolean; decision: string | null }[]; chain: { ok: boolean }; spend: { mandateId: string; budgetMinor: string | null; spentNowMinor: string; revoked: boolean }[] } };
  };

  it("serves the page under a policy whose only change is a fresh style nonce, and no ledger data in the HTML", async () => {
    appServer(false);
    const v = visitor();
    await v.post("/demo/start");
    await v.post("/demo/step/concurrency");
    const first = await getRaw("/demo/console", v.cookie);
    const second = await getRaw("/demo/console", v.cookie);
    const html = await first.text();
    const policy = first.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1] ?? "";
    expect(nonce.length).toBeGreaterThanOrEqual(24);
    expect(policy).toBe(CONTENT_SECURITY_POLICY.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`));
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
    expect(second.headers.get("content-security-policy")).not.toBe(policy);
    expect(html).toContain(`<script src="/assets/console.js" nonce="${nonce}" defer></script>`);
    expect(html).toContain(`src="${vendorPath(VENDOR.grid)}"`);
    expect(html).toContain(`src="${vendorPath(VENDOR.charts)}"`);
    expect(html).not.toMatch(/<script>|<style>| style="/);
    expect(html).not.toContain("https://cdn");
    expect(html).not.toContain(sessionOf(v).ref);
    expect(html).not.toContain(v.cookie ?? "no cookie");
  });

  it("shows a visitor only their own session's mandates, and the revocation in the chain", async () => {
    appServer(false);
    const a = visitor();
    const b = visitor();
    await a.post("/demo/start");
    await b.post("/demo/start");
    await a.post("/demo/step/concurrency");
    await a.post("/demo/step/revoke");
    await b.post("/demo/step/fixture");

    const mine = await consoleData(a.cookie);
    expect(mine.status).toBe(200);
    const s = sessionOf(a);
    const ids = new Set([s.mandate.document.mandate_id, s.harnessMandate.document.mandate_id]);
    expect(mine.body.rows.length).toBeGreaterThan(40);
    expect(mine.body.rows.every((r) => r.mandateId !== null && ids.has(r.mandateId))).toBe(true);
    expect(mine.body.rows.every((r) => r.hashVerdict === "intact" && r.chainVerified)).toBe(true);
    expect(mine.body.chain.ok).toBe(true);
    expect(mine.body.rows.find((r) => r.eventType === "mandate_revoked")).toMatchObject({ decision: "REVOKED", traceId: `trc_demo_${s.ref}_revoke` });
    expect(mine.body.spend.find((x) => x.mandateId === s.harnessMandate.document.mandate_id)).toMatchObject({ budgetMinor: HARNESS_LIMITS.max_total_minor, spentNowMinor: "3000", revoked: false });
    expect(mine.body.spend.find((x) => x.mandateId === s.mandate.document.mandate_id)).toMatchObject({ revoked: true });
    expect(JSON.stringify(mine.body)).not.toContain(sessionOf(b).ref);

    const theirs = await consoleData(b.cookie);
    expect(theirs.body.rows.every((r) => !JSON.stringify(r).includes(s.ref))).toBe(true);
    expect(theirs.body.rows.some((r) => r.traceId === `trc_demo_${sessionOf(b).ref}_fixture`)).toBe(true);
  });

  it("gives no rows without a session, and limits how often one session can load them", async () => {
    appServer(false);
    expect((await getRaw("/demo/console/data")).status).toBe(401);
    expect((await getRaw("/demo/console", null)).status).toBe(200);
    const v = visitor();
    await v.post("/demo/start");
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await getRaw("/demo/console/data", v.cookie)).status);
    expect(statuses.filter((x) => x === 200).length).toBe(30);
    expect(statuses.at(-1)).toBe(429);
  });

  it("keeps the whole-ledger console off unless the server turns it on", async () => {
    appServer(false);
    const v = visitor();
    await v.post("/demo/start");
    await v.post("/demo/step/fixture");
    const off = await getRaw("/console");
    expect(off.status).toBe(404);
    expect(await off.text()).toContain("Each demo visitor has their own console at /demo/console");
    expect((await getRaw("/console/data")).status).toBe(404);

    appServer(true);
    const page = await getRaw("/console");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/style-src 'self' 'nonce-[^']+' https/);
    const data = (await (await getRaw("/console/data")).json()) as { rows: { traceId: string }[] };
    expect(data.rows.some((r) => r.traceId === `trc_demo_${sessionOf(v).ref}_fixture`)).toBe(true);
  });

  it("serves AG Grid and AG Charts Community from node_modules at the pinned versions", async () => {
    appServer(false);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["ag-grid-community"]).toBe(VENDOR.grid.version);
    expect(pkg.dependencies["ag-charts-community"]).toBe(VENDOR.charts.version);
    expect(Object.keys(pkg.dependencies).filter((d) => d.includes("enterprise"))).toEqual([]);
    for (const v of [VENDOR.grid, VENDOR.charts]) {
      const res = await getRaw(vendorPath(v));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      expect((await res.text()).length).toBeGreaterThan(500_000);
    }
  });

  it("the console script builds every value as text, never as HTML", () => {
    const client = readFileSync(new URL("../src/console/console.client.js", import.meta.url), "utf8");
    expect(client).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    // AG Grid inserts a string a cell renderer returns as HTML, so the only renderer returns an element.
    expect(client.match(/cellRenderer:/g)).toHaveLength(1);
    expect(client).toContain("cellRenderer: traceLink");
    expect(client).toMatch(/function traceLink[\s\S]*?document\.createElement\("a"\)[\s\S]*?textContent/);
    expect(client).toContain("styleNonce: nonce");
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

  it("a step buys only at its own shop, whatever shop the model's cart names", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    const before = await prisma.ledgerEntry.count();

    // Step 4 is the cafe's. A cart naming the market, which the mandate also allows, is not sent.
    model.override = { merchant_id: "DEMO_MARKET", line_items: [{ sku: "SKU_INJ2_DOSA", qty: 1 }], rationale: "the market is nicer" };
    await v.post("/demo/step/second");
    const second = sessionOf(v).beats.get("second");
    expect(second).toMatchObject({ state: "refused", traceId: null, orderId: null, payment: null });
    expect(second?.message).toContain("Nothing was charged");
    expect(paypal.charges).toHaveLength(1);
    expect(await prisma.ledgerEntry.count()).toBe(before);
    const page = await v.page();
    expect(page).toContain("Not sent");
    expect(page).toContain("Corner Market");
  });

  it("an unusable cart from the model ends the step with a plain refusal and no charge", async () => {
    const v = await startConnected();
    const before = await prisma.ledgerEntry.count();
    for (const lineItems of ["two bowls", [], [{ sku: "SKU_CAFE_BOWL", qty: 1.5 }], [{ sku: "SKU_CAFE_BOWL", qty: -1 }], [{ qty: 1 }], [null]]) {
      sessionOf(v).beats.delete("first");
      model.override = { merchant_id: "DEMO_CAFE", line_items: lineItems, rationale: "odd" };
      const res = await v.post("/demo/step/first");
      expect(res.status).toBe(303);
      expect(sessionOf(v).beats.get("first")).toMatchObject({ state: "refused", traceId: null, approvalId: null });
    }
    expect(await prisma.ledgerEntry.count()).toBe(before);
    expect(paypal.charges).toHaveLength(0);
    expect(paypal.checkouts).toHaveLength(0);
    expect(await v.page()).not.toContain("didn&#39;t finish");
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

  it("every disabled button says why it is disabled", async () => {
    const check = (page: string) => {
      const disabled = [...page.matchAll(/<button[^>]*\sdisabled[^>]*aria-describedby="([^"]+)"/g)].map((m) => m[1] ?? "");
      expect(page.match(/<button[^>]*\sdisabled/g)?.length ?? 0).toBe(disabled.length);
      for (const id of disabled) expect(page).toMatch(new RegExp(`<p class="why" id="${id}">[^<]+</p>`));
      return disabled.length;
    };
    const v = visitor();
    await v.post("/demo/start");
    const before = await v.page();
    // First purchase, second, large, and the agent's retry after revoking.
    expect(check(before)).toBe(4);
    expect(before).toContain("Connect PayPal in step 2 first.");
    expect(before).toContain("Finish the first purchase first.");
    expect(before).toContain("Revoke the mandate first.");

    await v.post("/demo/connect");
    await v.get(`/demo/connect/return?approval_token_id=${SETUP_TOKEN}`);
    expect(check(await v.page())).toBe(3);
  });

  it("the start page sends the checkout to a window that is not logged in to PayPal", async () => {
    const page = await visitor().page();
    expect(page).toContain("a window that is not logged in to PayPal");
    expect(page).toContain("a private window if you opened this demo in a normal one");
    expect(page).toContain("otherwise another browser");
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

  it("on shutdown, deletes every saved method at PayPal and ends every session", async () => {
    const a = await startConnected();
    const b = await startConnected();
    const sa = sessionOf(a);
    const sb = sessionOf(b);
    const result = await releaseAllSessions(deps, 2000);
    expect(result).toEqual({ sessions: 2, deleted: 2, notDeleted: 0 });
    expect(paypal.deleted).toEqual([PAYMENT_TOKEN, PAYMENT_TOKEN]);
    expect(deps.savedMethods.has(sa.id)).toBe(false);
    expect(deps.savedMethods.has(sb.id)).toBe(false);
    expect(deps.sessions.size).toBe(0);
    expect(logs.join("\n")).not.toContain(PAYMENT_TOKEN);
  });

  it("on shutdown, gives up waiting for PayPal after the time allowed", async () => {
    await startConnected();
    paypal.deletePaymentToken = () => new Promise(() => {});
    const started = Date.now();
    const result = await releaseAllSessions(deps, 50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toEqual({ sessions: 1, deleted: 0, notDeleted: 1 });
    expect(deps.savedMethods.toJSON()).toBe("[saved payment methods]");
    expect(logs.join("\n")).not.toContain(PAYMENT_TOKEN);
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

describe("the demo under a content security policy", () => {
  it("the start page, the story page and the error pages carry no inline script or style", async () => {
    const inline = (html: string) => [
      ...[...html.matchAll(/<script\b([^>]*)>/gi)].filter((m) => !/\bsrc=/.test(m[1] ?? "")).map((m) => m[0]),
      ...[...html.matchAll(/<style\b[^>]*>|<[^>]+\s(?:style|on[a-z]+)\s*=/gi)].map((m) => m[0]),
    ];
    const v = await startConnected();
    await v.post("/demo/step/first");
    const pages = [await v.page(), (await visitor().get("/demo")).text, (await visitor().get("/demo/checkout/return")).text];
    for (const html of pages) {
      expect(inline(html)).toEqual([]);
      expect(html).toContain('<link rel="stylesheet" href="/demo/demo.css">');
    }
    const css = await visitor().get("/demo/demo.css");
    expect(css.status).toBe(200);
    expect(css.text).toContain(".demo");
  });
});

describe("the sweeps, through the running server", () => {
  /** The server as server.ts builds it: the app around the demo, telling the sweeps when the demo is used. */
  function hostedServer(activity = new DemoActivity()) {
    handler = createApp({
      demo: createDemoHandler(deps),
      webhooks: { webhookId: null, verify: async () => false, apply: async () => "unmatched", now: () => new Date(clock) },
      hsts: false,
      proxyHops: 0,
      onDemoRequest: () => activity.touch(new Date(clock)),
      log: (line) => logs.push(line),
    });
    // The same rails server.ts gives the sweeps: PayPal, and no simulator.
    return scheduleSweeps({ route: routeByRail([paypal]), now: () => new Date(clock), log: (line) => logs.push(line), activity, intervalMs: 20 });
  }
  async function waitFor(check: () => Promise<boolean>, ms = 5_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }
  const outcomeStatuses = async (traceId: string | null) => (await ledgerFor(traceId)).filter((r) => r.eventType === "outcome").map((r) => (r.payload as { status?: string }).status);

  it("an unpaid checkout is released after 10 minutes, and capturing it then is refused in plain words", async () => {
    const sweeps = hostedServer();
    try {
      const v = await startConnected();
      await v.post("/demo/step/first");
      await v.post("/demo/approve/first");
      await v.post("/demo/step/large");
      await v.post("/demo/approve/large");
      const large = sessionOf(v).beats.get("large");
      expect(large).toMatchObject({ state: "awaiting_checkout" });

      // Nine minutes: the sweeps run, and the order is still held.
      clock += 9 * 60 * 1000;
      await new Promise((r) => setTimeout(r, 100));
      expect(await outcomeStatuses(large?.traceId ?? null)).toEqual(["created"]);

      clock += 2 * 60 * 1000;
      expect(await waitFor(async () => (await outcomeStatuses(large?.traceId ?? null)).includes("released"))).toBe(true);

      paypal.approveAll();
      await v.post("/demo/capture/large");
      const page = await v.page();
      expect(page).toContain("ORDER_RELEASED");
      expect(page).toContain("wasn&#39;t approved in time");
      expect([...paypal.orders.values()].some((o) => o.captured && o.id.startsWith("CHK"))).toBe(false);
    } finally {
      await sweeps.stop();
    }
  });

  it("a payment call left with no answer is settled by the sweep, and not charged again", async () => {
    const sweeps = hostedServer();
    try {
      const v = await startConnected();
      await v.post("/demo/step/first");
      await v.post("/demo/approve/first");
      paypal.failNextCharge = true;
      await v.post("/demo/step/second");
      const second = sessionOf(v).beats.get("second");
      expect(second?.state).toBe("pending");
      const key = (await prisma.idempotencyRecord.findFirst({ where: { traceId: second?.traceId ?? "" } }))?.key ?? "";
      expect((await prisma.idempotencyRecord.findUnique({ where: { key } }))?.status).toBe("pending");

      // A minute later the record is old enough for the reconciler, which asks PayPal and records the answer.
      clock += 2 * 60 * 1000;
      await v.page();
      expect(await waitFor(async () => (await prisma.idempotencyRecord.findUnique({ where: { key } }))?.status !== "pending")).toBe(true);
      const statuses = await outcomeStatuses(second?.traceId ?? null);
      expect(statuses).toHaveLength(1);
      const reconciled = (await ledgerFor(second?.traceId ?? null)).filter((r) => r.eventType === "outcome")[0];
      expect(reconciled?.actor).toBe("reconciler");
      // The saved account was charged once, by the call that lost its answer. The sweep never charges.
      expect(paypal.charges).toHaveLength(2);
    } finally {
      await sweeps.stop();
    }
  });

  it("does nothing while nobody has used the demo for 30 minutes", async () => {
    const activity = new DemoActivity();
    let sweeps = hostedServer(activity);
    try {
      const v = await startConnected();
      await v.post("/demo/step/first");
      await v.post("/demo/approve/first");
      await v.post("/demo/step/large");
      await v.post("/demo/approve/large");
      const large = sessionOf(v).beats.get("large");
      // A pass that began while the demo was in use may still be running. Moving the clock
      // under it would let it release at the new time, which no real clock can do. So the
      // schedule is stopped once that pass ends, the clock moves, and the same server
      // starts its schedule again, with the last use 31 minutes ago.
      await sweeps.stop();
      clock += 31 * 60 * 1000;
      sweeps = hostedServer(activity);
      await new Promise((r) => setTimeout(r, 120));
      expect(await outcomeStatuses(large?.traceId ?? null)).toEqual(["created"]);
      // The next visit wakes them, and the overdue order is released.
      await visitor().get("/demo");
      expect(await waitFor(async () => (await outcomeStatuses(large?.traceId ?? null)).includes("released"))).toBe(true);
    } finally {
      await sweeps.stop();
    }
  });
});

describe("the demo at its limits, and when what it depends on fails", () => {
  it("after the daily model cap the story serves a labelled recording", async () => {
    usage = new MemoryDailyUsage({ session: 1000, model_call: 2 });
    deps = makeDeps();
    handler = createDemoHandler(deps);
    const v = await startConnected();
    // The first step uses today's two live calls: one to read the catalog, one to propose.
    await v.post("/demo/step/first");
    expect(model.calls).toBe(2);
    expect(sessionOf(v).beats.get("first")?.recordedModel).toBeNull();
    await v.post("/demo/approve/first");

    // Now the cap is reached. The step goes on with the live model's recorded answer, labelled.
    await v.post("/demo/step/second");
    expect(model.calls).toBe(2);
    const second = sessionOf(v).beats.get("second");
    expect(second).toMatchObject({ state: "done", payment: "saved_method", recordedModel: { model: "google/gemini-3.1-flash-lite" } });
    expect(second?.proposal?.lineItems).toEqual([{ sku: "SKU_CAFE_COFFEE", qty: 1 }]);
    const page = await v.page();
    expect(page).toContain("Recorded model answer, not live.");
    expect(page).toContain("google/gemini-3.1-flash-lite");

    // The ledger says so too, and Praman still priced and decided it.
    const rows = await ledgerFor(second?.traceId ?? null);
    expect(rows.find((r) => r.eventType === "intent")?.payload).toMatchObject({ model_id: "recorded/google/gemini-3.1-flash-lite" });
    expect(rows.find((r) => r.eventType === "decision")?.payload).toMatchObject({ kind: "ALLOW", amount_minor: "450" });
    const { renderTracePage } = await import("../src/pages/trace.js");
    expect((await renderTracePage(second?.traceId ?? "")).html).toContain("Recorded model answer, not live.");
  });

  it("past the daily session cap, a visitor gets the labelled recorded run and nothing starts", async () => {
    usage = new MemoryDailyUsage({ session: 1, model_call: 1000 });
    deps = makeDeps();
    handler = createDemoHandler(deps);
    expect((await visitor().post("/demo/start")).status).toBe(303);
    const late = visitor();
    const res = await late.post("/demo/start");
    expect(res.status).toBe(303);
    expect(res.location).toBe("/demo/recorded?reason=sessions");
    expect(late.cookie).toBeNull();
    expect(deps.sessions.size).toBe(1);

    // The recorded run: labelled as one, the whole story in a screenshot, and when it opens again.
    const page = await late.get("/demo/recorded?reason=sessions");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Recorded run, not live.");
    expect(page.text).toContain("opens again at 00:00 UTC");
    expect(page.text).toContain('<img src="/demo/recorded-run.png"');
    expect(page.text).toMatch(/alt="[^"]{40,}"/);
    expect(page.text).not.toMatch(/<form[^>]*action="\/demo\/start"/);
    expect(late.cookie).toBeNull();
    const shot = await fetch(`${base}/demo/recorded-run.png`);
    expect(shot.status).toBe(200);
    expect(shot.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await shot.arrayBuffer()).subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(deps.sessions.size).toBe(1);
  });

  it("a session over its rate limit gets a plain 429 page", async () => {
    const v = visitor();
    await v.post("/demo/start");
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await v.post("/demo/step/fixture")).status);
    expect(statuses.slice(0, 30).every((s) => s === 303)).toBe(true);
    const over = await v.post("/demo/step/fixture");
    expect(over.status).toBe(429);
    expect(over.text).toContain("Too many presses");
    expect(over.text).not.toContain("<");
    // The fixture ran once, whatever was pressed.
    expect((await ledgerFor(sessionOf(v).beats.get("fixture")?.traceId ?? null)).filter((r) => r.eventType === "intent")).toHaveLength(1);
    // Another visitor is unaffected.
    const other = visitor();
    await other.post("/demo/start");
    expect((await other.post("/demo/step/fixture")).status).toBe(303);
  });

  it("paypal being unreachable leaves records pending and shows a plain message", async () => {
    const v = await startConnected();
    await v.post("/demo/step/first");
    paypal.failNextCharge = true;
    const res = await v.post("/demo/approve/first");
    expect(res.status).toBe(303);
    const first = sessionOf(v).beats.get("first");
    expect(first?.state).toBe("pending");
    const records = await prisma.idempotencyRecord.findMany({ where: { traceId: first?.traceId ?? "" } });
    expect(records.map((r) => r.status)).toEqual(["pending"]);
    expect((await ledgerFor(first?.traceId ?? null)).filter((r) => r.eventType === "outcome")).toHaveLength(0);
    const page = await v.page();
    expect(page).toContain("The payment call has no answer yet");
    expect(page).not.toContain("ETIMEDOUT");
    expect(page).not.toMatch(/at \S+ \(/);
    // It isn't offered again, so a press can't make a second charge.
    expect(page).not.toContain('action="/demo/approve/first"');
  });

  it("the model provider failing shows a plain message and moves no money", async () => {
    const v = await startConnected();
    model.fail = true;
    await v.post("/demo/step/first");
    expect(sessionOf(v).beats.get("first")).toMatchObject({ state: "no_proposal", traceId: null });
    const page = await v.page();
    expect(page).toContain("The model didn&#39;t answer. Nothing was proposed and no money moved.");
    expect(page).not.toContain("secretFunction");
    expect(page).not.toContain("exploded");
    expect(paypal.charges).toHaveLength(0);
    expect(paypal.checkouts).toHaveLength(0);
    expect(await prisma.ledgerEntry.count()).toBe(0);
  });
});
