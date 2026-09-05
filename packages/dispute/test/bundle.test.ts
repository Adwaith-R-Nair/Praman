import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append } from "@praman/ledger";
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
        payload: { mandate_id: "mnd_test", kind: "ALLOW", reason_code: "OK", amount_paise: "52000" },
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
                    "sku=SKU_FOOD_002 category=food price_paise=26000 in_stock=true\n" +
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
          amount_paise: "52000",
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
    expect(bundle.authorisation.amount_paise).toBe("52000");
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
    expect(bundle.execution).toEqual({ order_id: "order_x", status: "captured", idempotency_key: "idem_x" });
    expect(bundle.chain.entries).toHaveLength(4);
    expect(bundle.chain.global_chain_ok).toBe(true);
    expect(bundle.chain.trace_fully_verified).toBe(true);
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
