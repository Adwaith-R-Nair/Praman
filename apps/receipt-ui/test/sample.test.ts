import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { buildBundleStandalone } from "@praman/dispute";
import { append } from "@praman/ledger";
import { generateKeypair } from "@praman/mandate";
import { createApp, type Handler } from "../src/app.js";
import { publicConsoleData, STEP_UP_REASON_WITHHELD, type ConsoleData, type ConsoleRow } from "../src/console/data.js";
import { renderConsolePage } from "../src/console/page.js";
import { MAIN_LIMITS } from "../src/demo/config.js";
import type { DemoDeps } from "../src/demo/connect.js";
import { MemoryDailyUsage } from "../src/demo/limits.js";
import { COOKIE, createDemoHandler } from "../src/demo/routes.js";
import { seedDemoCatalog } from "../src/demo/seed.js";
import { SavedMethods, SessionStore } from "../src/demo/session.js";
import { createSampleLoader, SAMPLE_CACHE_MS, type SampleView } from "../src/pages/sample.js";
import { MAX_SAMPLE_MANDATES, SAMPLE_ENV, sampleConfigured, sampleMandateIds } from "../src/sample-config.js";
import { FakePayPal, PAYMENT_TOKEN, ScriptedModel, SETUP_TOKEN } from "./stand-ins.js";

// The public sample page, against the test database. A real demo session is run through
// the demo's own routes with the stand-in PayPal and the scripted model, then pinned as
// the sample the way a server would: by naming its mandates in SAMPLE_MANDATE_IDS.

let server: Server;
let handler: Handler = async () => {};
let base: string;
let deps: DemoDeps;
let publicKeyPem: string;
let clock: number;
const logs: string[] = [];

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
  delete process.env[SAMPLE_ENV];
  clock = Date.now();
  logs.length = 0;
  const paypal = new FakePayPal();
  const keys = generateKeypair();
  publicKeyPem = keys.publicKeyPem;
  deps = {
    sessions: new SessionStore({ privateKeyPem: keys.privateKeyPem, publicKeyPem: keys.publicKeyPem, keyId: "test_demo_k1" }),
    savedMethods: new SavedMethods(),
    publicKeyPem: keys.publicKeyPem,
    usage: new MemoryDailyUsage({ session: 1000, model_call: 1000 }),
    paypal: { executor: paypal, vault: paypal },
    provider: new ScriptedModel(),
    baseUrl: base,
    now: () => new Date(clock),
    log: (line) => logs.push(line),
  };
  // The app as server.ts builds it on the hosted demo: the demo on, the operator console off.
  handler = createApp({
    demo: createDemoHandler(deps),
    webhooks: { webhookId: null, verify: async () => false, apply: async () => "unmatched", now: () => new Date(clock) },
    hsts: false,
    proxyHops: 0,
    now: () => new Date(clock),
    onDemoRequest: () => {},
    log: (line) => logs.push(line),
  });
});

afterEach(() => {
  delete process.env[SAMPLE_ENV];
});

afterAll(async () => {
  server.close();
  await prisma.$disconnect();
});

function visitor() {
  let cookie: string | null = null;
  async function request(method: "GET" | "POST", path: string) {
    const res = await fetch(`${base}${path}`, { method, redirect: "manual", headers: cookie === null ? {} : { Cookie: `${COOKIE}=${cookie}` } });
    const match = new RegExp(`${COOKIE}=([^;]*)`).exec(res.headers.get("set-cookie") ?? "");
    if (match) cookie = match[1] === "" ? null : (match[1] ?? null);
    return { status: res.status, text: await res.text(), headers: res.headers };
  }
  return {
    get: (path: string) => request("GET", path),
    post: (path: string) => request("POST", path),
    get cookie() {
      return cookie;
    },
  };
}
type Visitor = ReturnType<typeof visitor>;

const sessionOf = (v: Visitor) => {
  const s = deps.sessions.get(v.cookie, new Date(clock));
  if (s === null) throw new Error("no session");
  return s;
};

/** One whole session: an approved step-up, a plain allow, a pending step-up, a refusal, twenty at once, and a revocation. */
async function runSession(): Promise<Visitor> {
  const v = visitor();
  await v.post("/demo/start");
  await v.post("/demo/connect");
  await v.get(`/demo/connect/return?approval_token_id=${SETUP_TOKEN}&approval_session_id=x`);
  await v.post("/demo/step/first");
  await v.post("/demo/approve/first");
  await v.post("/demo/step/second");
  await v.post("/demo/step/large");
  await v.post("/demo/step/injection");
  await v.post("/demo/step/fixture");
  await v.post("/demo/step/concurrency");
  await v.post("/demo/step/revoke");
  await v.post("/demo/step/after_revoke");
  return v;
}

function pin(v: Visitor): string[] {
  const s = sessionOf(v);
  const ids = [s.mandate.document.mandate_id, s.harnessMandate.document.mandate_id];
  process.env[SAMPLE_ENV] = ids.join(",");
  return ids;
}

const anyone = () => visitor();

/** Every key and every string in a JSON value, however deep. */
function walk(value: unknown, keys: Set<string>, strings: string[]): void {
  if (typeof value === "string") strings.push(value);
  else if (Array.isArray(value)) for (const v of value) walk(v, keys, strings);
  else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      walk(v, keys, strings);
    }
  }
}

describe("SAMPLE_MANDATE_IDS", () => {
  it("reads one or more mandate ids, and treats anything malformed as no sample", () => {
    expect(sampleMandateIds({})).toEqual([]);
    expect(sampleMandateIds({ [SAMPLE_ENV]: "" })).toEqual([]);
    expect(sampleMandateIds({ [SAMPLE_ENV]: " , " })).toEqual([]);
    expect(sampleMandateIds({ [SAMPLE_ENV]: "mnd_demo_ab12cd34ef56" })).toEqual(["mnd_demo_ab12cd34ef56"]);
    expect(sampleMandateIds({ [SAMPLE_ENV]: " mnd_a , mnd_a_h,mnd_a " })).toEqual(["mnd_a", "mnd_a_h"]);
    expect(sampleMandateIds({ [SAMPLE_ENV]: "mnd_a,mnd b" })).toEqual([]);
    expect(sampleMandateIds({ [SAMPLE_ENV]: "mnd_a'; DROP TABLE ledger_entry;--" })).toEqual([]);
    expect(sampleMandateIds({ [SAMPLE_ENV]: Array.from({ length: MAX_SAMPLE_MANDATES + 1 }, (_x, i) => `mnd_${i.toString()}`).join(",") })).toEqual([]);
    expect(sampleConfigured({ [SAMPLE_ENV]: "mnd_a" })).toBe(true);
    expect(sampleConfigured({})).toBe(false);
  });
});

describe("a server with no sample set", () => {
  it("says so at /sample, serves no data, and links to it from nowhere", async () => {
    await runSession();
    const page = await anyone().get("/sample");
    expect(page.status).toBe(404);
    expect(page.text).toContain("No sample run on this server");
    const data = await anyone().get("/sample/data");
    expect(data.status).toBe(404);
    expect(JSON.parse(data.text)).toEqual({ error: "no sample" });

    for (const path of ["/traces", "/demo/console", "/demo", "/"]) {
      expect((await anyone().get(path)).text, path).not.toContain('href="/sample"');
    }
  });
});

describe("the public sample", () => {
  it("shows the pinned session's rows to anyone, and only that session's", async () => {
    const mine = await runSession();
    const other = visitor();
    await other.post("/demo/start");
    await other.post("/demo/step/fixture");
    const ids = pin(mine);

    const res = await anyone().get("/sample/data");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = JSON.parse(res.text) as ConsoleData;
    expect(data.rows.length).toBeGreaterThan(60);
    expect(data.rows.every((r) => r.mandateId !== null && ids.includes(r.mandateId))).toBe(true);
    expect(data.rows.every((r) => r.hashVerdict === "intact" && r.chainVerified)).toBe(true);
    expect(data.chain.ok).toBe(true);
    expect(res.text).not.toContain(sessionOf(other).ref);
    // Every kind of row the story writes is there.
    const kinds = new Set(data.rows.map((r) => r.decision));
    for (const kind of ["ALLOW", "STEP_UP", "DENY", "APPROVED", "REVOKED"]) expect(kinds, kind).toContain(kind);
    expect(data.spend.map((s) => s.mandateId).sort()).toEqual([...ids].sort());
  });

  it("carries no limits, no step-up reasons, no signed mandate and no tokens, in its JSON or its HTML", async () => {
    const v = await runSession();
    const s = sessionOf(v);
    pin(v);
    const json = (await anyone().get("/sample/data")).text;
    const html = (await anyone().get("/sample")).text;
    const data = JSON.parse(json) as ConsoleData;

    // What the ledger holds for this session and the public must not see.
    const ledger = await prisma.ledgerEntry.findMany({ orderBy: { seq: "asc" } });
    const stored = { keys: new Set<string>(), strings: [] as string[] };
    const details: string[] = [];
    const salts: string[] = [];
    for (const row of ledger) {
      walk(row.payload, stored.keys, stored.strings);
      const p = row.payload as Record<string, unknown>;
      if (typeof p["detail"] === "string") details.push(p["detail"]);
      if (typeof p["redaction_salt"] === "string") salts.push(p["redaction_salt"]);
    }
    // The test means nothing unless the ledger really holds these.
    expect(stored.keys.has("signed_mandate") && stored.keys.has("public_key_pem") && stored.keys.has("max_total_minor") && stored.keys.has("threshold_minor")).toBe(true);
    expect(stored.strings.some((x) => x.startsWith("STEP_UP_"))).toBe(true);
    expect(details.length).toBeGreaterThan(0);
    expect(salts.length).toBeGreaterThan(0);

    const pemBody = publicKeyPem.split("\n").find((line) => line !== "" && !line.startsWith("-----")) ?? "no-key";
    const secrets = [
      s.mandate.signature.value,
      s.harnessMandate.signature.value,
      pemBody,
      PAYMENT_TOKEN,
      SETUP_TOKEN,
      v.cookie ?? "no-cookie",
      s.id,
      ...details,
      ...salts,
    ];
    for (const [name, body] of [["json", json], ["html", html]] as const) {
      for (const secret of secrets) expect(body.includes(secret), `${name} holds ${secret.slice(0, 24)}`).toBe(false);
      expect(body, name).not.toContain("STEP_UP_");
      for (const word of ["signed_mandate", "public_key_pem", "redaction_salt", "max_total_minor", "max_per_txn_minor", "threshold_minor", "max_txns_per_window", "max_denials_per_window", "window_seconds", "BEGIN PUBLIC KEY"]) {
        expect(body, `${name}: ${word}`).not.toContain(word);
      }
      // The story mandate's own budget and per-purchase limit, as digits and as money.
      // (The harness mandate spends its whole budget on purpose, so its total is public as spend.)
      for (const limit of [`"${MAIN_LIMITS.max_total_minor}"`, `"${MAIN_LIMITS.max_per_txn_minor}"`, "$60.00", "$40.00"]) {
        expect(body, `${name}: ${limit}`).not.toContain(limit);
      }
    }

    // No key in the JSON names a secret or a limit, and no budget is set anywhere.
    const published = { keys: new Set<string>(), strings: [] as string[] };
    walk(data, published.keys, published.strings);
    const suspect = [...published.keys].filter((k) => /token|secret|cookie|salt|signature|signed|limit|threshold|max_|detail|public_key|pem/i.test(k));
    expect(suspect).toEqual([]);
    expect(data.spend.length).toBe(2);
    for (const series of data.spend) expect(series).toMatchObject({ budgetMinor: null, budgetLabel: null });

    // A row that asked a person says so and gives no reason.
    const asked = data.rows.filter((r) => r.decision === "STEP_UP");
    expect(asked.length).toBeGreaterThanOrEqual(2);
    for (const row of asked) expect(row).toMatchObject({ reasonCode: null, reasonPlain: STEP_UP_REASON_WITHHELD });
    expect(data.decisions.every((d) => d.stepUp === 0)).toBe(true);

    // The page is a frame plus escaped links: no inline script or style for the policy to refuse.
    expect(html).not.toMatch(/<script>|<style>| style="/);
  });

  it("publishes nothing about a row that the trace's public dispute bundle doesn't", async () => {
    const v = await runSession();
    pin(v);
    const data = JSON.parse((await anyone().get("/sample/data")).text) as ConsoleData;
    const bundles = new Map<string, string>();
    for (const traceId of new Set(data.rows.map((r) => r.traceId))) bundles.set(traceId, JSON.stringify(await buildBundleStandalone(traceId)));

    const copied: (keyof ConsoleRow)[] = ["mandateId", "merchantId", "rail", "amountMinor", "currency", "status", "reasonCode", "orderId", "captureId", "refundId", "payloadHash", "prevHash", "entryHash", "actor", "eventType", "ts"];
    for (const row of data.rows) {
      const bundle = bundles.get(row.traceId) ?? "";
      for (const field of copied) {
        const value = row[field];
        if (typeof value === "string") expect(bundle.includes(JSON.stringify(value)), `seq ${row.seq} ${field}=${value}`).toBe(true);
      }
      if (row.decision === "ALLOW" || row.decision === "STEP_UP" || row.decision === "DENY") expect(bundle).toContain(`"${row.decision}"`);
    }
  });

  it("links every trace to its public page and its public bundle, with no script needed", async () => {
    const v = await runSession();
    const s = sessionOf(v);
    pin(v);
    const res = await anyone().get("/sample");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toMatch(/style-src 'self' 'nonce-[^']+' https/);
    expect(res.text).toContain('data-mode="sample"');
    expect(res.text).toContain('data-src="/sample/data"');
    expect(res.text).toContain("Traces in this sample");

    const first = s.beats.get("first")?.traceId ?? "";
    const revoke = `trc_demo_${s.ref}_revoke`;
    for (const traceId of [first, revoke]) {
      expect(traceId).not.toBe("");
      expect(res.text).toContain(`href="/r/${traceId}"`);
      expect(res.text).toContain(`href="/dispute/${traceId}"`);
    }
    // The owner's routes and the session's own bundle are not what it links to.
    expect(res.text).not.toContain("/demo/dispute/");
    expect(res.text).not.toContain("/demo/r/");
    expect(res.text).toContain("Buy one Veggie Burrito Bowl for my lunch.");

    // Those two public addresses answer for someone with no session.
    expect((await anyone().get(`/r/${first}`)).status).toBe(200);
    const bundle = await anyone().get(`/dispute/${first}`);
    expect(bundle.status).toBe(200);
    expect(bundle.text).not.toContain("max_total_minor");
  });

  it("is read-only: nothing can be posted to it, and loading it writes no ledger row", async () => {
    const v = await runSession();
    pin(v);
    const before = await prisma.ledgerEntry.count();
    expect((await anyone().post("/sample")).status).toBe(405);
    expect((await anyone().post("/sample/data")).status).toBe(405);
    await anyone().get("/sample");
    await anyone().get("/sample/data?mandate=mnd_other&limit=9999");
    expect(await prisma.ledgerEntry.count()).toBe(before);
  });

  it("is linked from /traces and from an empty /demo/console once it is set", async () => {
    const v = await runSession();
    pin(v);
    // Only demo traces exist, so /traces is in its empty state.
    expect((await anyone().get("/traces")).text).toContain('href="/sample"');
    expect((await anyone().get("/demo/console")).text).toContain('href="/sample"');
    // A visitor who has a session has their own rows, so their console doesn't point away.
    expect((await v.get("/demo/console")).text).not.toContain('href="/sample"');

    // And with a trace from outside the demo, /traces lists it and still links the sample.
    await prisma.$transaction((tx) => append(tx, { traceId: "trc_outside", ts: new Date(clock), actor: "agent", eventType: "intent", payload: { intent_id: "trc_outside", merchant_id: "MERCHANT_FOOD_01", mandate_id: "mnd_outside" } }));
    const listed = (await anyone().get("/traces")).text;
    expect(listed).toContain('href="/r/trc_outside"');
    expect(listed).toContain('href="/sample"');
  });

  it("sends a sample trace's public page back to the sample, and leaves the owner's page alone", async () => {
    const v = await runSession();
    const first = sessionOf(v).beats.get("first")?.traceId ?? "";
    const publicBefore = (await anyone().get(`/r/${first}`)).text;
    expect(publicBefore).toContain(`href="/demo/console#trace=${first}"`);

    pin(v);
    const publicPage = (await anyone().get(`/r/${first}`)).text;
    expect(publicPage).toContain(`href="/sample#trace=${first}"`);
    expect(publicPage).toContain('<a href="/sample">← the sample run</a>');
    const ownerPage = (await v.get("/demo/r/first")).text;
    expect(ownerPage).toContain(`href="/demo/console#trace=${first}"`);
    expect(ownerPage).not.toContain('href="/sample');
  });
});

describe("publicConsoleData", () => {
  const row = (over: Partial<ConsoleRow>): ConsoleRow => ({
    seq: "1", ts: "2026-11-09T10:00:00.000Z", traceId: "t", actor: "praman", eventType: "decision", eventPlain: "Policy engine decided", mandateId: "m", mandateClaimed: false, merchantId: "M", rail: null,
    amountMinor: "1250", currency: "USD", amount: "$12.50", decision: null, status: null, reasonCode: null, reasonPlain: null, orderId: null, captureId: null, refundId: null,
    prevHash: "0".repeat(64), payloadHash: "a".repeat(64), entryHash: "b".repeat(64),
    check: { payloadIntact: true, fieldsIntact: true, linked: true, recomputedPayloadHash: "a".repeat(64), recomputedEntryHash: "b".repeat(64) }, hashVerdict: "intact", chainVerified: true,
    ...over,
  });

  it("drops budgets and step-up reasons, keeps refusals, and recounts the chart from what is left", () => {
    const full: ConsoleData = {
      generatedAt: "2026-11-09T10:00:00.000Z",
      rows: [
        row({ seq: "1", decision: "STEP_UP", reasonCode: "STEP_UP_THRESHOLD", reasonPlain: "over the threshold" }),
        row({ seq: "2", decision: "DENY", reasonCode: "MANDATE_BUDGET_EXHAUSTED", reasonPlain: "budget used up" }),
        row({ seq: "3", decision: "ALLOW", reasonCode: "OK", reasonPlain: "fine" }),
        // A step-up reason on a row that isn't itself a STEP_UP decision is withheld too.
        row({ seq: "4", eventType: "step_up_resolved", decision: "DENY", reasonCode: "STEP_UP_FIRST_MERCHANT", reasonPlain: "first purchase here" }),
      ],
      truncated: false,
      chain: { ok: true, checked: 4, head: "b".repeat(64), brokenAtSeq: null, breakReason: null, breakReasonPlain: null },
      spend: [{ mandateId: "m", currency: "USD", budgetMinor: "6000", budgetLabel: "$60.00", spentNowMinor: "1250", spentNowLabel: "$12.50", revoked: false, points: [] }],
      decisions: [{ reasonCode: "STEP_UP_THRESHOLD", reasonPlain: "over the threshold", allow: 0, stepUp: 1, deny: 0 }],
      rails: [],
    };
    const pub = publicConsoleData(full);
    expect(pub.rows.map((r) => r.reasonCode)).toEqual([null, "MANDATE_BUDGET_EXHAUSTED", "OK", null]);
    expect(pub.rows[0]?.reasonPlain).toBe(STEP_UP_REASON_WITHHELD);
    expect(pub.rows[3]?.reasonPlain).toBe(STEP_UP_REASON_WITHHELD);
    expect(pub.spend).toEqual([{ ...full.spend[0], budgetMinor: null, budgetLabel: null }]);
    expect(pub.decisions.map((d) => d.reasonCode).sort()).toEqual(["MANDATE_BUDGET_EXHAUSTED", "OK"]);
    expect(JSON.stringify(pub)).not.toMatch(/STEP_UP_|6000|\$60\.00|threshold/);
    // The full copy is untouched.
    expect(full.rows[0]?.reasonCode).toBe("STEP_UP_THRESHOLD");
  });
});

describe("the sample loader", () => {
  const view = (n: number): SampleView => ({ data: { generatedAt: n.toString(), rows: [], truncated: false, chain: { ok: true, checked: 0, head: null, brokenAtSeq: null, breakReason: null, breakReasonPlain: null }, spend: [], decisions: [], rails: [] }, traces: [] });

  it("shares one load for a minute, then loads again", async () => {
    let t = 1_000_000;
    let loads = 0;
    const load = createSampleLoader(() => new Date(t), async () => view((loads += 1)));
    expect((await load(["m"])).data.generatedAt).toBe("1");
    t += SAMPLE_CACHE_MS - 1;
    expect((await load(["m"])).data.generatedAt).toBe("1");
    t += 1;
    expect((await load(["m"])).data.generatedAt).toBe("2");
    // Other mandates are another sample, never the cached one.
    expect((await load(["other"])).data.generatedAt).toBe("3");
    expect(loads).toBe(3);
  });

  it("doesn't keep a failed load", async () => {
    let fail = true;
    const load = createSampleLoader(() => new Date(5), async () => {
      if (fail) throw new Error("database asleep");
      return view(7);
    });
    await expect(load(["m"])).rejects.toThrow("database asleep");
    fail = false;
    expect((await load(["m"])).data.generatedAt).toBe("7");
  });
});

describe("the console page in sample mode", () => {
  it("escapes everything in a trace's line", () => {
    const { html } = renderConsolePage("sample", "bm9uY2Vub25jZW5vbmNlbm9uY2U=", null, [
      { traceId: 'trc_"><script>alert(1)</script>', summary: "<img src=x onerror=alert(2)>", label: "<b>Allowed</b>", labelClass: '"><i>', amount: "<u>$1</u>" },
    ]);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>Allowed");
    expect(html).not.toContain("<i>");
    expect(html).not.toContain("<u>");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).toContain('href="/r/trc_%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E"');
  });

  it("shows no trace list on the visitor's or the operator's console", () => {
    const traces = [{ traceId: "trc_a", summary: "s", label: "Allowed", labelClass: "decision-allow", amount: null }];
    expect(renderConsolePage("visitor", "bm9uY2Vub25jZW5vbmNlbm9uY2U=", null, traces).html).not.toContain("Traces in this sample");
    expect(renderConsolePage("operator", "bm9uY2Vub25jZW5vbmNlbm9uY2U=", null, traces).html).not.toContain("Traces in this sample");
  });
});
