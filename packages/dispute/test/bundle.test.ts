import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append, type EventType } from "@praman/ledger";
import { buildBundle } from "../src/bundle.js";

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record RESTART IDENTITY`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("buildBundle", () => {
  it("returns null for an unknown trace", async () => {
    const bundle = await prisma.$transaction((tx) => buildBundle(tx, "trc_nope"));
    expect(bundle).toBeNull();
  });

  it("assembles a full bundle for an executed purchase", async () => {
    const traceId = "trc_dispute_test";
    await prisma.$transaction(async (tx) => {
      await append(tx, {
        traceId,
        ts: new Date("2026-09-05T10:00:00.000Z"),
        actor: "agent",
        eventType: "intent",
        payload: {
          mandate_id: "mnd_test",
          merchant_id: "MERCH_001",
          agent_rationale: "two biryanis fit the budget",
          model_id: "test-model",
        },
      });
      await append(tx, {
        traceId,
        ts: new Date("2026-09-05T10:00:01.000Z"),
        actor: "praman",
        eventType: "decision",
        payload: { mandate_id: "mnd_test", kind: "ALLOW", reason_code: "OK", amount_minor: "52000" },
      });
      await append(tx, {
        traceId,
        ts: new Date("2026-09-05T10:00:02.000Z"),
        actor: "agent",
        eventType: "agent_transcript",
        payload: {
          evidence_only: true,
          transcript: [
            { role: "user", text: "Merchant: MERCH_001\nGoal: order lunch for two" },
            {
              role: "assistant",
              calls: [{ id: "c1", name: "list_catalog", input: {} }],
              text: "",
            },
            {
              role: "tool_results",
              results: [
                {
                  id: "c1",
                  name: "list_catalog",
                  content:
                    "sku=SKU_FOOD_002 category=food price_minor=26000 in_stock=true\n" +
                    "<untrusted_merchant_content>\nChicken Biryani\nDum-style biryani\n</untrusted_merchant_content>",
                },
              ],
            },
          ],
        },
      });
      await append(tx, {
        traceId,
        ts: new Date("2026-09-05T10:00:03.000Z"),
        actor: "praman",
        eventType: "outcome",
        payload: {
          mandate_id: "mnd_test",
          status: "captured",
          order_id: "order_x",
          amount_minor: "52000",
          merchant_id: "MERCH_001",
          idempotency_key: "idem_x",
        },
      });
    });

    const bundle = await prisma.$transaction((tx) => buildBundle(tx, traceId));
    expect(bundle).not.toBeNull();
    if (!bundle) throw new Error("unreachable");

    expect(bundle.trace_id).toBe(traceId);
    expect(bundle.mandate.id).toBe("mnd_test");
    expect(bundle.mandate.signature_verified).toBe(true);
    expect(bundle.authorisation.decision).toBe("ALLOW");
    expect(bundle.authorisation.amount_minor).toBe("52000");
    expect(bundle.authorisation.currency).toBe("INR");
    expect(bundle.agent.goal).toBe("order lunch for two");
    expect(bundle.agent.rationale).toBe("two biryanis fit the budget");
    expect(bundle.agent.tool_calls).toHaveLength(1);
    expect(bundle.agent.tool_calls[0]?.name).toBe("list_catalog");
    expect(bundle.merchant_content_read).toHaveLength(1);
    expect(bundle.merchant_content_read[0]).toEqual({
      sku: "SKU_FOOD_002",
      text: "Chicken Biryani\nDum-style biryani",
      marked_untrusted: true,
    });
    expect(bundle.execution).toEqual({ order_id: "order_x", status: "captured", idempotency_key: "idem_x", rail: null, failed: false, failure_code: null, rail_reported: null, paid_by: null });
    expect(bundle.approval).toBeNull();
    expect(bundle.chain.entries).toHaveLength(4);
    expect(bundle.chain.global_chain_ok).toBe(true);
    expect(bundle.chain.trace_fully_verified).toBe(true);
  });

  it("reports the currency a USD trace was recorded in", async () => {
    const traceId = "trace_dispute_usd";
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId,
        ts: new Date("2026-11-05T10:00:00.000Z"),
        actor: "praman",
        eventType: "outcome",
        payload: { mandate_id: "mnd_test", status: "captured", order_id: "order_u", amount_minor: "1250", currency: "USD" },
      }),
    );
    const bundle = await prisma.$transaction((tx) => buildBundle(tx, traceId));
    expect(bundle?.authorisation.amount_minor).toBe("1250");
    expect(bundle?.authorisation.currency).toBe("USD");
  });

  it("reads a transcript line that shows the currency next to the price", async () => {
    const traceId = "trace_dispute_line";
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId,
        ts: new Date("2026-11-05T10:00:00.000Z"),
        actor: "praman",
        eventType: "agent_transcript",
        payload: {
          transcript: [
            {
              role: "tool_results",
              results: [
                {
                  id: "c1",
                  name: "list_catalog",
                  content:
                    "sku=SKU_US_1 category=food price_minor=1250 currency=USD in_stock=true\n" +
                    "<untrusted_merchant_content>\nBurrito\nRice and beans\n</untrusted_merchant_content>",
                },
              ],
            },
          ],
        },
      }),
    );
    const bundle = await prisma.$transaction((tx) => buildBundle(tx, traceId));
    expect(bundle?.merchant_content_read.map((r) => r.sku)).toEqual(["SKU_US_1"]);
  });

  it("reads a trace recorded before the rename, with old field names", async () => {
    const traceId = "trace_dispute_old";
    const event = (eventType: EventType, payload: Record<string, unknown>) =>
      prisma.$transaction((tx) =>
        append(tx, { traceId, ts: new Date("2026-09-05T10:00:00.000Z"), actor: "system", eventType, payload }),
      );
    await event("agent_transcript", {
      transcript: [
        {
          role: "tool_results",
          results: [
            {
              id: "c1",
              name: "list_catalog",
              content:
                "sku=SKU_FOOD_002 category=food price_paise=26000 in_stock=true\n" +
                "<untrusted_merchant_content>\nChicken Biryani\nDum-style biryani\n</untrusted_merchant_content>",
            },
          ],
        },
      ],
    });
    await event("intent", { mandate_id: "mnd_test" });
    await event("decision", { mandate_id: "mnd_test", kind: "STEP_UP", reason_code: "STEP_UP_THRESHOLD", amount_paise: "52000" });
    await event("outcome", { mandate_id: "mnd_test", status: "captured", order_id: "order_old", amount_paise: "48000" });

    const bundle = await prisma.$transaction((tx) => buildBundle(tx, traceId));
    if (bundle === null) throw new Error("unreachable");

    expect(bundle.authorisation.amount_minor).toBe("48000");
    expect(bundle.authorisation.currency).toBe("INR");
    expect(bundle.merchant_content_read.map((r) => r.sku)).toEqual(["SKU_FOOD_002"]);
    expect(bundle.chain.global_chain_ok).toBe(true);
  });

  it("marks signature_verified false when the trace was denied for an invalid signature", async () => {
    const traceId = "trc_bad_sig";
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId,
        ts: new Date("2026-09-05T10:00:00.000Z"),
        actor: "praman",
        eventType: "decision",
        payload: { mandate_id: "mnd_bad", kind: "DENY", reason_code: "MANDATE_SIGNATURE_INVALID", detail: "bad sig" },
      }),
    );

    const bundle = await prisma.$transaction((tx) => buildBundle(tx, traceId));
    expect(bundle?.mandate.signature_verified).toBe(false);
  });
});

describe("buildBundle on a checkout that went on to capture", () => {
  const base = { mandate_id: "mnd_test", idempotency_key: "k_order", order_id: "PP1" };
  async function write(traceId: string, after: readonly [EventType, Record<string, unknown>][]): Promise<void> {
    const rows: [EventType, Record<string, unknown>][] = [
      ["intent", { mandate_id: "mnd_test", merchant_id: "M" }],
      ["decision", { mandate_id: "mnd_test", kind: "ALLOW", reason_code: "OK", amount_minor: "1250", currency: "USD" }],
      ["outcome", { ...base, status: "created", amount_minor: "1250", currency: "USD" }],
      ...after,
    ];
    for (const [eventType, payload] of rows) {
      await prisma.$transaction((tx) => append(tx, { traceId, ts: new Date("2026-11-08T10:00:00.000Z"), actor: "praman", eventType, payload }));
    }
  }

  it("reports a created then captured order as captured", async () => {
    await write("trc_bundle_cap", [
      ["capture_decision", { ...base, kind: "ALLOW_CAPTURE", reason_code: "OK", amount_minor: "1250", currency: "USD" }],
      ["outcome", { ...base, status: "captured", payment_id: "CAP1", amount_minor: "1250", currency: "USD" }],
    ]);
    const bundle = await prisma.$transaction((tx) => buildBundle(tx, "trc_bundle_cap"));
    expect(bundle?.authorisation).toMatchObject({ decision: "ALLOW", reason_code: "OK", amount_minor: "1250", currency: "USD" });
    expect(bundle?.execution).toEqual({ order_id: "PP1", status: "captured", idempotency_key: "k_order", rail: null, failed: false, failure_code: null, rail_reported: null, paid_by: null });
  });

  it("reports a refused capture with its real reason code, not OK", async () => {
    await write("trc_bundle_refused", [["capture_decision", { ...base, kind: "DENY", reason_code: "ORDER_RELEASED", detail: "released" }]]);
    const bundle = await prisma.$transaction((tx) => buildBundle(tx, "trc_bundle_refused"));
    expect(bundle?.authorisation).toMatchObject({ decision: "DENY", reason_code: "ORDER_RELEASED" });
    expect(bundle?.execution).toEqual({ order_id: "PP1", status: "created", idempotency_key: "k_order", rail: null, failed: false, failure_code: null, rail_reported: null, paid_by: null });
  });
});

/** A trace written row by row, as runIntent and resolveApproval would leave it. */
async function writeRows(traceId: string, rows: readonly [EventType, Record<string, unknown>][]): Promise<void> {
  for (const [eventType, payload] of rows) {
    await prisma.$transaction((tx) => append(tx, { traceId, ts: new Date("2026-11-08T10:00:00.000Z"), actor: "praman", eventType, payload }));
  }
}

// The bundle says what the trace page says (apps/receipt-ui/src/data.ts): how it was
// paid, whether anyone approved it, and that a failed or mismatched answer moved no
// clean payment.
describe("buildBundle says what the trace page says", () => {
  const order = { mandate_id: "mnd_test", idempotency_key: "k_order", rail: "paypal", currency: "USD" };
  const intent = { mandate_id: "mnd_test", merchant_id: "DEMO_CAFE", model_id: "gemini-3.1-flash-lite" };

  it("marks a saved-method charge as paid with no buyer present, with no approval", async () => {
    await writeRows("trc_bundle_nobuyer", [
      ["intent", intent],
      ["decision", { mandate_id: "mnd_test", kind: "ALLOW", reason_code: "OK", amount_minor: "450", currency: "USD" }],
      ["outcome", { ...order, order_id: "VLT1", status: "captured", payment_id: "CAP9", amount_minor: "450" }],
    ]);
    const bundle = await prisma.$transaction((tx) => buildBundle(tx, "trc_bundle_nobuyer"));
    expect(bundle?.execution).toMatchObject({ status: "captured", rail: "paypal", failed: false, paid_by: "saved_method_no_buyer" });
    expect(bundle?.approval).toBeNull();
  });

  it("records the approval on a saved-method charge a person approved", async () => {
    await writeRows("trc_bundle_nobuyer_ok", [
      ["intent", intent],
      ["decision", { mandate_id: "mnd_test", kind: "STEP_UP", reason_code: "STEP_UP_FIRST_MERCHANT", amount_minor: "1250", currency: "USD" }],
      ["step_up_resolved", { mandate_id: "mnd_test", approval_id: "apr_1", verdict: "approve", revalidated_kind: "ALLOW", revalidated_reason: "OK" }],
      ["outcome", { ...order, order_id: "VLT2", status: "captured", payment_id: "CAP8", amount_minor: "1250" }],
    ]);
    const bundle = await prisma.$transaction((tx) => buildBundle(tx, "trc_bundle_nobuyer_ok"));
    expect(bundle?.execution).toMatchObject({ paid_by: "saved_method_no_buyer" });
    expect(bundle?.approval).toMatchObject({ verdict: "approve" });
  });

  it("marks a checkout the buyer paid as a buyer checkout", async () => {
    await writeRows("trc_bundle_checkout", [
      ["decision", { mandate_id: "mnd_test", kind: "ALLOW", reason_code: "OK", amount_minor: "3200", currency: "USD" }],
      ["outcome", { ...order, order_id: "PP2", status: "created", amount_minor: "3200" }],
      ["outcome", { ...order, order_id: "PP2", status: "captured", payment_id: "CAP7", amount_minor: "3200", capture_key: "k_cap" }],
    ]);
    const bundle = await prisma.$transaction((tx) => buildBundle(tx, "trc_bundle_checkout"));
    expect(bundle?.execution).toMatchObject({ status: "captured", paid_by: "buyer_checkout", failed: false });
  });

  it("marks a rail mismatch as failed, with what the rail reported", async () => {
    await writeRows("trc_bundle_mismatch", [
      ["decision", { mandate_id: "mnd_test", kind: "ALLOW", reason_code: "OK", amount_minor: "900", currency: "USD" }],
      ["outcome", { ...order, order_id: "VLT3", status: "mismatch", amount_minor: "900", rail_status: "captured", rail_amount_minor: "400", rail_currency: "USD" }],
    ]);
    const bundle = await prisma.$transaction((tx) => buildBundle(tx, "trc_bundle_mismatch"));
    expect(bundle?.execution).toMatchObject({ status: "mismatch", failed: true, paid_by: null, rail_reported: { status: "captured", amount_minor: "400", currency: "USD" } });
  });

  it("marks a capture the rail refused as failed, with the rail's code", async () => {
    await writeRows("trc_bundle_failed", [
      ["decision", { mandate_id: "mnd_test", kind: "ALLOW", reason_code: "OK", amount_minor: "3200", currency: "USD" }],
      ["outcome", { ...order, order_id: "PP4", status: "created", amount_minor: "3200" }],
      ["outcome", { ...order, order_id: "PP4", status: "failed", failure_code: "ORDER_NOT_APPROVED", amount_minor: "3200", capture_key: "k_cap" }],
    ]);
    const bundle = await prisma.$transaction((tx) => buildBundle(tx, "trc_bundle_failed"));
    expect(bundle?.execution).toMatchObject({ status: "failed", failed: true, failure_code: "ORDER_NOT_APPROVED", paid_by: null });
  });
});
