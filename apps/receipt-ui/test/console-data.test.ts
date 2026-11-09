import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append, GENESIS_HASH, type EventType } from "@praman/ledger";
import { checkEntry, countActors, countDecisions, countRails, loadConsoleData, spendTimeline, summariseChain, whoOf, type ConsoleEntry, type ConsoleRow } from "../src/console/data.js";

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
    who: "system",
    whoPlain: "System",
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
    refundId: null,
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

  it("counts a captured order whose money went back as refunded, and one with a refund still open as captured", () => {
    const rails = countRails([
      row({ eventType: "outcome", rail: "paypal", status: "captured", orderId: "A" }),
      row({ eventType: "refund_requested", rail: "paypal", status: "attempted", orderId: "A" }),
      row({ eventType: "refund_outcome", rail: "paypal", status: "refunded", orderId: "A" }),
      row({ eventType: "outcome", rail: "paypal", status: "captured", orderId: "B" }),
      row({ eventType: "refund_outcome", rail: "paypal", status: "pending", orderId: "B" }),
      row({ eventType: "outcome", rail: "paypal", status: "captured", orderId: "C" }),
      row({ eventType: "refund_outcome", rail: "paypal", status: "failed", orderId: "C" }),
    ]);
    expect(rails).toEqual([{ rail: "paypal", statuses: { refunded: 1, captured: 2 } }]);
  });
});

describe("the console on a refunded purchase (D-66, D-67)", () => {
  it("shows the refund rows with their status and refund id, and the spend line doesn't move", async () => {
    await paidPurchase("trc_mine", "mnd_mine", "450", "ORD1");
    const refund = { mandate_id: "mnd_mine", merchant_id: "DEMO_CAFE", idempotency_key: "key_trc_mine", order_id: "ORD1", payment_id: "CAP_ORD1", refund_key: "r".repeat(64), rail: "paypal", amount_minor: "450", currency: "USD" };
    await event("trc_mine", "refund_requested", { ...refund, operation: "captures.refund", status: "attempted", requested_by: "demo_visitor" }, "demo_visitor");
    await event("trc_mine", "refund_outcome", { ...refund, status: "refunded", refund_id: "2JV473619H1766245", failure_code: null }, "praman");

    const data = await loadConsoleData({ kind: "mandates", mandateIds: ["mnd_mine"] }, new Map([["mnd_mine", { maxTotalMinor: "6000", currency: "USD" }]]), T);
    expect(data.rows.find((r) => r.eventType === "refund_requested")).toMatchObject({ status: "attempted", actor: "demo_visitor", amount: "$4.50", eventPlain: "A person asked for a refund, and the payment provider was called", refundId: null });
    expect(data.rows.find((r) => r.eventType === "refund_outcome")).toMatchObject({ status: "refunded", refundId: "2JV473619H1766245", captureId: "CAP_ORD1", orderId: "ORD1", eventPlain: "Refund result recorded" });
    expect(data.rails).toEqual([{ rail: "paypal", statuses: { refunded: 1 } }]);

    // The budget still counts it: the line ends where deriveState says, and the refund added no point.
    const [spend] = data.spend;
    expect(spend).toMatchObject({ spentNowMinor: "450" });
    expect(spend?.points.map((p) => p.heldMinor)).toEqual(["450"]);
  });
});

describe("who did what", () => {
  it("reads the stored actor, and counts the test harness apart only on a trace whose intent says so", () => {
    expect(whoOf("agent", "intent", false)).toBe("agent");
    expect(whoOf("praman", "decision", false)).toBe("praman");
    for (const person of ["issuer", "operator", "demo_visitor"]) expect(whoOf(person, "refund_requested", false)).toBe("person");
    expect(whoOf("webhook", "settlement", false)).toBe("provider");
    expect(whoOf("reconciler", "outcome", false)).toBe("reconciler");
    expect(whoOf("system", "checkpoint", false)).toBe("system");
    // An actor nothing here writes is not guessed at, and a name from Object's prototype is no exception.
    expect(whoOf("someone_new", "outcome", false)).toBe("other");
    expect(whoOf("constructor", "outcome", false)).toBe("other");

    // The harness's proposal and its own approval. What Praman did on that trace is still Praman's.
    expect(whoOf("agent", "intent", true)).toBe("harness");
    expect(whoOf("issuer", "step_up_resolved", true)).toBe("harness");
    expect(whoOf("praman", "decision", true)).toBe("praman");
    expect(whoOf("demo_visitor", "refund_requested", true)).toBe("person");
    expect(whoOf("issuer", "mandate_revoked", true)).toBe("person");
  });

  it("counts a session's rows by who wrote them and what they record, in the order a purchase runs", async () => {
    const m = { mandate_id: "mnd_mine" };
    // A model's purchase that needed a person, was paid, settled and later refunded.
    await event("trc_a", "intent", { ...m, intent_id: "trc_a", merchant_id: "DEMO_CAFE", model_id: "some-model" }, "agent");
    await event("trc_a", "decision", { ...m, kind: "STEP_UP", reason_code: "STEP_UP_THRESHOLD" }, "praman");
    await event("trc_a", "step_up_resolved", { ...m, verdict: "approve" }, "issuer");
    await event("trc_a", "api_call", { ...m, rail: "paypal", status: "attempted", idempotency_key: "k", amount_minor: "450", currency: "USD" }, "praman");
    await event("trc_a", "outcome", { ...m, rail: "paypal", status: "captured", idempotency_key: "k", order_id: "A", amount_minor: "450", currency: "USD" }, "praman");
    await event("trc_a", "agent_transcript", { evidence_only: true, transcript: [] }, "agent");
    await event("trc_a", "settlement", { ...m, status: "captured", order_id: "A" }, "webhook");
    await event("trc_a", "refund_requested", { ...m, status: "attempted", order_id: "A", requested_by: "demo_visitor" }, "demo_visitor");
    await event("trc_a", "refund_outcome", { ...m, status: "refunded", order_id: "A", refund_id: "R1" }, "reconciler");
    // A second proposal, refused, and an actor this console has never heard of.
    await event("trc_b", "intent", { ...m, intent_id: "trc_b", merchant_id: "DEMO_CAFE", model_id: "some-model" }, "agent");
    await event("trc_b", "decision", { ...m, kind: "DENY", reason_code: "CATEGORY_OUT_OF_SCOPE" }, "praman");
    await event("trc_b", "outcome", { ...m, rail: "paypal", status: "failed" }, "someone_new");
    // The harness: it proposes and approves in code. Praman still decides.
    await event("trc_h", "intent", { ...m, intent_id: "trc_h", merchant_id: "DEMO_HARNESS", model_id: "harness/no-model" }, "agent");
    await event("trc_h", "decision", { ...m, kind: "STEP_UP", reason_code: "STEP_UP_FIRST_MERCHANT" }, "praman");
    await event("trc_h", "step_up_resolved", { ...m, verdict: "approve" }, "issuer");
    // The person takes the mandate back.
    await event("trc_revoke", "mandate_revoked", { ...m, reason: "done" }, "issuer");

    const data = await loadConsoleData({ kind: "mandates", mandateIds: ["mnd_mine"] }, new Map(), T);

    expect(data.actors.map((a) => [a.whoPlain, a.did, a.rows])).toEqual([
      ["Agent", "proposed a purchase", 2],
      ["Agent", "had its tool calls recorded", 1],
      ["Praman", "decided", 3],
      ["Praman", "called the payment provider", 1],
      ["Praman", "recorded a payment result", 1],
      ["Person", "answered a request for approval", 1],
      ["Person", "revoked a mandate", 1],
      ["Person", "asked for a refund", 1],
      ["Provider webhook", "reported the final result", 1],
      ["Reconciler", "recorded a refund result", 1],
      ["Test harness", "proposed a purchase", 1],
      ["Test harness", "answered a request for approval", 1],
      ["someone_new (as stored)", "recorded a payment result", 1],
    ]);
    // Every row is counted once, and a bar names what the grid's two columns hold on its rows.
    expect(data.actors.reduce((n, a) => n + a.rows, 0)).toBe(data.rows.length);
    for (const bar of data.actors) {
      const own = data.rows.filter((r) => r.whoPlain === bar.whoPlain && r.eventPlain === bar.eventPlain);
      expect(own.length, `${bar.whoPlain}: ${bar.did}`).toBe(bar.rows);
      expect([...new Set(own.map((r) => r.actor))].sort()).toEqual(bar.actors);
      expect(own.every((r) => r.who === bar.who && r.eventType === bar.eventType)).toBe(true);
    }
    // The harness's own approval is never called a human review, in the grid's Event column or on its bar (D-53).
    expect(data.actors.find((a) => a.who === "harness" && a.eventType === "step_up_resolved")).toMatchObject({ actors: ["issuer"], eventPlain: "Test harness approved the step-up. No person reviewed it" });
    expect(data.rows.find((r) => r.traceId === "trc_h" && r.eventType === "step_up_resolved")).toMatchObject({ actor: "issuer", eventPlain: "Test harness approved the step-up. No person reviewed it" });
    expect(data.rows.find((r) => r.traceId === "trc_a" && r.eventType === "step_up_resolved")).toMatchObject({ actor: "issuer", eventPlain: "Human reviewed the step-up" });
    expect(data.rows.filter((r) => r.who !== "person").map((r) => r.eventPlain).join(" ")).not.toMatch(/human/i);
    expect(data.actors.find((a) => a.who === "person" && a.eventType === "refund_requested")).toMatchObject({ actors: ["demo_visitor"] });
    // The stored actor is still on the row, untouched: the entry hash covers it.
    expect(data.rows.find((r) => r.traceId === "trc_h" && r.eventType === "intent")).toMatchObject({ actor: "agent", who: "harness", whoPlain: "Test harness", hashVerdict: "intact" });
    // The agent has no row that decides, calls a provider or records a result.
    expect(data.actors.filter((a) => a.who === "agent").map((a) => a.eventType)).toEqual(["intent", "agent_transcript"]);
  });

  it("puts an event type it doesn't know last under its actor, named as stored", () => {
    const row = (over: Partial<ConsoleRow>): ConsoleRow => ({
      seq: "1", ts: T.toISOString(), traceId: "t", actor: "praman", who: "praman", whoPlain: "Praman", eventType: "decision", eventPlain: "Policy engine decided", mandateId: "m", mandateClaimed: false, merchantId: null, rail: null,
      amountMinor: "999999", currency: "USD", amount: "$9,999.99", decision: null, status: null, reasonCode: null, reasonPlain: null, orderId: null, captureId: null, refundId: null, prevHash: "", payloadHash: "", entryHash: "",
      check: { payloadIntact: true, fieldsIntact: true, linked: true, recomputedPayloadHash: "", recomputedEntryHash: "" }, hashVerdict: "intact", chainVerified: true,
      ...over,
    });
    const counts = countActors([row({ eventType: "something_new", eventPlain: "something_new" }), row({}), row({}), row({ actor: "agent", who: "agent", whoPlain: "Agent", eventType: "intent", eventPlain: "Agent proposed a purchase" })]);
    expect(counts).toEqual([
      { who: "agent", whoPlain: "Agent", eventType: "intent", eventPlain: "Agent proposed a purchase", did: "proposed a purchase", actors: ["agent"], rows: 1 },
      { who: "praman", whoPlain: "Praman", eventType: "decision", eventPlain: "Policy engine decided", did: "decided", actors: ["praman"], rows: 2 },
      { who: "praman", whoPlain: "Praman", eventType: "something_new", eventPlain: "something_new", did: "something_new", actors: ["praman"], rows: 1 },
    ]);
    // Rows are counted. No amount is read or added.
    expect(JSON.stringify(counts)).not.toContain("9999");
    expect(countActors([])).toEqual([]);
  });

  it("still knows a harness trace when the operator's newest rows start after its intent", async () => {
    await event("trc_h", "intent", { mandate_id: "mnd_h", intent_id: "trc_h", merchant_id: "DEMO_HARNESS", model_id: "harness/no-model" }, "agent");
    await event("trc_p", "intent", { mandate_id: "mnd_p", intent_id: "trc_p", merchant_id: "DEMO_CAFE", model_id: "some-model" }, "agent");
    await event("trc_h", "decision", { mandate_id: "mnd_h", kind: "STEP_UP", reason_code: "STEP_UP_FIRST_MERCHANT" }, "praman");
    await event("trc_p", "decision", { mandate_id: "mnd_p", kind: "STEP_UP", reason_code: "STEP_UP_THRESHOLD" }, "praman");
    await event("trc_h", "step_up_resolved", { mandate_id: "mnd_h", verdict: "approve" }, "issuer");
    await event("trc_p", "step_up_resolved", { mandate_id: "mnd_p", verdict: "approve" }, "issuer");

    const newest = await loadConsoleData({ kind: "all", limit: 2 }, new Map(), T);
    expect(newest.truncated).toBe(true);
    expect(newest.rows.map((r) => [r.traceId, r.actor, r.who])).toEqual([
      ["trc_h", "issuer", "harness"],
      ["trc_p", "issuer", "person"],
    ]);
    expect(newest.actors.map((a) => [a.whoPlain, a.rows])).toEqual([["Person", 1], ["Test harness", 1]]);
  });
});
