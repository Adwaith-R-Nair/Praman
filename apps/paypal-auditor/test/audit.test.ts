import { describe, expect, it } from "vitest";
import type { LedgerEntryRecord } from "@praman/ledger";
import { auditTrace, EXIT_MATCH, EXIT_MISMATCH, EXIT_NOT_AUDITED, exitCodeFor, renderReport, runAudit, type AuditDeps } from "../src/audit.js";
import type { ToolAnswer } from "../src/read-only-toolkit.js";
import { CAPTURE, denied, fakePayPal, httpError, intent, ok, openOrder, ORDER, outcome, paidOrder, paypalRefund, REFUND, refundOutcome, refundRequested, released, rows, TRACE, type FakePayPal } from "./fixtures.js";

function deps(ledger: readonly LedgerEntryRecord[], paypal: FakePayPal | null): AuditDeps {
  return { readTrace: (traceId) => Promise.resolve(traceId === TRACE ? ledger : []), paypal: () => paypal };
}

const captured = rows(intent, outcome("created"), outcome("captured"));

async function run(ledger: readonly LedgerEntryRecord[], paypal: FakePayPal | null): Promise<{ exitCode: number; text: string }> {
  const result = await runAudit(deps(ledger, paypal), TRACE, null);
  return { exitCode: result.exitCode, text: result.lines.join("\n") };
}

describe("auditTrace", () => {
  it("prints MATCH for each field and overall, and exits 0, when the two records agree", async () => {
    const paypal = fakePayPal({ order: ok(paidOrder()) });
    const { exitCode, text } = await run(captured, paypal);
    expect(exitCode).toBe(EXIT_MATCH);
    for (const field of ["order_id", "status", "amount_minor", "currency", "capture_id", "refund_state"]) {
      expect(text).toMatch(new RegExp(`^  ${field} .* MATCH$`, "m"));
    }
    expect(text).toContain("Overall: MATCH. 6 of 6 fields agree.");
    expect(text).not.toContain("MISMATCH");
  });

  it("only ever reads: one order, the disputes on its capture, and a refund when the ledger names one", async () => {
    const paypal = fakePayPal({ order: ok(paidOrder()) });
    await run(captured, paypal);
    expect(paypal.calls).toEqual([`get_order ${ORDER}`, `list_disputes ${CAPTURE}`]);

    const refunded = fakePayPal({ order: ok(paidOrder({ captureStatus: "REFUNDED", refunds: [paypalRefund()] })), refund: ok(paypalRefund()) });
    const result = await run([...captured, ...rows(refundRequested(), refundOutcome("refunded"))], refunded);
    expect(refunded.calls).toEqual([`get_order ${ORDER}`, `get_refund ${REFUND}`, `list_disputes ${CAPTURE}`]);
    expect(result.exitCode).toBe(EXIT_MATCH);
    expect(result.text).toContain("Overall: MATCH. 7 of 7 fields agree.");
  });

  it("prints MISMATCH for the field that differs and overall, and exits 1", async () => {
    const { exitCode, text } = await run(captured, fakePayPal({ order: ok(paidOrder({ value: "99.00" })) }));
    expect(exitCode).toBe(EXIT_MISMATCH);
    expect(text).toMatch(/^  amount_minor +3200 +9900 +MISMATCH$/m);
    expect(text).toMatch(/^  currency .* MATCH$/m);
    expect(text).toContain("Overall: MISMATCH. 1 of 6 fields differ: amount_minor.");
  });

  it("exits 1 when PayPal captured an order the ledger only shows as created", async () => {
    const { exitCode, text } = await run(rows(intent, outcome("created")), fakePayPal({ order: ok(paidOrder()) }));
    expect(exitCode).toBe(EXIT_MISMATCH);
    expect(text).toContain("2 of 6 fields differ: status, capture_id.");
  });

  it("exits 1 when PayPal has no order the ledger records as captured", async () => {
    const { exitCode, text } = await run(captured, fakePayPal({ order: httpError(404) }));
    expect(exitCode).toBe(EXIT_MISMATCH);
    expect(text).toMatch(/^  order_id .* no order with this id +MISMATCH$/m);
  });

  it("exits 2, not 0, when nothing could be compared", async () => {
    const cases: [readonly LedgerEntryRecord[], FakePayPal | null, RegExp][] = [
      [[], fakePayPal(), /No ledger rows have this trace id/],
      [rows(intent, denied), fakePayPal(), /This trace has no order/],
      [rows(intent, outcome("created", { rail: "razorpay", order_id: "order_Qx1", currency: "INR", amount_minor: "52000" })), fakePayPal(), /on the razorpay rail, and the auditor reads PayPal only/],
      [rows(intent, outcome("captured", { rail: "simulated", order_id: "sim_1" })), fakePayPal(), /on the simulated rail/],
      [captured, null, /PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set/],
      [captured, fakePayPal({ order: httpError(401) }), /PayPal could not be read: get_order answered HTTP 401/],
      [captured, fakePayPal({ order: { kind: "error", status: null, code: "NO_ANSWER" } }), /get_order answered NO_ANSWER/],
      [rows(intent, outcome("created")), fakePayPal({ order: httpError(404) }), /PayPal has no order with this id, and the ledger records no capture on it/],
      [rows(intent, outcome("created"), released), fakePayPal({ order: httpError(404) }), /nothing to compare/],
      [rows(outcome("created", { amount_minor: "32.00" })), fakePayPal({ order: ok(openOrder()) }), /A ledger row on this trace can't be read/],
      [[...captured, ...rows(refundOutcome("refunded"))], fakePayPal({ order: ok(paidOrder()), refund: httpError(500) }), /get_refund answered HTTP 500/],
    ];
    for (const [ledger, paypal, message] of cases) {
      const { exitCode, text } = await run(ledger, paypal);
      expect(text).toMatch(message);
      expect(exitCode).toBe(EXIT_NOT_AUDITED);
      expect(text).toContain("Not audited:");
      expect(text).not.toMatch(/Overall|MATCH/);
    }
  });

  it("does not call PayPal for a trace on another rail, or with no order", async () => {
    const paypal = fakePayPal({ order: ok(paidOrder()) });
    await run(rows(intent, denied), paypal);
    await run(rows(outcome("created", { rail: "razorpay", order_id: "order_Qx1" })), paypal);
    await run([], paypal);
    expect(paypal.calls).toEqual([]);
  });

  it("does not send an order id from the ledger that isn't a plain id", async () => {
    // readerOver refuses it before the toolkit; here the fake stands in for that refusal.
    const refused: ToolAnswer = { kind: "error", status: null, code: "ID_NOT_SENT" };
    const { exitCode, text } = await run(rows(outcome("captured", { order_id: "X/../capture" })), fakePayPal({ order: refused }));
    expect(exitCode).toBe(EXIT_NOT_AUDITED);
    expect(text).toContain("get_order answered ID_NOT_SENT");
  });

  it("prints no control character a ledger row holds, so ledger text can't forge a verdict line or move the cursor", async () => {
    // The ledger's capture id is PayPal's text, copied when the capture was recorded, and paypal-exec keeps any non-empty string.
    const hostile = "1DA\u001b[2J\nOverall: MATCH. 6 of 6 fields agree.";
    const { exitCode, text } = await run(rows(intent, outcome("captured", { payment_id: hostile })), fakePayPal({ order: ok(paidOrder()) }));
    expect(exitCode).toBe(EXIT_MISMATCH);
    expect(text).not.toContain("\u001b");
    expect(text.split("\n").filter((line) => line.startsWith("Overall:"))).toEqual(["Overall: MISMATCH. 1 of 6 fields differ: capture_id."]);

    // The same for a row that can't be read: the reason repeats the ledger's own text.
    const unreadable = await run(rows(outcome("created", { currency: "\u001b[2J\nOverall: MATCH." })), fakePayPal());
    expect(unreadable.exitCode).toBe(EXIT_NOT_AUDITED);
    expect(unreadable.text).toContain("A ledger row on this trace can't be read");
    expect(unreadable.text).not.toContain("\u001b");
    expect(unreadable.text.split("\n").filter((line) => line.startsWith("Overall"))).toEqual([]);
  });

  it("audits every PayPal order on a trace, and one mismatch makes the whole trace a mismatch", async () => {
    const two = rows(outcome("captured"), outcome("created", { order_id: "ANOTHERORDER00001" }));
    const paypal = fakePayPal({ order: ok(paidOrder()) });
    const { exitCode, text } = await run(two, paypal);
    expect(paypal.calls.filter((c) => c.startsWith("get_order"))).toEqual([`get_order ${ORDER}`, "get_order ANOTHERORDER00001"]);
    expect(text).toContain(`Order ${ORDER}`);
    expect(text).toContain("Order ANOTHERORDER00001");
    expect(exitCode).toBe(EXIT_MISMATCH);
  });

  it("shows disputes without letting them change the verdict", async () => {
    const dispute = { dispute_id: "PP-D-12345", status: "OPEN", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", dispute_life_cycle_stage: "INQUIRY", dispute_amount: { currency_code: "USD", value: "32.00" } };
    const withDispute = fakePayPal({ order: ok(paidOrder()), disputeList: ok({ items: [{ dispute_id: "PP-D-12345" }] }), dispute: ok(dispute) });
    const listed = await run(captured, withDispute);
    expect(withDispute.calls).toEqual([`get_order ${ORDER}`, `list_disputes ${CAPTURE}`, "get_dispute PP-D-12345"]);
    expect(listed.text).toContain("PP-D-12345 OPEN, reason MERCHANDISE_OR_SERVICE_NOT_RECEIVED, stage INQUIRY, 3200 minor units USD");
    expect(listed.exitCode).toBe(EXIT_MATCH);

    const unreadable = await run(captured, fakePayPal({ order: ok(paidOrder()), disputeList: httpError(403) }));
    expect(unreadable.text).toContain("not read, list_disputes answered HTTP 403");
    expect(unreadable.exitCode).toBe(EXIT_MATCH);

    const none = await run(captured, fakePayPal({ order: ok(paidOrder()) }));
    expect(none.text).toMatch(/disputes at PayPal on this capture \(shown, not compared.*\): none$/m);
  });

  it("derives the exit code from the report and nothing else", async () => {
    const match = await auditTrace(deps(captured, fakePayPal({ order: ok(paidOrder()) })), TRACE);
    const mismatch = await auditTrace(deps(captured, fakePayPal({ order: ok(paidOrder({ currency: "INR" })) })), TRACE);
    const none = await auditTrace(deps([], fakePayPal()), TRACE);
    expect([match.kind, exitCodeFor(match)]).toEqual(["AUDITED", 0]);
    expect([mismatch.kind, exitCodeFor(mismatch)]).toEqual(["AUDITED", 1]);
    expect([none.kind, exitCodeFor(none)]).toEqual(["NOT_AUDITED", 2]);
    expect(renderReport(none)).toEqual([`PayPal audit of trace ${TRACE}`, "Not audited: No ledger rows have this trace id.", "Nothing was compared. This is neither a pass nor a fail."]);
  });
});
