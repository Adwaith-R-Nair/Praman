import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import type { CreateOrderRequest, ExecOutcome } from "@praman/exec-core";
import { verifyChain } from "@praman/ledger";
import { generateKeypair } from "@praman/mandate";
import { minor } from "@praman/shared";
import { savedMethodChoice, type DemoDeps } from "../src/demo/connect.js";
import { HOUSE_REST_MS, HouseBuyer, houseChoiceHtml } from "../src/demo/house.js";
import { LIMITS, MemoryDailyUsage } from "../src/demo/limits.js";
import { COOKIE, createDemoHandler, releaseAllSessions, sweepExpiredSessions } from "../src/demo/routes.js";
import { seedDemoCatalog } from "../src/demo/seed.js";
import { createDemoSession, SavedMethods, SessionStore } from "../src/demo/session.js";
import { FakePayPal, PAYMENT_TOKEN, ScriptedModel, SETUP_TOKEN } from "./stand-ins.js";

// The demo's shared sandbox buyer (D-85), against the test database. The model is scripted
// and PayPal is the stand-in the other demo tests use. No network, and no real sandbox.

const HOUSE_TOKEN = "HOUSETOKEN-4c1d-NEVER-SHOWN";
const HOUSE_PATH = "/demo/connect/house";

let server: Server;
let handler: ReturnType<typeof createDemoHandler> = async () => {};
let base: string;
let deps: DemoDeps;
let paypal: FakePayPal;
let clock: number;
const logs: string[] = [];
const responses: string[] = [];

function makeDeps(house: HouseBuyer | null, houseSessions = 1000): DemoDeps {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  return {
    sessions: new SessionStore({ privateKeyPem, publicKeyPem, keyId: "test_demo_k1" }),
    savedMethods: new SavedMethods(),
    publicKeyPem,
    usage: new MemoryDailyUsage({ session: 1000, model_call: 1000, house_session: houseSessions }),
    paypal: { executor: paypal, vault: paypal },
    provider: new ScriptedModel(),
    baseUrl: base,
    now: () => new Date(clock),
    log: (line) => logs.push(line),
    ...(house === null ? {} : { house }),
  };
}

function use(next: DemoDeps): void {
  deps = next;
  handler = createDemoHandler(deps);
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
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record, approval, demo_usage RESTART IDENTITY`;
  await seedDemoCatalog();
  clock = Date.now();
  logs.length = 0;
  responses.length = 0;
  paypal = new FakePayPal();
  use(makeDeps(new HouseBuyer(HOUSE_TOKEN)));
});

afterAll(async () => {
  server.close();
  await prisma.$disconnect();
});

/** A browser with its own cookie jar. Redirects are returned, not followed. */
function visitor(address: string | null = null) {
  let cookie: string | null = null;
  async function request(method: "GET" | "POST", path: string) {
    // The address is what a trusted proxy in front of the server would report (deps.proxyHops).
    const headers = { ...(cookie === null ? {} : { Cookie: `${COOKIE}=${cookie}` }), ...(address === null ? {} : { "X-Forwarded-For": address }) };
    const res = await fetch(`${base}${path}`, { method, redirect: "manual", headers });
    const match = new RegExp(`${COOKIE}=([^;]*)`).exec(res.headers.get("set-cookie") ?? "");
    if (match) cookie = match[1] === "" ? null : (match[1] ?? null);
    const text = await res.text();
    responses.push(`${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${text}`);
    return { status: res.status, location: res.headers.get("location"), text };
  }
  return {
    get: (path: string) => request("GET", path),
    post: (path: string) => request("POST", path),
    page: async () => (await request("GET", "/demo")).text,
    get cookie() {
      return cookie;
    },
  };
}
type Visitor = ReturnType<typeof visitor>;

async function onHouseBuyer(): Promise<Visitor> {
  const v = visitor();
  await v.post("/demo/start");
  const res = await v.post(HOUSE_PATH);
  expect(res).toMatchObject({ status: 303, location: "/demo#connect" });
  return v;
}

async function loggedIn(): Promise<Visitor> {
  const v = visitor();
  await v.post("/demo/start");
  await v.post("/demo/connect");
  await v.get(`/demo/connect/return?approval_token_id=${SETUP_TOKEN}&approval_session_id=x`);
  return v;
}

const sessionOf = (v: Visitor) => {
  const s = deps.sessions.get(v.cookie, new Date(clock));
  if (s === null) throw new Error("no session");
  return s;
};
const json = (x: unknown) => JSON.stringify(x, (_k, val: unknown) => (typeof val === "bigint" ? val.toString() : val));
const outcomesOf = async (traceId: string | null | undefined) =>
  (await prisma.ledgerEntry.findMany({ where: { traceId: traceId ?? "none", eventType: "outcome" } })).map((r) => r.payload);

/** PayPal answers every saved-method charge with a refusal, the way a declined or deleted token would. */
function refuseCharges(code: string): void {
  paypal.chargeSavedMethod = async (req: CreateOrderRequest, vaultId: string): Promise<ExecOutcome> => {
    paypal.charges.push({ req, vaultId });
    return { rail: "paypal", order_id: "", status: "failed", amount_minor: req.amount_minor, currency: "USD", payment_id: null, approve_url: null, failure_code: code };
  };
}

const CHOICE_MARK = 'action="/demo/connect/house"';

describe("with no house buyer configured", () => {
  beforeEach(() => use(makeDeps(null)));

  it("no route accepts the choice, with or without a session", async () => {
    const stranger = visitor();
    expect((await stranger.post(HOUSE_PATH)).status).toBe(404);
    const v = visitor();
    await v.post("/demo/start");
    expect((await v.post(HOUSE_PATH)).status).toBe(404);
    expect(sessionOf(v)).toMatchObject({ connected: false, houseBuyer: false });
    await v.post("/demo/step/first");
    expect(sessionOf(v).beats.get("first")).toBeUndefined();
    expect(paypal.charges).toHaveLength(0);
  });

  it("no page mentions it", async () => {
    const v = visitor();
    const start = await v.page();
    await v.post("/demo/start");
    const story = await v.page();
    for (const html of [start, story]) {
      expect(html).not.toContain("connect/house");
      expect(html).not.toMatch(/demo(&#39;|')s sandbox buyer/);
    }
    expect(story).toContain('action="/demo/connect"');
    expect(houseChoiceHtml(false)).toBe("");
    // The start page and the connect step say what needs the sandbox login, as they do without this feature.
    expect(start).toContain("The PayPal steps that come later need the sandbox buyer login");
    expect(story).toContain("No login? Steps 7 and 8 need none");
  });

  it("the PayPal login path is as it was: the visitor's own account is charged, and deleted when the session ends", async () => {
    const v = await loggedIn();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    expect(paypal.charges.map((c) => c.vaultId)).toEqual([PAYMENT_TOKEN]);
    await v.post("/demo/end");
    expect(paypal.deleted).toEqual([PAYMENT_TOKEN]);
  });
});

describe("with the secret set and the daily cap at 0", () => {
  // DEMO_DAILY_HOUSE_SESSIONS=0 with DEMO_HOUSE_BUYER_TOKEN left in place: the documented pause.
  beforeEach(() => use(makeDeps(new HouseBuyer(HOUSE_TOKEN, { on: false }), 0)));

  it("offers and accepts nothing, like a server without the secret", async () => {
    expect((await visitor().post(HOUSE_PATH)).status).toBe(404);
    const v = visitor();
    const start = await v.page();
    await v.post("/demo/start");
    const story = await v.page();
    for (const html of [start, story]) {
      expect(html).not.toContain("connect/house");
      expect(html).not.toMatch(/demo(&#39;|')s sandbox buyer/);
    }
    expect((await v.post(HOUSE_PATH)).status).toBe(404);
    expect(sessionOf(v)).toMatchObject({ connected: false, houseBuyer: false });

    // Even a session flagged by mistake is never given the token to charge.
    const s = sessionOf(v);
    s.houseBuyer = true;
    const req: CreateOrderRequest = { amount_minor: minor(100n), currency: "USD", idempotency_key: "k".repeat(64), receipt: "r" };
    expect(savedMethodChoice(s, deps.savedMethods, deps.now, deps.house ?? null)(req)).toBeNull();
    expect(deps.house?.offered(new Date(clock))).toBe(false);
  });

  it("still never deletes the house token, whatever ends a session", async () => {
    expect(deps.house?.holds(HOUSE_TOKEN)).toBe(true);
    const hold = async () => {
      const v = visitor();
      await v.post("/demo/start");
      const s = sessionOf(v);
      deps.savedMethods.put(s.id, HOUSE_TOKEN, s.expiresAt);
      return v;
    };
    await (await hold()).post("/demo/end");

    await hold();
    clock += 61 * 60 * 1000;
    expect(await sweepExpiredSessions(deps)).toBe(1);

    await hold();
    await loggedIn();
    expect(await releaseAllSessions(deps, 2000)).toEqual({ sessions: 2, deleted: 1, notDeleted: 0 });
    expect(paypal.deleted).toEqual([PAYMENT_TOKEN]);
  });
});

describe("choosing the house buyer", () => {
  it("offers the choice beside the PayPal login, as a button and one sentence", async () => {
    const v = visitor();
    await v.post("/demo/start");
    const page = await v.page();
    expect(page).toContain('action="/demo/connect"');
    expect(page).toContain(CHOICE_MARK);
    const html = houseChoiceHtml(true);
    expect(html).toContain(CHOICE_MARK);
    expect(html).toContain('method="post"');
    expect(html).toContain("Use the demo&#39;s sandbox buyer");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html.match(/<p>/g)).toHaveLength(1);
    expect(html).toContain("sandbox money");
    expect(html).not.toMatch(/<script|style=|onclick/i);
  });

  it("charges the house buyer only after Praman allows it, under the visitor's own mandate", async () => {
    const v = await onHouseBuyer();
    const s = sessionOf(v);
    expect(s).toMatchObject({ connected: true, houseBuyer: true });
    expect(deps.savedMethods.has(s.id)).toBe(false);
    const connected = await v.page();
    expect(connected).toContain("Connected to the demo&#39;s sandbox buyer");
    expect(connected).not.toContain("deleted when the session ends");
    expect(connected).not.toContain("deletes the saved PayPal method");
    expect(connected).not.toContain(CHOICE_MARK);

    await v.post("/demo/step/first");
    expect(s.beats.get("first")).toMatchObject({ state: "awaiting_approval", reasonCode: "STEP_UP_FIRST_MERCHANT" });
    expect(paypal.charges).toHaveLength(0);

    await v.post("/demo/approve/first");
    expect(paypal.charges).toHaveLength(1);
    expect(paypal.charges[0]?.vaultId).toBe(HOUSE_TOKEN);
    expect(paypal.charges[0]?.req.amount_minor).toBe(1250n);
    expect(s.beats.get("first")).toMatchObject({ state: "done", payment: "saved_method", orderStatus: "captured" });
    expect(s.beats.get("first")?.message).toContain("the demo's sandbox buyer");
    expect(s.beats.get("first")?.message).not.toContain("your saved PayPal account");
    expect(await v.page()).toContain("Paid from the demo&#39;s sandbox buyer account, with no buyer present.");

    await v.post("/demo/step/second");
    expect(s.beats.get("second")).toMatchObject({ state: "done", reasonCode: "OK", agentView: { kind: "ALLOW", amount_minor: 450n } });
    expect(paypal.charges.map((c) => c.vaultId)).toEqual([HOUSE_TOKEN, HOUSE_TOKEN]);
    expect(paypal.checkouts).toHaveLength(0);

    // The ledger rows are the ones a saved account connected by login writes, under this session's mandate.
    const rows = await prisma.ledgerEntry.findMany({ where: { traceId: s.beats.get("second")?.traceId ?? "none" }, orderBy: { seq: "asc" } });
    expect(rows.map((r) => r.eventType)).toEqual(["intent", "decision", "api_call", "outcome", "agent_transcript"]);
    expect(json(rows[0]?.payload)).toContain(s.mandate.document.mandate_id);
    expect(rows.find((r) => r.eventType === "outcome")?.payload).toMatchObject({ status: "captured", rail: "paypal", amount_minor: "450", currency: "USD" });
  });

  it("is refused for a session that is already connected or whose mandate is revoked", async () => {
    const own = await loggedIn();
    await own.post(HOUSE_PATH);
    expect(sessionOf(own)).toMatchObject({ connected: true, houseBuyer: false });
    expect(await own.page()).toContain("already connected");

    const revoked = visitor();
    await revoked.post("/demo/start");
    await revoked.post("/demo/step/revoke");
    await revoked.post(HOUSE_PATH);
    expect(sessionOf(revoked)).toMatchObject({ connected: false, houseBuyer: false });
  });

  it("gives way to the visitor's own account if they finish a PayPal login as well", async () => {
    const v = visitor();
    await v.post("/demo/start");
    await v.post("/demo/connect");
    await v.post(HOUSE_PATH);
    await v.get(`/demo/connect/return?approval_token_id=${SETUP_TOKEN}`);
    expect(sessionOf(v)).toMatchObject({ connected: true, houseBuyer: false });
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    expect(paypal.charges.map((c) => c.vaultId)).toEqual([PAYMENT_TOKEN]);
  });
});

describe("what the pages say once the house buyer is offered", () => {
  it("the start page no longer says a PayPal login is needed for everything", async () => {
    const start = await visitor().page();
    expect(start).not.toContain("The PayPal steps that come later need the sandbox buyer login");
    expect(start).toContain("with no PayPal login");
    // It still says what does need the login, and where the login is.
    expect(start).toContain("PayPal&#39;s checkout");
    expect(start).toContain("Devpost");
    expect(start).toContain('href="/demo/recorded"');

    // While the house buyer rests, a new visitor is told what is true then: the login is needed.
    deps.house?.refused(new Date(clock));
    expect(await visitor().page()).toContain("The PayPal steps that come later need the sandbox buyer login");
  });

  it("a house session's checkout isn't told that step 3 logged its window in", async () => {
    const v = await onHouseBuyer();
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    await v.post("/demo/step/large");
    await v.post("/demo/approve/large");
    expect(sessionOf(v).beats.get("large")).toMatchObject({ state: "awaiting_checkout" });
    const page = await v.page();
    expect(page).toContain("Pay at PayPal.");
    expect(page).not.toContain("connecting PayPal in step 3 logged this window in");
    expect(page).toContain("needs a buyer at PayPal&#39;s checkout");
    expect(page).toContain("Without that login this purchase stays unpaid and nothing is charged.");
    expect(page).toContain('action="/demo/capture/large"');

    // A session that did log in is told what it always was.
    const own = await loggedIn();
    await own.post("/demo/step/first");
    await own.post("/demo/approve/first");
    await own.post("/demo/step/large");
    await own.post("/demo/approve/large");
    const ownPage = await own.page();
    expect(ownPage).toContain("connecting PayPal in step 3 logged this window in");
    expect(ownPage).not.toContain("Without that login this purchase stays unpaid");
  });
});

describe("the house buyer never bypasses a step-up or a checkout", () => {
  const req = (amount: bigint): CreateOrderRequest => ({ amount_minor: minor(amount), currency: "USD", idempotency_key: "k".repeat(64), receipt: "r" });

  it("names the house token only below the signed threshold, and only for a session that chose it", () => {
    const keys = generateKeypair();
    const now = new Date("2026-11-10T09:00:00.000Z");
    const session = createDemoSession(now, { ...keys, keyId: "test_demo_k1" });
    const house = new HouseBuyer(HOUSE_TOKEN);
    const choice = savedMethodChoice(session, new SavedMethods(), () => now, house);
    expect(choice(req(1999n))).toBeNull();

    session.houseBuyer = true;
    expect(choice(req(1n))).toBe(HOUSE_TOKEN);
    expect(choice(req(1999n))).toBe(HOUSE_TOKEN);
    expect(choice(req(2000n))).toBeNull();
    expect(choice(req(2001n))).toBeNull();
    expect(choice(req(10_000n))).toBeNull();

    // Not after the session's hour, and not without a house buyer on this server.
    expect(savedMethodChoice(session, new SavedMethods(), () => session.expiresAt, house)(req(1n))).toBeNull();
    expect(savedMethodChoice(session, new SavedMethods(), () => now)(req(1n))).toBeNull();
    expect(savedMethodChoice(session, new SavedMethods(), () => now, null)(req(1n))).toBeNull();
  });

  it("sends a purchase at or above the threshold to PayPal's checkout, after the visitor approves", async () => {
    const v = await onHouseBuyer();
    const s = sessionOf(v);
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    expect(paypal.charges).toHaveLength(1);

    await v.post("/demo/step/large");
    expect(s.beats.get("large")).toMatchObject({ state: "awaiting_approval", reasonCode: "STEP_UP_THRESHOLD" });
    expect(paypal.charges).toHaveLength(1);
    expect(paypal.checkouts).toHaveLength(0);

    await v.post("/demo/approve/large");
    expect(s.beats.get("large")).toMatchObject({ state: "awaiting_checkout", payment: "checkout", orderStatus: "created" });
    expect(paypal.charges).toHaveLength(1);
    expect(paypal.checkouts).toHaveLength(1);
    expect(paypal.checkouts[0]?.amount_minor).toBe(3200n);

    // Nobody approved at PayPal, so the capture moves nothing.
    await v.post("/demo/capture/large");
    expect(s.beats.get("large")).toMatchObject({ state: "awaiting_checkout", failureCode: "ORDER_NOT_APPROVED" });
    expect([...paypal.orders.values()].filter((o) => o.captured)).toHaveLength(1);
  });

  it("a rejected step-up charges nothing", async () => {
    const v = await onHouseBuyer();
    await v.post("/demo/step/first");
    await v.post("/demo/reject/first");
    expect(sessionOf(v).beats.get("first")).toMatchObject({ state: "refused" });
    expect(paypal.charges).toHaveLength(0);
    expect(paypal.checkouts).toHaveLength(0);
  });
});

describe("the house token is never deleted at PayPal", () => {
  it("when a session ends", async () => {
    const v = await onHouseBuyer();
    const s = sessionOf(v);
    await v.post("/demo/end");
    expect(paypal.deleted).toEqual([]);
    expect(s).toMatchObject({ connected: false, houseBuyer: false });
  });

  it("when a visitor starts a new session over an old one", async () => {
    const v = await onHouseBuyer();
    await v.post("/demo/start");
    expect(sessionOf(v)).toMatchObject({ connected: false, houseBuyer: false });
    expect(paypal.deleted).toEqual([]);
  });

  it("when a session expires", async () => {
    await onHouseBuyer();
    clock += 61 * 60 * 1000;
    expect(await sweepExpiredSessions(deps)).toBe(1);
    expect(paypal.deleted).toEqual([]);
  });

  it("on shutdown, beside a login session whose own token is deleted", async () => {
    await onHouseBuyer();
    await loggedIn();
    const result = await releaseAllSessions(deps, 2000);
    expect(result).toEqual({ sessions: 2, deleted: 1, notDeleted: 0 });
    expect(paypal.deleted).toEqual([PAYMENT_TOKEN]);
    expect(deps.sessions.size).toBe(0);
  });

  it("when a PayPal login hands back the same token and that session ends, expires, or the server stops", async () => {
    // Someone logs in as the house buyer's own sandbox account and PayPal answers with the house token.
    paypal.createPaymentToken = async () => ({ ok: true, value: { id: HOUSE_TOKEN } });
    const ended = await loggedIn();
    expect(deps.savedMethods.has(sessionOf(ended).id)).toBe(true);
    await ended.post("/demo/end");

    await loggedIn();
    clock += 61 * 60 * 1000;
    await sweepExpiredSessions(deps);

    await loggedIn();
    expect(await releaseAllSessions(deps, 2000)).toEqual({ sessions: 1, deleted: 0, notDeleted: 0 });
    expect(paypal.deleted).toEqual([]);
  });

  it("when a session ends while PayPal answers a login with the same token", async () => {
    const v = visitor();
    await v.post("/demo/start");
    await v.post("/demo/connect");
    paypal.createPaymentToken = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { ok: true, value: { id: HOUSE_TOKEN } };
    };
    const returning = v.get(`/demo/connect/return?approval_token_id=${SETUP_TOKEN}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await v.post("/demo/end");
    await returning;
    expect(paypal.deleted).toEqual([]);
    expect(deps.savedMethods.takeAll()).toEqual([]);
  });
});

describe("a visitor who logs in to PayPal as the house buyer's own account", () => {
  // PayPal may answer that login with the house token itself. The session holds it as any
  // login session holds its token: it never chose the house buyer and isn't treated as if it had.
  beforeEach(() => {
    paypal.createPaymentToken = async () => ({ ok: true, value: { id: HOUSE_TOKEN } });
  });

  it("is told the truth about its saved method: it stays at PayPal when the session ends", async () => {
    const v = await loggedIn();
    expect(sessionOf(v)).toMatchObject({ connected: true, houseBuyer: false, holdsHouseToken: true });
    const page = await v.page();
    expect(page).not.toContain("deleted when the session ends");
    expect(page).not.toContain("deletes the saved PayPal method");
    expect(page).toContain("stays saved at PayPal when the session ends");
    expect(page).not.toContain(HOUSE_TOKEN);
    await v.post("/demo/end");
    expect(paypal.deleted).toEqual([]);

    // An ordinary login is still told its method is deleted, and it is.
    paypal.createPaymentToken = FakePayPal.prototype.createPaymentToken.bind(paypal);
    const own = await loggedIn();
    expect(sessionOf(own).holdsHouseToken).toBe(false);
    expect(await own.page()).toContain("deleted when the session ends");
    await own.post("/demo/end");
    expect(paypal.deleted).toEqual([PAYMENT_TOKEN]);
  });

  it("keeps its login when PayPal refuses the charge, and is not told it was on the demo's sandbox buyer", async () => {
    const v = await loggedIn();
    const s = sessionOf(v);
    await v.post("/demo/step/first");
    refuseCharges("INSTRUMENT_DECLINED");
    await v.post("/demo/approve/first");

    expect(paypal.charges).toHaveLength(1);
    expect(s.beats.get("first")).toMatchObject({ state: "failed", orderStatus: "failed" });
    // Still the login session it was: connected, with its token held, and no notice about a buyer it never chose.
    expect(s).toMatchObject({ connected: true, houseBuyer: false });
    expect(deps.savedMethods.has(s.id)).toBe(true);
    expect(s.notice ?? "").not.toContain("sandbox buyer");
    expect(await v.page()).not.toMatch(/refused the demo(&#39;|')s sandbox buyer/);
    // The token PayPal refused is the house buyer's, so the house buyer rests all the same.
    expect(deps.house?.offered(new Date(clock))).toBe(false);
    expect(logs.join("\n")).toContain("INSTRUMENT_DECLINED");
    expect(paypal.deleted).toEqual([]);
  });
});

describe("the house token stays on the server", () => {
  it("never appears in a response, a ledger row, a record, a log or anything printed", async () => {
    const v = await onHouseBuyer();
    const s = sessionOf(v);
    await v.post("/demo/step/first");
    await v.post("/demo/approve/first");
    await v.post("/demo/step/second");
    await v.post("/demo/step/large");
    await v.post("/demo/approve/large");
    await v.get("/demo/r/first");
    await v.get("/demo/dispute/first");
    await v.get("/demo/console/data");
    await v.page();
    refuseCharges("PAYMENT_SOURCE_DECLINED_BY_PROCESSOR");
    const other = await onHouseBuyer();
    await other.post("/demo/step/first");
    await other.post("/demo/approve/first");
    await other.page();
    await v.post("/demo/end");

    expect(paypal.charges.filter((c) => c.vaultId === HOUSE_TOKEN).length).toBeGreaterThan(2);
    const stored = json([await prisma.ledgerEntry.findMany(), await prisma.idempotencyRecord.findMany(), await prisma.approval.findMany(), await prisma.demoUsage.findMany()]);
    expect(stored).toContain("VLT1");
    expect(stored).not.toContain(HOUSE_TOKEN);
    expect(responses.join("\n")).not.toContain(HOUSE_TOKEN);
    expect(logs.join("\n")).not.toContain(HOUSE_TOKEN);
    expect(json(s)).not.toContain(HOUSE_TOKEN);
    expect(JSON.stringify(deps.house)).not.toContain(HOUSE_TOKEN);
    expect(inspect(deps.house, { depth: 5, showHidden: true })).not.toContain(HOUSE_TOKEN);
    expect(inspect({ ...deps, paypal: null }, { depth: 6 })).not.toContain(HOUSE_TOKEN);
    expect(String(deps.house)).not.toContain(HOUSE_TOKEN);
  });

});

describe("the daily cap on house-buyer sessions", () => {
  it("stops offering the choice once the day's sessions are used, and leaves the login path", async () => {
    use(makeDeps(new HouseBuyer(HOUSE_TOKEN), 2));
    await onHouseBuyer();
    await onHouseBuyer();

    const third = visitor();
    await third.post("/demo/start");
    expect(await third.page()).toContain(CHOICE_MARK);
    await third.post(HOUSE_PATH);
    expect(sessionOf(third)).toMatchObject({ connected: false, houseBuyer: false });
    const page = await third.page();
    expect(page).toContain("used up");
    expect(page).not.toContain(CHOICE_MARK);
    expect(page).toContain('action="/demo/connect"');

    const fourth = visitor();
    await fourth.post("/demo/start");
    expect(await fourth.page()).not.toContain(CHOICE_MARK);
    await fourth.post(HOUSE_PATH);
    expect(sessionOf(fourth).houseBuyer).toBe(false);

    // The login path is untouched by the cap.
    await third.post("/demo/connect");
    await third.get(`/demo/connect/return?approval_token_id=${SETUP_TOKEN}`);
    expect(sessionOf(third)).toMatchObject({ connected: true, houseBuyer: false });

    // The next UTC day starts again.
    clock += 24 * 60 * 60 * 1000;
    const tomorrow = visitor();
    await tomorrow.post("/demo/start");
    expect(await tomorrow.page()).toContain(CHOICE_MARK);
    await tomorrow.post(HOUSE_PATH);
    expect(sessionOf(tomorrow).houseBuyer).toBe(true);
  });

});

describe("one address can't use up the day's house-buyer sessions", () => {
  const PER_ADDRESS = LIMITS.housePerIp.limit;

  it("stops enrolling sessions from an address past its own limit, without spending the day's count", async () => {
    // The day allows one more than a single address may take.
    use({ ...makeDeps(new HouseBuyer(HOUSE_TOKEN), PER_ADDRESS + 1), proxyHops: 1 });
    const from = async (address: string) => {
      const v = visitor(address);
      await v.post("/demo/start");
      await v.post(HOUSE_PATH);
      return v;
    };
    for (let i = 0; i < PER_ADDRESS; i++) expect(sessionOf(await from("198.51.100.7")).houseBuyer).toBe(true);

    const over = await from("198.51.100.7");
    expect(sessionOf(over)).toMatchObject({ connected: false, houseBuyer: false });
    const page = await over.page();
    expect(page).toContain("from your address");
    expect(page).toContain('action="/demo/connect"');
    // Pressing again changes nothing.
    await over.post(HOUSE_PATH);
    expect(sessionOf(over).houseBuyer).toBe(false);

    // The refused presses took none of the day's sessions: another address gets the last one.
    expect(sessionOf(await from("203.0.113.9")).houseBuyer).toBe(true);
    expect(sessionOf(await from("203.0.113.10")).houseBuyer).toBe(false);

    // A press that enrols nobody isn't counted against the address either.
    use({ ...makeDeps(new HouseBuyer(HOUSE_TOKEN)), proxyHops: 1 });
    const repeat = await from("198.51.100.8");
    for (let i = 0; i < PER_ADDRESS + 2; i++) await repeat.post(HOUSE_PATH);
    expect(sessionOf(await from("198.51.100.8")).houseBuyer).toBe(true);

    // A day later the address may use it again.
    for (let i = 0; i < PER_ADDRESS; i++) await from("198.51.100.9");
    expect(sessionOf(await from("198.51.100.9")).houseBuyer).toBe(false);
    clock += LIMITS.housePerIp.windowMs;
    expect(sessionOf(await from("198.51.100.9")).houseBuyer).toBe(true);
  });
});

describe("when PayPal refuses the house buyer", () => {
  it("charges nothing, sends the session back to the login path in plain words, and stops offering the choice", async () => {
    const v = await onHouseBuyer();
    const s = sessionOf(v);
    await v.post("/demo/step/first");
    refuseCharges("PAYMENT_SOURCE_DECLINED_BY_PROCESSOR");
    await v.post("/demo/approve/first");

    expect(paypal.charges).toHaveLength(1);
    expect(paypal.orders.size).toBe(0);
    expect(s.beats.get("first")).toMatchObject({ state: "failed", orderStatus: "failed" });
    expect(await outcomesOf(s.beats.get("first")?.traceId)).toMatchObject([{ status: "failed" }]);
    expect(s).toMatchObject({ connected: false, houseBuyer: false });

    const page = await v.page();
    expect(page).toContain("PayPal refused the demo&#39;s sandbox buyer (PAYMENT_SOURCE_DECLINED_BY_PROCESSOR). Nothing was charged.");
    expect(page).toContain("logging in");
    expect(page).not.toContain(CHOICE_MARK);
    expect(page).toContain('action="/demo/connect"');
    expect(page).not.toMatch(/at \S+ \(/);
    expect(logs.join("\n")).toContain("PAYMENT_SOURCE_DECLINED_BY_PROCESSOR");

    // A new visitor isn't offered it, and can't take it by asking.
    const next = visitor();
    await next.post("/demo/start");
    expect(await next.page()).not.toContain(CHOICE_MARK);
    await next.post(HOUSE_PATH);
    expect(sessionOf(next)).toMatchObject({ connected: false, houseBuyer: false });
    expect(await next.page()).toContain("logging in");

    // The login path works as it always did.
    await next.post("/demo/connect");
    await next.get(`/demo/connect/return?approval_token_id=${SETUP_TOKEN}`);
    paypal = Object.assign(paypal, { chargeSavedMethod: FakePayPal.prototype.chargeSavedMethod });
    await next.post("/demo/step/first");
    await next.post("/demo/approve/first");
    expect(sessionOf(next).beats.get("first")).toMatchObject({ state: "done", orderStatus: "captured" });
    expect(paypal.charges.at(-1)?.vaultId).toBe(PAYMENT_TOKEN);
    expect(paypal.deleted).toEqual([]);
  });

  it("another session already on the house buyer falls back before anything is asked", async () => {
    const a = await onHouseBuyer();
    const b = await onHouseBuyer();
    await a.post("/demo/step/first");
    refuseCharges("PAYEE_ACCOUNT_RESTRICTED");
    await a.post("/demo/approve/first");
    const rowsBefore = await prisma.ledgerEntry.count();
    const chargesBefore = paypal.charges.length;

    const res = await b.post("/demo/step/first");
    expect(res).toMatchObject({ status: 303, location: "/demo#connect" });
    expect(sessionOf(b)).toMatchObject({ connected: false, houseBuyer: false });
    expect(sessionOf(b).beats.get("first")).toBeUndefined();
    expect(await prisma.ledgerEntry.count()).toBe(rowsBefore);
    expect(paypal.charges).toHaveLength(chargesBefore);
    expect(paypal.checkouts).toHaveLength(0);
    expect(await b.page()).toContain("Nothing was asked and nothing was charged");
  });

  it("a step-up already waiting is not approved into a checkout nobody can pay", async () => {
    const a = await onHouseBuyer();
    const b = await onHouseBuyer();
    await a.post("/demo/step/first");
    await b.post("/demo/step/first");
    refuseCharges("PAYEE_ACCOUNT_RESTRICTED");
    await a.post("/demo/approve/first");

    await b.post("/demo/approve/first");
    expect(sessionOf(b).beats.get("first")).toMatchObject({ state: "awaiting_approval" });
    expect(paypal.checkouts).toHaveLength(0);
    expect(paypal.charges).toHaveLength(1);
  });

  it("offers the choice again after a rest, and rests twice as long if PayPal refuses again", async () => {
    const house = new HouseBuyer(HOUSE_TOKEN);
    const t0 = new Date("2026-11-10T09:00:00.000Z");
    const at = (ms: number) => new Date(t0.getTime() + ms);
    expect(house.offered(t0)).toBe(true);
    house.refused(t0);
    expect(house.offered(at(HOUSE_REST_MS - 1))).toBe(false);
    expect(house.offered(at(HOUSE_REST_MS))).toBe(true);
    house.refused(at(HOUSE_REST_MS));
    expect(house.offered(at(3 * HOUSE_REST_MS - 1))).toBe(false);
    expect(house.offered(at(3 * HOUSE_REST_MS))).toBe(true);
    // A charge that works clears the count.
    house.charged();
    house.refused(at(3 * HOUSE_REST_MS));
    expect(house.offered(at(4 * HOUSE_REST_MS))).toBe(true);
    // However often PayPal refuses, the rest is never longer than a day.
    for (let i = 0; i < 40; i++) house.refused(t0);
    expect(house.offered(at(24 * 60 * 60 * 1000))).toBe(true);
  });

  it("refusals that land together are one refusal: the rest is 30 minutes, not doubled for each", async () => {
    const house = new HouseBuyer(HOUSE_TOKEN);
    const t0 = new Date("2026-11-10T09:00:00.000Z");
    for (let i = 0; i < 4; i++) house.refused(new Date(t0.getTime() + i));
    expect(house.offered(new Date(t0.getTime() + HOUSE_REST_MS - 1))).toBe(false);
    expect(house.offered(new Date(t0.getTime() + HOUSE_REST_MS))).toBe(true);
    // The next refusal after that rest is the second in a row.
    house.refused(new Date(t0.getTime() + HOUSE_REST_MS));
    expect(house.offered(new Date(t0.getTime() + 3 * HOUSE_REST_MS - 1))).toBe(false);
    expect(house.offered(new Date(t0.getTime() + 3 * HOUSE_REST_MS))).toBe(true);

    // Four sessions approve at the same moment. PayPal takes a while, then refuses each.
    const visitors = await Promise.all(Array.from({ length: 4 }, () => onHouseBuyer()));
    await Promise.all(visitors.map((v) => v.post("/demo/step/first")));
    refuseCharges("INSTRUMENT_DECLINED");
    const refuse = paypal.chargeSavedMethod;
    paypal.chargeSavedMethod = async (req, vaultId) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return refuse(req, vaultId);
    };
    await Promise.all(visitors.map((v) => v.post("/demo/approve/first")));
    expect(paypal.charges).toHaveLength(4);
    expect(paypal.orders.size).toBe(0);
    expect(deps.house?.offered(new Date(clock + HOUSE_REST_MS - 1))).toBe(false);
    clock += HOUSE_REST_MS;
    const next = visitor();
    await next.post("/demo/start");
    expect(await next.page()).toContain(CHOICE_MARK);
  });

  it("a charge with no answer is not a refusal: the record stays pending and the house buyer stays", async () => {
    const v = await onHouseBuyer();
    await v.post("/demo/step/first");
    paypal.failNextCharge = true;
    await v.post("/demo/approve/first");
    expect(sessionOf(v).beats.get("first")?.state).toBe("pending");
    expect(sessionOf(v)).toMatchObject({ connected: true, houseBuyer: true });
    expect(deps.house?.offered(new Date(clock))).toBe(true);
  });
});

describe("many sessions charging the house buyer at once", () => {
  it("ten sessions each get exactly one capture for one purchase, and the ledger verifies", async () => {
    const visitors = await Promise.all(Array.from({ length: 10 }, () => onHouseBuyer()));
    await Promise.all(visitors.map((v) => v.post("/demo/step/first")));
    expect(paypal.charges).toHaveLength(0);
    // Every visitor presses Approve twice at the same moment.
    await Promise.all(visitors.flatMap((v) => [v.post("/demo/approve/first"), v.post("/demo/approve/first")]));

    expect(paypal.charges).toHaveLength(10);
    expect(paypal.charges.every((c) => c.vaultId === HOUSE_TOKEN && c.req.amount_minor === 1250n && c.req.currency === "USD")).toBe(true);
    expect(new Set(paypal.charges.map((c) => c.req.idempotency_key)).size).toBe(10);
    expect([...paypal.orders.values()].filter((o) => o.captured)).toHaveLength(10);

    const mandates = new Set<string>();
    for (const v of visitors) {
      const s = sessionOf(v);
      const first = s.beats.get("first");
      expect(first).toMatchObject({ state: "done", orderStatus: "captured", payment: "saved_method" });
      const outcomes = await outcomesOf(first?.traceId);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ status: "captured", rail: "paypal", amount_minor: "1250", currency: "USD" });
      mandates.add(s.mandate.document.mandate_id);
    }
    expect(mandates.size).toBe(10);

    expect(await prisma.idempotencyRecord.count({ where: { status: "pending" } })).toBe(0);
    expect((await prisma.idempotencyRecord.findMany()).map((r) => r.status)).toEqual(Array.from({ length: 10 }, () => "succeeded"));
    const chain = await prisma.$transaction((tx) => verifyChain(tx));
    expect(chain).toMatchObject({ ok: true });
    expect(paypal.deleted).toEqual([]);
  });
});
