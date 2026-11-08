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

  it("shows a capture the rail refused as a failed capture, not ALLOW and OK", async () => {
    await writeCheckoutTrace("trace_cap_rail_refused", [
      ["capture_decision", { ...base, kind: "ALLOW_CAPTURE", reason_code: "OK", amount_minor: "1250", currency: "USD" }],
      ["outcome", { ...base, rail: "paypal", status: "failed", failure_code: "ORDER_NOT_APPROVED", amount_minor: "1250", currency: "USD", capture_key: "k_cap" }],
    ]);
    const view = await loadTrace("trace_cap_rail_refused");
    expect(view).toMatchObject({ decisionKind: "CAPTURE_FAILED", orderStatus: "failed", railFailureCode: "ORDER_NOT_APPROVED", amountMinor: "1250" });
    expect(view?.reasonCode).not.toBe("OK");

    const { html } = await renderTracePage("trace_cap_rail_refused");
    expect(html).toContain("Capture failed");
    expect(html).toContain("ORDER_NOT_APPROVED");
    expect(html).toContain("No money moved");
    expect(html).not.toContain("Allowed (failed)");
  });

  it("shows an order the rail refused to create as failed, with the rail's code", async () => {
    const traceId = "trace_create_failed";
    for (const [eventType, payload] of [
      ["decision", { mandate_id: "mnd_test", kind: "ALLOW", reason_code: "OK", amount_minor: "1250", currency: "USD" }],
      ["outcome", { mandate_id: "mnd_test", idempotency_key: "k_order", order_id: "", rail: "paypal", status: "failed", failure_code: "PAYEE_ACCOUNT_RESTRICTED", amount_minor: "1250", currency: "USD" }],
    ] as const) {
      await prisma.$transaction((tx) => append(tx, { traceId, ts: new Date("2026-11-08T10:00:00.000Z"), actor: "praman", eventType, payload }));
    }
    expect(await loadTrace(traceId)).toMatchObject({ decisionKind: "ORDER_FAILED", railFailureCode: "PAYEE_ACCOUNT_RESTRICTED" });
    const { html } = await renderTracePage(traceId);
    expect(html).toContain("Payment failed");
    expect(html).toContain("PAYEE_ACCOUNT_RESTRICTED");
  });

  it("escapes a rail's failure code on the page", async () => {
    await writeCheckoutTrace("trace_cap_code_html", [
      ["outcome", { ...base, rail: "paypal", status: "failed", failure_code: "<b>X</b>", amount_minor: "1250", currency: "USD", capture_key: "k_cap" }],
    ]);
    const { html } = await renderTracePage("trace_cap_code_html");
    expect(html).not.toContain("<b>X</b>");
    expect(html).toContain("&lt;b&gt;X&lt;/b&gt;");
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

/** A trace written row by row, as runIntent and resolveApproval would leave it. */
async function writeRows(traceId: string, rows: readonly [EventType, Record<string, unknown>][]): Promise<void> {
  for (const [eventType, payload] of rows) {
    await prisma.$transaction((tx) => append(tx, { traceId, ts: new Date("2026-11-08T10:00:00.000Z"), actor: "praman", eventType, payload }));
  }
}

describe("loadTrace on a purchase paid with no buyer present", () => {
  const order = { mandate_id: "mnd_test", idempotency_key: "k_order", order_id: "VLT1", rail: "paypal", amount_minor: "450", currency: "USD" };
  const intent = { mandate_id: "mnd_test", merchant_id: "DEMO_CAFE", model_id: "gemini-3.1-flash-lite", agent_rationale: "coffee" };

  it("says it was paid from the saved PayPal account, with no buyer present and no person approving", async () => {
    await writeRows("trace_nobuyer", [
      ["intent", intent],
      ["decision", { mandate_id: "mnd_test", kind: "ALLOW", reason_code: "OK", amount_minor: "450", currency: "USD" }],
      ["outcome", { ...order, status: "captured", payment_id: "CAP9" }],
    ]);
    expect(await loadTrace("trace_nobuyer")).toMatchObject({ decisionKind: "ALLOW", payment: "saved_method", approvalVerdict: null });
    const { html } = await renderTracePage("trace_nobuyer");
    expect(html).toContain("Paid from the saved PayPal account, with no buyer present.");
    expect(html).toContain("No person approved it.");
  });

  it("says a person approved it when one did", async () => {
    await writeRows("trace_nobuyer_approved", [
      ["intent", intent],
      ["decision", { mandate_id: "mnd_test", kind: "STEP_UP", reason_code: "STEP_UP_FIRST_MERCHANT", amount_minor: "450", currency: "USD" }],
      ["step_up_resolved", { mandate_id: "mnd_test", approval_id: "apr_1", verdict: "approve", revalidated_kind: "ALLOW", revalidated_reason: "OK" }],
      ["outcome", { ...order, status: "captured", payment_id: "CAP9" }],
    ]);
    const { html } = await renderTracePage("trace_nobuyer_approved");
    expect(html).toContain("Paid from the saved PayPal account, with no buyer present.");
    expect(html).toContain("A person approved it in Praman before the charge.");
    expect(html).not.toContain("No person approved it.");
  });

  it("does not call a checkout the buyer paid a no-buyer payment", async () => {
    await writeCheckoutTrace("trace_checkout_paid", [
      ["outcome", { mandate_id: "mnd_test", idempotency_key: "k_order", order_id: "PP1", rail: "paypal", status: "captured", payment_id: "CAP1", amount_minor: "1250", currency: "USD", capture_key: "k_cap" }],
    ]);
    expect((await loadTrace("trace_checkout_paid"))?.payment).not.toBe("saved_method");
    expect((await renderTracePage("trace_checkout_paid")).html).not.toContain("no buyer present");
  });
});

describe("loadTrace on an answer about different money", () => {
  it("shows a rail mismatch as a failure, not as Allowed", async () => {
    await writeRows("trace_mismatch", [
      ["decision", { mandate_id: "mnd_test", kind: "ALLOW", reason_code: "OK", amount_minor: "900", currency: "USD" }],
      [
        "outcome",
        { mandate_id: "mnd_test", idempotency_key: "k_order", order_id: "VLT2", rail: "paypal", status: "mismatch", amount_minor: "900", currency: "USD", rail_status: "captured", rail_amount_minor: "400", rail_currency: "USD" },
      ],
    ]);
    const view = await loadTrace("trace_mismatch");
    expect(view).toMatchObject({ decisionKind: "RAIL_MISMATCH", orderStatus: "mismatch", amountMinor: "900" });
    expect(view?.reasonCode).not.toBe("OK");
    const { html } = await renderTracePage("trace_mismatch");
    expect(html).toContain("Payment mismatch");
    expect(html).toContain("$4.00");
    expect(html).not.toContain("Allowed (mismatch)");
  });
});

describe("loadTrace on an approval the test harness made", () => {
  const rows = (verdict: string): [EventType, Record<string, unknown>][] => [
    ["intent", { mandate_id: "mnd_h", merchant_id: "DEMO_HARNESS", model_id: "harness/no-model", agent_rationale: "Test-harness intent. No model proposed this." }],
    ["decision", { mandate_id: "mnd_h", kind: "STEP_UP", reason_code: "STEP_UP_FIRST_MERCHANT", amount_minor: "500", currency: "USD" }],
    ["step_up_resolved", { mandate_id: "mnd_h", approval_id: "apr_h", verdict, revalidated_kind: "ALLOW", revalidated_reason: "OK" }],
  ];

  it("labels it as the harness's, never as a human review", async () => {
    await writeRows("trace_harness", [...rows("approve"), ["outcome", { mandate_id: "mnd_h", idempotency_key: "k_h", order_id: "sim_1", rail: "simulated", status: "captured", amount_minor: "500", currency: "USD" }]]);
    expect(await loadTrace("trace_harness")).toMatchObject({ approvedBy: "test_harness" });
    const { html } = await renderTracePage("trace_harness");
    expect(html).toContain("Test harness approved the step-up");
    expect(html).not.toContain("Human reviewed");
  });

  it("says a rejection by the harness was the harness's", async () => {
    await writeRows("trace_harness_rejected", rows("reject"));
    const { html } = await renderTracePage("trace_harness_rejected");
    expect(html).toContain("The test harness rejected this purchase.");
    expect(html).not.toContain("human reviewer");
  });

  it("still says a person reviewed an approval on an agent's purchase", async () => {
    await writeRows("trace_person", [
      ["intent", { mandate_id: "mnd_test", merchant_id: "DEMO_CAFE", model_id: "gemini-3.1-flash-lite" }],
      ["decision", { mandate_id: "mnd_test", kind: "STEP_UP", reason_code: "STEP_UP_FIRST_MERCHANT", amount_minor: "1250", currency: "USD" }],
      ["step_up_resolved", { mandate_id: "mnd_test", approval_id: "apr_p", verdict: "approve", revalidated_kind: "ALLOW", revalidated_reason: "OK" }],
    ]);
    expect(await loadTrace("trace_person")).toMatchObject({ approvedBy: "person" });
    expect((await renderTracePage("trace_person")).html).toContain("Human reviewed the step-up");
  });
});

describe("loadTrace on a revocation", () => {
  const revoke = (traceId: string, reason: string) =>
    prisma.$transaction((tx) =>
      append(tx, { traceId, ts: new Date("2026-11-08T10:00:00.000Z"), actor: "issuer", eventType: "mandate_revoked", payload: { mandate_id: "mnd_rev_page", reason } }),
    );

  it("calls it a revocation, with the mandate and the issuer's reason, not an unknown decision", async () => {
    await revoke("trc_revoke_page", "lost trust in the agent");
    const view = await loadTrace("trc_revoke_page");
    expect(view).toMatchObject({ decisionKind: "REVOKED", revocation: { mandateId: "mnd_rev_page", reason: "lost trust in the agent" } });

    const { status, html } = await renderTracePage("trc_revoke_page");
    expect(status).toBe(200);
    expect(html).toContain("Mandate revoked");
    expect(html).not.toContain(">Unknown<");
    expect(html).toContain("mnd_rev_page");
    expect(html).toContain("MANDATE_REVOKED");
  });

  it("escapes the reason, which a person typed", async () => {
    await revoke("trc_revoke_page_x", "<img src=x onerror=alert(1)>");
    const { html } = await renderTracePage("trc_revoke_page_x");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("leads a demo visitor's revocation back to the demo", async () => {
    await revoke("trc_demo_abc123abc123_revoke", "Revoked by the demo visitor from the demo page.");
    const { html } = await renderTracePage("trc_demo_abc123abc123_revoke");
    expect(html).toContain('href="/demo"');
    expect(html).toContain('href="/demo/console#trace=trc_demo_abc123abc123_revoke"');
  });

  it("links a trace that isn't a demo visitor's to the local operator console", async () => {
    await revoke("trc_revoke_local", "x");
    const { html } = await renderTracePage("trc_revoke_local");
    expect(html).toContain('href="/console#trace=trc_revoke_local"');
  });
});

describe("loadTrace and the trace page on a refunded purchase (D-66, D-67)", () => {
  const order = { mandate_id: "mnd_test", merchant_id: "DEMO_CAFE", idempotency_key: "k_order", order_id: "VLT1", rail: "paypal", currency: "USD" };
  const refund = { ...order, payment_id: "CAP9", refund_key: "r".repeat(64), amount_minor: "450" };
  const paid: [EventType, Record<string, unknown>][] = [
    ["intent", { mandate_id: "mnd_test", merchant_id: "DEMO_CAFE", model_id: "gemini-3.1-flash-lite", agent_rationale: "coffee" }],
    ["decision", { mandate_id: "mnd_test", kind: "ALLOW", reason_code: "OK", amount_minor: "450", currency: "USD" }],
    ["outcome", { ...order, status: "captured", payment_id: "CAP9", amount_minor: "450" }],
  ];
  const requested: [EventType, Record<string, unknown>] = ["refund_requested", { ...refund, operation: "captures.refund", status: "attempted", requested_by: "demo_visitor" }];

  it("says the money went back, who asked, and that the budget still counts it", async () => {
    await writeRows("trace_refunded", [...paid, requested, ["refund_outcome", { ...refund, status: "refunded", refund_id: "2JV473619H1766245", failure_code: null }]]);
    const view = await loadTrace("trace_refunded");
    expect(view?.refund).toMatchObject({ status: "refunded", refundId: "2JV473619H1766245", amountMinor: "450", currency: "USD", requestedBy: "demo_visitor" });
    // The purchase itself still reads as what it was: allowed and captured.
    expect(view).toMatchObject({ decisionKind: "ALLOW", orderStatus: "captured" });

    const { html } = await renderTracePage("trace_refunded");
    expect(html).toContain("Refunded in full. $4.50 went back to the buyer.");
    expect(html).toContain("Asked for by the demo visitor, on this trace page");
    expect(html).toContain("The mandate&#39;s budget still counts this purchase");
    expect(html).toContain("refund 2JV473619H1766245");
  });

  it("says a refund with no answer yet is open, not done", async () => {
    await writeRows("trace_refund_open", [...paid, requested]);
    expect((await loadTrace("trace_refund_open"))?.refund?.status).toBe("requested");
    expect((await renderTracePage("trace_refund_open")).html).toContain("has no answer yet");
  });

  it("explains a refund PayPal refused because the payment was already refunded", async () => {
    await writeRows("trace_refund_twice", [...paid, requested, ["refund_outcome", { ...refund, status: "failed", refund_id: null, failure_code: "CAPTURE_FULLY_REFUNDED" }]]);
    const { html } = await renderTracePage("trace_refund_twice");
    expect(html).toContain("already refunded in full, so this refund moved no money");
    expect(html).toContain("PayPal said CAPTURE_FULLY_REFUNDED");
  });

  it("reads the latest request, so a retry after a refusal shows its own answer", async () => {
    const retry = { ...refund, refund_key: "s".repeat(64) };
    await writeRows("trace_refund_retry", [
      ...paid,
      requested,
      ["refund_outcome", { ...refund, status: "failed", refund_id: null, failure_code: "REFUND_NOT_ALLOWED" }],
      ["refund_requested", { ...retry, operation: "captures.refund", status: "attempted", requested_by: "operator" }],
      ["refund_outcome", { ...retry, status: "pending", refund_id: "R2", failure_code: null }],
    ]);
    expect((await loadTrace("trace_refund_retry"))?.refund).toMatchObject({ status: "pending", refundId: "R2", requestedBy: "operator", failureCode: null });
  });

  it("shows no refund section when nobody asked for one", async () => {
    await writeRows("trace_not_refunded", paid);
    expect((await loadTrace("trace_not_refunded"))?.refund).toBeNull();
    expect((await renderTracePage("trace_not_refunded")).html).not.toContain(`id="refund"`);
  });
});
