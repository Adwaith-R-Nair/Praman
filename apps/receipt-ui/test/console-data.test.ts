import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append, GENESIS_HASH, type EventType } from "@praman/ledger";
import { checkEntry, countDecisions, countRails, loadConsoleData, spendTimeline, summariseChain, type ConsoleEntry, type ConsoleRow } from "../src/console/data.js";

// Runs against TEST_DATABASE_URL (see vitest.config.ts), never the real one.
beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record RESTART IDENTITY`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const T = new Date("2026-11-08T10:00:00.000Z");
let minute = 0;
const at = () => new Date(T.getTime() + (minute += 1) * 60_000);

async function event(traceId: string, eventType: EventType, payload: Record<string, unknown>, actor = "system"): Promise<void> {
  await prisma.$transaction((tx) => append(tx, { traceId, ts: at(), actor, eventType, payload }));
}

/** One paid purchase under a mandate, the way runIntent writes it: intent, decision, the call, the outcome. */
async function paidPurchase(traceId: string, mandateId: string, amount: string, orderId: string, status = "captured"): Promise<void> {
  const key = `key_${traceId}`;
  await event(traceId, "intent", { intent_id: traceId, mandate_id: mandateId, merchant_id: "DEMO_CAFE", line_items: [{ sku: "SKU_CAFE_COFFEE", qty: 1 }], agent_rationale: "coffee" }, "agent");
  await event(traceId, "decision", { mandate_id: mandateId, kind: "ALLOW", reason_code: "OK", amount_minor: amount, currency: "USD" });
  await event(traceId, "api_call", { mandate_id: mandateId, merchant_id: "DEMO_CAFE", rail: "paypal", status: "attempted", idempotency_key: key, amount_minor: amount, currency: "USD" });
  await event(traceId, "outcome", { mandate_id: mandateId, merchant_id: "DEMO_CAFE", rail: "paypal", status, idempotency_key: key, order_id: orderId, payment_id: status === "captured" ? `CAP_${orderId}` : null, amount_minor: amount, currency: "USD" });
}

const rowsOf = async () => (await prisma.ledgerEntry.findMany({ orderBy: { seq: "asc" } })) satisfies ConsoleEntry[];

describe("checkEntry", () => {
  it("finds an untouched row intact and linked to the row before it", async () => {
    await paidPurchase("trc_a", "mnd_a", "450", "ORD1");
    const [first, second] = await rowsOf();
    if (first === undefined || second === undefined) throw new Error("no rows");
    expect(checkEntry(first, GENESIS_HASH)).toMatchObject({ payloadIntact: true, fieldsIntact: true, linked: true });
    expect(checkEntry(second, first.entryHash)).toMatchObject({ payloadIntact: true, fieldsIntact: true, linked: true, recomputedEntryHash: second.entryHash });
  });

  it("catches a payload changed after it was written", async () => {
    await paidPurchase("trc_a", "mnd_a", "450", "ORD1");
    const [, decision] = await rowsOf();
    if (decision === undefined) throw new Error("no row");
    const forged = { ...decision, payload: { mandate_id: "mnd_a", kind: "ALLOW", reason_code: "OK", amount_minor: "45", currency: "USD" } };
    expect(checkEntry(forged, null)).toMatchObject({ payloadIntact: false, linked: null });
  });

  it("catches changed fields, a broken link, and a hash that can't even be computed", async () => {
    await paidPurchase("trc_a", "mnd_a", "450", "ORD1");
    const [first, second] = await rowsOf();
    if (first === undefined || second === undefined) throw new Error("no rows");
    expect(checkEntry({ ...second, actor: "someone_else" }, first.entryHash)).toMatchObject({ payloadIntact: true, fieldsIntact: false });
    expect(checkEntry(second, "f".repeat(64))).toMatchObject({ fieldsIntact: true, linked: false });
    expect(checkEntry({ ...second, prevHash: "not a hash" }, first.entryHash)).toMatchObject({ fieldsIntact: false, recomputedEntryHash: null });
  });
});

describe("summariseChain", () => {
  it("says where a chain broke, in words", () => {
    expect(summariseChain({ ok: false, brokenAt: 7n, reason: "PAYLOAD_HASH_MISMATCH", detail: "x" })).toMatchObject({ ok: false, brokenAtSeq: "7", breakReason: "PAYLOAD_HASH_MISMATCH", breakReasonPlain: "This entry's contents changed after it was written." });
    expect(summariseChain({ ok: true, checked: 3, head: "h" })).toEqual({ ok: true, checked: 3, head: "h", brokenAtSeq: null, breakReason: null, breakReasonPlain: null });
  });
});

describe("loadConsoleData for a visitor's mandates", () => {
  it("shows every row of the traces naming those mandates, the revocation included, and nobody else's", async () => {
    await paidPurchase("trc_mine", "mnd_mine", "450", "ORD1");
    await paidPurchase("trc_theirs", "mnd_theirs", "1250", "ORD2");
    await event("trc_mine_revoke", "mandate_revoked", { mandate_id: "mnd_mine", reason: "done with it" }, "issuer");
    await event("trc_mine_after", "intent", { intent_id: "x", mandate_id: "mnd_mine", merchant_id: "DEMO_CAFE", line_items: [], agent_rationale: "again" }, "agent");
    await event("trc_mine_after", "decision", { mandate_id: "mnd_mine", kind: "DENY", reason_code: "MANDATE_REVOKED" });

    const data = await loadConsoleData({ kind: "mandates", mandateIds: ["mnd_mine"] }, new Map([["mnd_mine", { maxTotalMinor: "6000", currency: "USD" }]]), T);

    expect(new Set(data.rows.map((r) => r.traceId))).toEqual(new Set(["trc_mine", "trc_mine_revoke", "trc_mine_after"]));
    expect(data.rows.every((r) => r.mandateId === "mnd_mine")).toBe(true);
    expect(data.rows.every((r) => r.hashVerdict === "intact" && r.chainVerified)).toBe(true);
    expect(data.chain).toMatchObject({ ok: true, checked: 11 });

    const revoked = data.rows.find((r) => r.eventType === "mandate_revoked");
    expect(revoked).toMatchObject({ decision: "REVOKED", eventPlain: "Mandate revoked", actor: "issuer" });
    expect(data.rows.find((r) => r.reasonCode === "MANDATE_REVOKED")).toMatchObject({ decision: "DENY", reasonPlain: "This mandate has been revoked." });

    const outcome = data.rows.find((r) => r.eventType === "outcome");
    expect(outcome).toMatchObject({ amountMinor: "450", currency: "USD", amount: "$4.50", rail: "paypal", status: "captured", orderId: "ORD1", captureId: "CAP_ORD1" });
    // The decision row names no merchant; the trace's intent does.
    expect(data.rows.find((r) => r.traceId === "trc_mine" && r.eventType === "decision")?.merchantId).toBe("DEMO_CAFE");

    expect(data.spend).toEqual([
      expect.objectContaining({ mandateId: "mnd_mine", currency: "USD", budgetMinor: "6000", budgetLabel: "$60.00", spentNowMinor: "450", spentNowLabel: "$4.50", revoked: true }),
    ]);
  });

  it("sends ids, codes, amounts and hashes, never a payload, a transcript or merchant text", async () => {
    await paidPurchase("trc_mine", "mnd_mine", "450", "ORD1");
    await event("trc_mine", "agent_transcript", { transcript: [{ role: "tool_results", results: [{ id: "c", name: "list_catalog", content: "<untrusted_merchant_content>\n<script>alert(1)</script>\n</untrusted_merchant_content>" }] }] });
    const data = await loadConsoleData({ kind: "mandates", mandateIds: ["mnd_mine"] }, new Map(), T);
    const json = JSON.stringify(data);
    expect(json).not.toContain("<script>");
    expect(json).not.toContain("untrusted_merchant_content");
    expect(json).not.toContain("coffee");
    expect(json).not.toContain("payload\"");
  });

  it("shows nothing for a visitor with no rows yet", async () => {
    await paidPurchase("trc_theirs", "mnd_theirs", "1250", "ORD2");
    const data = await loadConsoleData({ kind: "mandates", mandateIds: ["mnd_new"] }, new Map(), T);
    expect(data.rows).toEqual([]);
    expect(data.chain.ok).toBe(true);
  });
});

describe("loadConsoleData for a local operator", () => {
  it("shows the newest rows of the whole ledger and says when there were more", async () => {
    await paidPurchase("trc_mine", "mnd_mine", "450", "ORD1");
    await paidPurchase("trc_theirs", "mnd_theirs", "1250", "ORD2");
    const all = await loadConsoleData({ kind: "all", limit: 100 }, new Map(), T);
    expect(all.rows).toHaveLength(8);
    expect(all.truncated).toBe(false);
    expect(all.spend.map((s) => s.mandateId).sort()).toEqual(["mnd_mine", "mnd_theirs"]);
    expect(all.spend.every((s) => s.budgetMinor === null && s.currency === "USD")).toBe(true);

    const some = await loadConsoleData({ kind: "all", limit: 3 }, new Map(), T);
    expect(some.rows.map((r) => r.seq)).toEqual(["6", "7", "8"]);
    expect(some.truncated).toBe(true);
    // Each row still checks its link to the row before it, though that row isn't shown.
    expect(some.rows.every((r) => r.check.linked === true)).toBe(true);
  });
});

describe("spendTimeline", () => {
  const entry = (seq: number, eventType: string, payload: Record<string, unknown>, traceId = "t"): ConsoleEntry => ({
    seq: BigInt(seq),
    traceId,
    ts: new Date(T.getTime() + seq * 1000),
    actor: "system",
    eventType,
    payload,
    payloadHash: "",
    prevHash: "",
    entryHash: "",
  });

  it("holds an attempted call, counts an order once across its outcomes, and gives a release back", () => {
    const points = spendTimeline(
      [
        entry(1, "api_call", { status: "attempted", idempotency_key: "k1", amount_minor: "1250", currency: "USD" }),
        entry(2, "outcome", { status: "captured", idempotency_key: "k1", order_id: "A", amount_minor: "1250", currency: "USD" }),
        entry(3, "api_call", { status: "attempted", idempotency_key: "k2", amount_minor: "3200", currency: "USD" }),
        entry(4, "outcome", { status: "created", idempotency_key: "k2", order_id: "B", amount_minor: "3200", currency: "USD" }),
        entry(5, "api_call", { status: "attempted", operation: "orders.capture", idempotency_key: "k2c", amount_minor: "3200", currency: "USD" }),
        entry(6, "outcome", { status: "released", idempotency_key: "k2", order_id: "B", currency: "USD" }),
      ],
      "USD",
    );
    expect(points.map((p) => [p.seq, p.heldMinor])).toEqual([
      ["1", "1250"],
      ["3", "4450"],
      ["6", "1250"],
    ]);
    expect(points.at(-1)?.label).toBe("$12.50");
  });
});

describe("countDecisions and countRails", () => {
  const row = (over: Partial<ConsoleRow>): ConsoleRow => ({
    seq: "1",
    ts: T.toISOString(),
    traceId: "t",
    actor: "system",
    eventType: "decision",
    eventPlain: "",
    mandateId: "m",
    mandateClaimed: false,
    merchantId: null,
    rail: null,
    amountMinor: null,
    currency: null,
    amount: null,
    decision: null,
    status: null,
    reasonCode: null,
    reasonPlain: null,
    orderId: null,
    captureId: null,
    prevHash: "",
    payloadHash: "",
    entryHash: "",
    check: { payloadIntact: true, fieldsIntact: true, linked: true, recomputedPayloadHash: "", recomputedEntryHash: "" },
    hashVerdict: "intact",
    chainVerified: true,
    ...over,
  });

  it("counts decisions and capture re-checks by reason code and kind, most common first", () => {
    const counts = countDecisions([
      row({ decision: "ALLOW", reasonCode: "OK" }),
      row({ decision: "STEP_UP", reasonCode: "STEP_UP_FIRST_MERCHANT" }),
      row({ decision: "DENY", reasonCode: "MANDATE_BUDGET_EXHAUSTED" }),
      row({ decision: "DENY", reasonCode: "MANDATE_BUDGET_EXHAUSTED" }),
      row({ eventType: "capture_decision", decision: "DENY", reasonCode: "MANDATE_REVOKED" }),
      row({ eventType: "outcome", status: "captured", reasonCode: null }),
    ]);
    expect(counts[0]).toEqual({ reasonCode: "MANDATE_BUDGET_EXHAUSTED", reasonPlain: "This is over the mandate's total budget.", allow: 0, stepUp: 0, deny: 2 });
    expect(counts.map((c) => c.reasonCode)).toEqual(["MANDATE_BUDGET_EXHAUSTED", "MANDATE_REVOKED", "OK", "STEP_UP_FIRST_MERCHANT"]);
  });

  it("counts each order once, at its latest outcome, by rail", () => {
    const rails = countRails([
      row({ eventType: "outcome", rail: "paypal", status: "created", orderId: "A" }),
      row({ eventType: "outcome", rail: "paypal", status: "captured", orderId: "A" }),
      row({ eventType: "outcome", rail: "paypal", status: "released", orderId: "B" }),
      row({ eventType: "outcome", rail: "razorpay", status: "created", orderId: "C" }),
      row({ eventType: "outcome", rail: "simulated", status: "captured", orderId: "D" }),
      row({ eventType: "outcome", rail: "paypal", status: "failed", orderId: null, traceId: "t2" }),
    ]);
    expect(rails).toEqual([
      { rail: "paypal", statuses: { captured: 1, released: 1, failed: 1 } },
      { rail: "razorpay", statuses: { created: 1 } },
      { rail: "simulated", statuses: { captured: 1 } },
    ]);
  });
});
