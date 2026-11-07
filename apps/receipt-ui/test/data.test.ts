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

/** A PayPal checkout trace: allowed and created, then whatever happened at capture. */
async function writeCheckoutTrace(traceId: string, after: readonly [EventType, Record<string, unknown>][]): Promise<void> {
  const base = { mandate_id: "mnd_test", idempotency_key: "k_order", order_id: "PP1" };
  const rows: [EventType, Record<string, unknown>][] = [
    ["decision", { mandate_id: "mnd_test", kind: "ALLOW", reason_code: "OK", amount_minor: "1250", currency: "USD" }],
    ["outcome", { ...base, status: "created", amount_minor: "1250", currency: "USD" }],
    ...after,
  ];
  for (const [eventType, payload] of rows) {
    await prisma.$transaction((tx) => append(tx, { traceId, ts: new Date("2026-11-08T10:00:00.000Z"), actor: "praman", eventType, payload }));
  }
}

describe("loadTrace on a checkout that went on to capture", () => {
  const base = { mandate_id: "mnd_test", idempotency_key: "k_order", order_id: "PP1" };

  it("shows a created then captured order as captured", async () => {
    await writeCheckoutTrace("trace_cap", [
      ["capture_decision", { ...base, kind: "ALLOW_CAPTURE", reason_code: "OK", amount_minor: "1250", currency: "USD" }],
      ["outcome", { ...base, status: "captured", payment_id: "CAP1", amount_minor: "1250", currency: "USD", capture_key: "k_cap" }],
    ]);
    const view = await loadTrace("trace_cap");
    expect(view).toMatchObject({ decisionKind: "ALLOW", reasonCode: "OK", orderStatus: "captured", orderId: "PP1", amountMinor: "1250", currency: "USD" });
  });

  it("shows a refused capture with its real reason code, not OK", async () => {
    await writeCheckoutTrace("trace_cap_refused", [
      ["capture_decision", { ...base, kind: "DENY", reason_code: "MANDATE_REVOKED", detail: "revoked" }],
    ]);
    const view = await loadTrace("trace_cap_refused");
    expect(view).toMatchObject({ decisionKind: "DENY", reasonCode: "MANDATE_REVOKED", amountMinor: "1250" });
    const { html } = await renderTracePage("trace_cap_refused");
    expect(html).toContain("Refused");
  });

  it("shows a capture that went through after an earlier refusal as captured", async () => {
    await writeCheckoutTrace("trace_cap_retry", [
      ["capture_decision", { ...base, kind: "DENY", reason_code: "AMOUNT_CHANGED_SINCE_APPROVAL", detail: "requoted" }],
      ["capture_decision", { ...base, kind: "ALLOW_CAPTURE", reason_code: "OK", amount_minor: "1250", currency: "USD" }],
      ["outcome", { ...base, status: "captured", payment_id: "CAP1", amount_minor: "1250", currency: "USD" }],
    ]);
    expect(await loadTrace("trace_cap_retry")).toMatchObject({ decisionKind: "ALLOW", reasonCode: "OK", orderStatus: "captured" });
  });

  it("shows a released order as released, with the amount it held", async () => {
    await writeCheckoutTrace("trace_released", [["outcome", { ...base, status: "released", currency: "USD" }]]);
    expect(await loadTrace("trace_released")).toMatchObject({ decisionKind: "ALLOW", orderStatus: "released", amountMinor: "1250", currency: "USD" });
  });

  it("does not let a capture attempt by an unproven caller change what the trace shows", async () => {
    await writeCheckoutTrace("trace_cap_claim", [
      ["capture_decision", { claimed_mandate_id: "mnd_test", kind: "DENY", reason_code: "MANDATE_SIGNATURE_INVALID", detail: "bad sig" }],
    ]);
    expect(await loadTrace("trace_cap_claim")).toMatchObject({ decisionKind: "ALLOW", reasonCode: "OK", orderStatus: "created" });
  });
});

describe("loadTrace with a settlement from a verified webhook", () => {
  const base = { mandate_id: "mnd_test", idempotency_key: "k_order", order_id: "PP1" };
  const settlement = { ...base, rail: "paypal", event_id: "WH-SYNTHETIC-0001", event_type: "PAYMENT.CAPTURE.COMPLETED", status: "captured", payment_id: "CAP1", amount_minor: "1250", currency: "USD" };

  it("shows what the provider reported, under the order's state", async () => {
    await writeCheckoutTrace("trace_settled", [
      ["outcome", { ...base, status: "captured", payment_id: "CAP1", amount_minor: "1250", currency: "USD" }],
      ["settlement", settlement],
    ]);

    const view = await loadTrace("trace_settled");
    expect(view).toMatchObject({ orderStatus: "captured", settlement: { rail: "paypal", status: "captured", paymentId: "CAP1", eventId: "WH-SYNTHETIC-0001" } });
    const { html } = await renderTracePage("trace_settled");
    expect(html).toContain("PayPal reported the capture completed");
    expect(html).toContain("CAP1");
    expect(html).toContain("WH-SYNTHETIC-0001");
  });

  it("shows a declined capture in plain words", async () => {
    await writeCheckoutTrace("trace_declined", [["settlement", { ...settlement, status: "declined", event_type: "PAYMENT.CAPTURE.DECLINED" }]]);
    expect((await renderTracePage("trace_declined")).html).toContain("PayPal reported the capture was declined");
  });

  it("escapes every settlement field, though the parser only lets ids through", async () => {
    await writeCheckoutTrace("trace_settled_odd", [["settlement", { ...settlement, rail: "<i>rail</i>", status: "<b>x</b>", payment_id: "<script>alert(1)</script>", event_id: "\"><img src=x>" }]]);
    const { html } = await renderTracePage("trace_settled_odd");
    expect(html).not.toMatch(/<script>alert|<img src=x>|<b>x<\/b>|<i>rail/);
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows no settlement line when there is none", async () => {
    await writeCheckoutTrace("trace_unsettled", [["outcome", { ...base, status: "captured", payment_id: "CAP1", amount_minor: "1250", currency: "USD" }]]);
    expect((await loadTrace("trace_unsettled"))?.settlement).toBeNull();
    expect((await renderTracePage("trace_unsettled")).html).not.toContain("reported the capture");
  });
});
