import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append, type EventType } from "@praman/ledger";
import { loadTrace } from "../src/data.js";
import { renderTracePage } from "../src/pages/trace.js";

// Runs against TEST_DATABASE_URL (see vitest.config.ts), never the real one.
beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record RESTART IDENTITY`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function writeTrace(traceId: string, priceField: string, amountField: string): Promise<void> {
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
              `sku=SKU_FOOD_002 category=food ${priceField}=26000 in_stock=true\n` +
              "<untrusted_merchant_content>\nChicken Biryani\nDum-style biryani\n</untrusted_merchant_content>",
          },
        ],
      },
    ],
  });
  await event("decision", { mandate_id: "mnd_test", kind: "ALLOW", reason_code: "OK", [amountField]: "52000" });
  await event("outcome", { mandate_id: "mnd_test", status: "created", order_id: "order_x", [amountField]: "48000" });
}

describe("loadTrace", () => {
  it.each([
    ["recorded before the rename", "price_paise", "amount_paise"],
    ["recorded after the rename", "price_minor", "amount_minor"],
  ])("shows the amount and catalog read of a trace %s", async (_name, priceField, amountField) => {
    await writeTrace("trace_ui", priceField, amountField);

    const view = await loadTrace("trace_ui");
    expect(view?.amountMinor).toBe("48000");
    expect(view?.currency).toBe("INR");
    expect(view?.merchantReads).toEqual([
      {
        sku: "SKU_FOOD_002",
        category: "food",
        priceMinor: "26000",
        currency: "INR",
        inStock: true,
        title: "Chicken Biryani",
        description: "Dum-style biryani",
      },
    ]);
  });

  it("falls back to the decision's amount when there is no outcome, in either shape", async () => {
    const decision = (traceId: string, field: string) =>
      prisma.$transaction((tx) =>
        append(tx, {
          traceId,
          ts: new Date("2026-09-05T10:00:00.000Z"),
          actor: "system",
          eventType: "decision",
          payload: { mandate_id: "mnd_test", kind: "STEP_UP", reason_code: "STEP_UP_THRESHOLD", [field]: "52000" },
        }),
      );
    await decision("trace_old", "amount_paise");
    await decision("trace_new", "amount_minor");

    expect((await loadTrace("trace_old"))?.amountMinor).toBe("52000");
    expect((await loadTrace("trace_new"))?.amountMinor).toBe("52000");
  });

  it("shows a USD trace and its catalog read in USD", async () => {
    const event = (eventType: EventType, payload: Record<string, unknown>) =>
      prisma.$transaction((tx) =>
        append(tx, { traceId: "trace_usd", ts: new Date("2026-11-05T10:00:00.000Z"), actor: "system", eventType, payload }),
      );
    await event("agent_transcript", {
      transcript: [
        {
          role: "tool_results",
          results: [
            {
              id: "1",
              name: "list_catalog",
              content:
                "sku=SKU_US_1 category=food price_minor=1250 currency=USD in_stock=true\n" +
                "<untrusted_merchant_content>\nBurrito\nRice and beans\n</untrusted_merchant_content>",
            },
          ],
        },
      ],
    });
    await event("outcome", { mandate_id: "mnd_test", status: "captured", order_id: "order_x", amount_minor: "1250", currency: "USD" });

    const view = await loadTrace("trace_usd");
    expect(view?.currency).toBe("USD");
    expect(view?.merchantReads[0]?.currency).toBe("USD");
    expect(view?.merchantReads[0]?.priceMinor).toBe("1250");

    // On the page itself: the amount and the catalog price both read in dollars.
    const { html } = await renderTracePage("trace_usd");
    expect(html).toContain('<div class="amount">$12.50</div>');
    expect(html).toContain('<span class="merchant-item-price data">$12.50</span>');
    expect(html).not.toContain("₹12.50");
  });

  it("shows no amount on a denied trace", async () => {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "trace_deny",
        ts: new Date("2026-09-05T10:00:00.000Z"),
        actor: "system",
        eventType: "decision",
        payload: { mandate_id: "mnd_test", kind: "DENY", reason_code: "SKU_UNKNOWN", detail: "no such sku" },
      }),
    );
    expect((await loadTrace("trace_deny"))?.amountMinor).toBeNull();
  });
});
