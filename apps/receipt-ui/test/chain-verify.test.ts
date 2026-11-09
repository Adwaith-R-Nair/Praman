import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append, computeEntryHash, computePayloadHash, GENESIS_HASH, type EventType } from "@praman/ledger";
import { checkEntry } from "../src/console/data.js";
import { ASSETS } from "../src/assets.js";
import { MAX_PAYLOAD_CHARS_ON_PAGE, renderTracePage } from "../src/pages/trace.js";

// "Verify in my browser": the script the trace page serves is run here as it is, with
// WebCrypto, against rows the real ledger wrote, and its hashes are compared with the
// ledger's own byte for byte. Runs against TEST_DATABASE_URL.

interface Row {
  seq: string;
  ts: string;
  actor: string;
  eventType: string;
  payloadHash: string;
  prevHash: string;
  entryHash: string;
  payloadText: string | null;
  withheld: string[];
}

interface RowResult {
  seq: string;
  link: "match" | "mismatch" | "unchecked";
  payload: "match" | "mismatch" | "withheld" | "not_held";
  entry: "match" | "mismatch";
  recomputedEntryHash: string | null;
  recomputedPayloadHash: string | null;
  failed: string | null;
}

interface Outcome {
  ok: boolean;
  brokenAt: string | null;
  reason: string | null;
  reasonPlain: string | null;
  rows: RowResult[];
  counts: { entries: number; payloadsRehashed: number; payloadsWithheld: number; payloadsNotHeld: number; links: number; linksNotChecked: number };
}

interface Lib {
  GENESIS_HASH: string;
  available(): boolean;
  sha256Hex(text: string): Promise<string>;
  entryPreimage(row: Partial<Row>): string | null;
  verifyRows(rows: readonly Row[]): Promise<Outcome>;
  tamperOneDigit(rows: readonly Row[]): { rows: Row[]; seq: string; field: "amount_minor" | "ts"; before: string; after: string } | null;
}

const LIB_SOURCE = readFileSync(new URL("../src/pages/chain-verify.client.js", import.meta.url), "utf8");
const TRACE_SOURCE = readFileSync(new URL("../src/pages/trace.client.js", import.meta.url), "utf8");

/** The served script, run in a bare context that has what a browser gives it and no more: no fetch, no document. */
function loadLib(): Lib {
  const sandbox: { crypto: unknown; TextEncoder: unknown; PramanChainVerify?: Lib } = { crypto: webcrypto, TextEncoder };
  runInNewContext(LIB_SOURCE, sandbox);
  if (sandbox.PramanChainVerify === undefined) throw new Error("the script did not load");
  return sandbox.PramanChainVerify;
}

const lib = loadLib();

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record RESTART IDENTITY`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const unescapeHtml = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** The rows as the trace page's own script reads them: from each entry's data attributes. */
function rowsOnPage(html: string): Row[] {
  const rows: Row[] = [];
  for (const li of html.matchAll(/<li class="entry" ([^>]*)>/g)) {
    const attrs = new Map<string, string>();
    for (const a of (li[1] ?? "").matchAll(/([a-z-]+)="([^"]*)"/g)) attrs.set(a[1] ?? "", unescapeHtml(a[2] ?? ""));
    const withheld = attrs.get("data-withheld") ?? "";
    rows.push({
      seq: attrs.get("data-seq") ?? "",
      ts: attrs.get("data-ts") ?? "",
      actor: attrs.get("data-actor") ?? "",
      eventType: attrs.get("data-event-type") ?? "",
      payloadHash: attrs.get("data-payload-hash") ?? "",
      prevHash: attrs.get("data-prev-hash") ?? "",
      entryHash: attrs.get("data-entry-hash") ?? "",
      payloadText: attrs.get("data-payload") ?? null,
      withheld: withheld === "" ? [] : withheld.split(","),
    });
  }
  return rows;
}

const write = (traceId: string, ts: string, actor: string, eventType: EventType, payload: Record<string, unknown>) =>
  prisma.$transaction((tx) => append(tx, { traceId, ts: new Date(ts), actor, eventType, payload }));

const stored = () => prisma.ledgerEntry.findMany({ orderBy: { seq: "asc" } });

const AWKWARD = {
  text: "₹ café 日本語 😀 \"quoted\" back\\slash\nnewline\ttab </script><script>alert(1)</script> &amp; &lt; ' it's",
  "key with spaces & <angle>": ["a", 1, -7, 0, true, false, null, { z: 1, a: { nested: [] } }],
  unicode_escape: "\u0001\u001f  ",
  empty: {},
};

/** One trace with every kind of row the checks treat differently, written by the real append(). */
async function writeTrace(traceId = "trc_verify"): Promise<void> {
  await write(traceId, "2026-11-09T10:00:00.001Z", "agent", "intent", {
    intent_id: traceId,
    mandate_id: "mnd_v",
    merchant_id: "MERCHANT_X",
    signed_mandate: { document: { mandate_id: "mnd_v", limits: { max_total_minor: "6000" } }, signature: { alg: "Ed25519", key_id: "k1", value: "c2lnLXZhbHVl" } },
    public_key_pem: "-----BEGIN PUBLIC KEY-----\nMCowBQ\n-----END PUBLIC KEY-----",
  });
  await write(traceId, "2026-11-09T10:00:00.999Z", "praman", "decision", { mandate_id: "mnd_v", kind: "ALLOW", reason_code: "OK", detail: "within budget 6000", redaction_salt: "0123456789abcdef", amount_minor: "1259", currency: "USD" });
  await write(traceId, "2026-02-28T23:59:59.999Z", "praman", "api_call", { mandate_id: "mnd_v", rail: "paypal", status: "attempted", idempotency_key: "k".repeat(64), amount_minor: "1259", currency: "USD", ...AWKWARD });
  // Far past what a float holds exactly: an amount is a decimal string on the ledger and stays one.
  await write(traceId, "2026-11-09T10:00:01.000Z", "praman", "outcome", { mandate_id: "mnd_v", rail: "paypal", status: "captured", order_id: "ORD-1", amount_minor: "123456789012345678901234567899", currency: "USD" });
  await write(traceId, "2026-11-09T10:00:02.120Z", "agent", "agent_transcript", {
    evidence_only: true,
    transcript: [{ role: "tool_results", results: [{ id: "c1", name: "list_catalog", content: "sku=A category=food price_minor=1259 currency=USD in_stock=true\n<untrusted_merchant_content>\nBowl\n\"Best\" & <b>cheapest</b>\n</untrusted_merchant_content>" }] }],
  });
}

describe("the browser's entry hash", () => {
  it.each([
    ["an ordinary row", { prevHash: "a".repeat(64), seq: "42", ts: "2026-11-09T15:32:03.123Z", actor: "praman", eventType: "decision", payloadHash: "b".repeat(64) }],
    ["the first row of a chain", { prevHash: GENESIS_HASH, seq: "1", ts: "2026-09-05T10:00:00.000Z", actor: "agent", eventType: "intent", payloadHash: "0f".repeat(32) }],
    ["a seq past 2^53, where a float would round", { prevHash: "c".repeat(64), seq: "9007199254740993", ts: "2026-12-31T23:59:59.999Z", actor: "system", eventType: "checkpoint", payloadHash: "d".repeat(64) }],
    ["a seq of thirty digits", { prevHash: "c".repeat(64), seq: "123456789012345678901234567890", ts: "1999-01-01T00:00:00.001Z", actor: "demo_visitor", eventType: "refund_requested", payloadHash: "e".repeat(64) }],
  ])("equals computeEntryHash for %s", async (_name, row) => {
    // The page sends the time as toISOString() gives it, so that string must survive a Date unchanged.
    expect(new Date(row.ts).toISOString()).toBe(row.ts);
    const preimage = lib.entryPreimage(row);
    expect(preimage).toBe(`${row.prevHash}|${row.seq}|${row.ts}|${row.actor}|${row.eventType}|${row.payloadHash}`);
    const server = computeEntryHash({ prevHash: row.prevHash, seq: BigInt(row.seq), ts: new Date(row.ts), actor: row.actor, eventType: row.eventType, payloadHash: row.payloadHash });
    expect(await lib.sha256Hex(preimage ?? "")).toBe(server);
  });

  it("won't hash a row whose fields computeEntryHash would refuse", () => {
    const good = { prevHash: "a".repeat(64), seq: "2", ts: "2026-11-09T15:32:03.123Z", actor: "praman", eventType: "decision", payloadHash: "b".repeat(64) };
    expect(lib.entryPreimage(good)).not.toBeNull();
    const bad: Partial<Row>[] = [
      { ...good, prevHash: "not a hash" },
      { ...good, prevHash: "A".repeat(64) },
      { ...good, payloadHash: "b".repeat(63) },
      { ...good, seq: "0" },
      { ...good, seq: "-1" },
      { ...good, seq: "1e3" },
      { ...good, seq: "07" },
      { ...good, actor: "pra|man" },
      { ...good, eventType: "decision|x" },
      { ...good, ts: "2026-11-09 15:32:03" },
      { ...good, ts: "2026-11-09T15:32:03Z" },
      { ...good, ts: "" },
    ];
    for (const row of bad) expect(lib.entryPreimage(row), JSON.stringify(row)).toBeNull();
    expect(() => computeEntryHash({ prevHash: "not a hash", seq: 2n, ts: new Date(good.ts), actor: "praman", eventType: "decision", payloadHash: good.payloadHash })).toThrow();
    expect(() => computeEntryHash({ prevHash: good.prevHash, seq: 0n, ts: new Date(good.ts), actor: "praman", eventType: "decision", payloadHash: good.payloadHash })).toThrow();
    expect(() => computeEntryHash({ prevHash: good.prevHash, seq: 2n, ts: new Date(good.ts), actor: "pra|man", eventType: "decision", payloadHash: good.payloadHash })).toThrow();
  });

  it("hashes text as UTF-8, like the ledger", async () => {
    for (const text of ["", "plain", AWKWARD.text, JSON.stringify(AWKWARD)]) {
      expect(await lib.sha256Hex(text)).toBe(Buffer.from(await webcrypto.subtle.digest("SHA-256", Buffer.from(text, "utf8"))).toString("hex"));
    }
  });
});

describe("verifying a real trace from what its page carries", () => {
  it("recomputes every entry hash and every whole payload's hash to the ledger's own values", async () => {
    await writeTrace();
    const ledger = await stored();
    const { html } = await renderTracePage("trc_verify");
    const rows = rowsOnPage(html);
    expect(rows.length).toBe(5);

    // What the page sends is exactly what the ledger stores and hashed.
    rows.forEach((row, i) => {
      const entry = ledger[i];
      if (entry === undefined) throw new Error("row missing");
      expect(row).toMatchObject({ seq: entry.seq.toString(), ts: entry.ts.toISOString(), actor: entry.actor, eventType: entry.eventType, payloadHash: entry.payloadHash, prevHash: entry.prevHash, entryHash: entry.entryHash });
    });
    expect(rows.map((r) => r.ts)).toEqual(["2026-11-09T10:00:00.001Z", "2026-11-09T10:00:00.999Z", "2026-02-28T23:59:59.999Z", "2026-11-09T10:00:01.000Z", "2026-11-09T10:00:02.120Z"]);

    const outcome = await lib.verifyRows(rows);
    expect(outcome).toMatchObject({ ok: true, brokenAt: null, reason: null });
    outcome.rows.forEach((result, i) => {
      const entry = ledger[i];
      if (entry === undefined) throw new Error("row missing");
      expect(result.entry).toBe("match");
      expect(result.recomputedEntryHash).toBe(entry.entryHash);
      expect(result.recomputedEntryHash).toBe(computeEntryHash({ prevHash: entry.prevHash, seq: entry.seq, ts: entry.ts, actor: entry.actor, eventType: entry.eventType, payloadHash: entry.payloadHash }));
    });

    // The intent and the decision have withheld fields; the other three are held in full.
    expect(outcome.rows.map((r) => r.payload)).toEqual(["withheld", "withheld", "match", "match", "match"]);
    for (const i of [2, 3, 4]) {
      expect(outcome.rows[i]?.recomputedPayloadHash).toBe(ledger[i]?.payloadHash);
      expect(outcome.rows[i]?.recomputedPayloadHash).toBe(computePayloadHash(ledger[i]?.payload));
    }
    expect(rows[3]?.payloadText).toContain('"amount_minor":"123456789012345678901234567899"');
    // The first row is seq 1, so its link is to the genesis value; the rest follow one another.
    expect(outcome.rows.map((r) => r.link)).toEqual(["match", "match", "match", "match", "match"]);
    expect(outcome.counts).toEqual({ entries: 5, payloadsRehashed: 3, payloadsWithheld: 2, payloadsNotHeld: 0, links: 5, linksNotChecked: 0 });
  });

  it("sends no payload for a row with withheld fields, only the fields' names", async () => {
    await writeTrace();
    const { html } = await renderTracePage("trc_verify");
    const rows = rowsOnPage(html);
    expect(rows[0]).toMatchObject({ payloadText: null, withheld: ["public_key_pem", "signed_mandate"] });
    expect(rows[1]).toMatchObject({ payloadText: null, withheld: ["detail", "redaction_salt"] });
    for (const value of ["c2lnLXZhbHVl", "max_total_minor", "MCowBQ", "within budget 6000", "0123456789abcdef"]) expect(html, value).not.toContain(value);
    // The owner's page gets the same public copy: the full rows are in the owner's bundle.
    const owner = await renderTracePage("trc_verify", () => "", "/demo/dispute/first");
    for (const value of ["c2lnLXZhbHVl", "max_total_minor", "0123456789abcdef"]) expect(owner.html, value).not.toContain(value);
  });

  it("withholds a step-up's reason from the page's copy of the row", async () => {
    await write("trc_ask", "2026-11-09T10:00:00.000Z", "praman", "decision", { mandate_id: "mnd_v", kind: "STEP_UP", reason_code: "STEP_UP_THRESHOLD", amount_minor: "2500", currency: "USD" });
    const { html } = await renderTracePage("trc_ask");
    expect(html).not.toContain("STEP_UP_THRESHOLD");
    const rows = rowsOnPage(html);
    expect(rows[0]).toMatchObject({ payloadText: null, withheld: ["reason_code"] });
    expect((await lib.verifyRows(rows)).rows[0]).toMatchObject({ entry: "match", payload: "withheld" });
  });

  it("doesn't check a link across a gap, where another trace's row sits between", async () => {
    await write("trc_a", "2026-11-09T10:00:00.000Z", "agent", "intent", { intent_id: "trc_a", mandate_id: "m" });
    await write("trc_other", "2026-11-09T10:00:01.000Z", "agent", "intent", { intent_id: "trc_other", mandate_id: "m2" });
    await write("trc_a", "2026-11-09T10:00:02.000Z", "praman", "decision", { mandate_id: "m", kind: "DENY", reason_code: "SKU_UNKNOWN" });
    await write("trc_a", "2026-11-09T10:00:03.000Z", "agent", "agent_transcript", { transcript: [] });
    const rows = rowsOnPage((await renderTracePage("trc_a")).html);
    expect(rows.map((r) => r.seq)).toEqual(["1", "3", "4"]);
    const outcome = await lib.verifyRows(rows);
    expect(outcome.ok).toBe(true);
    expect(outcome.rows.map((r) => r.link)).toEqual(["match", "unchecked", "match"]);
    expect(outcome.counts).toMatchObject({ links: 2, linksNotChecked: 1 });

    // A trace that doesn't start the chain can't check its first row's link either.
    const other = await lib.verifyRows(rowsOnPage((await renderTracePage("trc_other")).html));
    expect(other.rows.map((r) => r.link)).toEqual(["unchecked"]);
  });

  it("leaves a payload too large for the page out, and says it isn't held rather than that it matches", async () => {
    await write("trc_big", "2026-11-09T10:00:00.000Z", "agent", "agent_transcript", { transcript: [{ role: "user", text: "x".repeat(MAX_PAYLOAD_CHARS_ON_PAGE) }] });
    const { html } = await renderTracePage("trc_big");
    const rows = rowsOnPage(html);
    expect(rows[0]).toMatchObject({ payloadText: null, withheld: [] });
    const outcome = await lib.verifyRows(rows);
    expect(outcome.ok).toBe(true);
    expect(outcome.rows[0]).toMatchObject({ payload: "not_held", entry: "match" });
    expect(outcome.counts.payloadsNotHeld).toBe(1);
  });
});

describe("changing one digit in the browser's copy", () => {
  it("changes an amount, breaks at that row for the reason the server gives, and leaves the page's rows alone", async () => {
    await writeTrace();
    const ledger = await stored();
    const rows = rowsOnPage((await renderTracePage("trc_verify")).html);
    const before = JSON.stringify(rows);

    const change = lib.tamperOneDigit(rows);
    if (change === null) throw new Error("nothing changed");
    // The decision's payload isn't held, so the first amount the browser can change is the api_call's.
    expect(change).toMatchObject({ seq: "3", field: "amount_minor", before: "1259", after: "1250" });
    expect(JSON.stringify(rows)).toBe(before);
    expect(change.rows[2]?.payloadText).toContain('"amount_minor":"1250"');
    expect(change.rows.filter((r, i) => JSON.stringify(r) !== JSON.stringify(rows[i])).length).toBe(1);

    const outcome = await lib.verifyRows(change.rows);
    expect(outcome).toMatchObject({ ok: false, brokenAt: "3", reason: "PAYLOAD_HASH_MISMATCH", reasonPlain: "This entry's contents changed after it was written." });
    expect(outcome.rows.map((r) => r.failed)).toEqual([null, null, "PAYLOAD_HASH_MISMATCH", null, null]);

    // The server, given the same forged row, says the same thing.
    const entry = ledger[2];
    if (entry === undefined) throw new Error("row missing");
    const forged = { ...entry, payload: JSON.parse(change.rows[2]?.payloadText ?? "null") as unknown };
    expect(checkEntry(forged, ledger[1]?.entryHash ?? null)).toMatchObject({ payloadIntact: false, fieldsIntact: true, linked: true });
    expect(checkEntry(entry, ledger[1]?.entryHash ?? null)).toMatchObject({ payloadIntact: true, fieldsIntact: true, linked: true });
    // And the untouched rows still verify.
    expect((await lib.verifyRows(rows)).ok).toBe(true);
    // Nothing was written anywhere.
    expect(JSON.stringify(await stored(), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).toBe(JSON.stringify(ledger, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
  });

  it("with no amount it can rehash, changes the first row's time, which breaks that row's entry hash", async () => {
    await write("trc_refused", "2026-11-09T10:00:00.129Z", "agent", "intent", { intent_id: "trc_refused", mandate_id: "m", signed_mandate: { document: {}, signature: {} }, public_key_pem: "pem" });
    await write("trc_refused", "2026-11-09T10:00:01.000Z", "praman", "decision", { mandate_id: "m", kind: "DENY", reason_code: "MANDATE_BUDGET_EXHAUSTED", detail: "over", redaction_salt: "aa" });
    const ledger = await stored();
    const rows = rowsOnPage((await renderTracePage("trc_refused")).html);
    const change = lib.tamperOneDigit(rows);
    expect(change).toMatchObject({ seq: "1", field: "ts", before: "2026-11-09T10:00:00.129Z", after: "2026-11-09T10:00:00.120Z" });
    const outcome = await lib.verifyRows(change?.rows ?? []);
    expect(outcome).toMatchObject({ ok: false, brokenAt: "1", reason: "ENTRY_HASH_MISMATCH" });

    const entry = ledger[0];
    if (entry === undefined) throw new Error("row missing");
    expect(checkEntry({ ...entry, ts: new Date("2026-11-09T10:00:00.120Z") }, GENESIS_HASH)).toMatchObject({ payloadIntact: true, fieldsIntact: false });
  });

  it("reports a forged link before anything else, as the server's walk does", async () => {
    await writeTrace();
    const rows = rowsOnPage((await renderTracePage("trc_verify")).html);
    const forged = rows.map((r, i) => (i === 3 ? { ...r, prevHash: "f".repeat(64) } : r));
    expect(await lib.verifyRows(forged)).toMatchObject({ ok: false, brokenAt: "4", reason: "PREV_MISMATCH" });
    // A forger who rewrites a row and its hashes still can't make the next row link to it.
    const rewritten = rows.map((r, i) => (i === 2 ? { ...r, entryHash: "e".repeat(64) } : r));
    expect(await lib.verifyRows(rewritten)).toMatchObject({ ok: false, brokenAt: "3", reason: "ENTRY_HASH_MISMATCH" });
  });

  it("has nothing to change in an empty list", () => {
    expect(lib.tamperOneDigit([])).toBeNull();
  });
});

describe("the scripts themselves", () => {
  const NETWORK = /fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|\.src\s*=|location\s*[.=]|window\.open|\.submit\s*\(/;

  it("the hashing script can't reach the network or the page", () => {
    expect(LIB_SOURCE).not.toMatch(NETWORK);
    expect(LIB_SOURCE).not.toMatch(/document\.|innerHTML|eval\(|new Function/);
    expect(lib.available()).toBe(true);
  });

  it("the trace page's browser check makes no request and writes only text", () => {
    const [serverCheck, browserCheck] = TRACE_SOURCE.split('// "Verify in my browser".');
    if (serverCheck === undefined || browserCheck === undefined) throw new Error("the browser check's block is not where the test expects it");
    // The one request on the page is the server's own check, in the block above.
    expect(serverCheck.match(/fetch\s*\(/g)).toHaveLength(1);
    expect(browserCheck).not.toMatch(NETWORK);
    expect(TRACE_SOURCE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  it("is served as a file from this origin, so the page's policy needs no change", async () => {
    expect(ASSETS.get("/assets/chain-verify.js")?.body).toBe(LIB_SOURCE);
    await write("trc_page", "2026-11-09T10:00:00.000Z", "agent", "intent", { intent_id: "trc_page", mandate_id: "m" });
    const { html } = await renderTracePage("trc_page");
    expect(html).toContain('<script src="/assets/chain-verify.js" defer></script>');
    expect(html).toContain('id="browser-verify" hidden');
    expect(html).toContain("Verify in my browser");
    expect(html).not.toMatch(/<script>|<style>| style="| on[a-z]+="/);
  });
});
