import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append, type EventType } from "@praman/ledger";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonical } from "@praman/shared";
import { buildBundle, buildOwnerBundle } from "../src/bundle.js";

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

  describe("the signed mandate", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const document = { mandate_id: "mnd_signed", version: 2, issuer_id: "usr_issuer", scope: { currency: "USD" } };
    const signature = { alg: "Ed25519", key_id: "k1", value: sign(null, Buffer.from(canonical(document), "utf8"), privateKey).toString("base64url") };
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

    async function bundleWith(signedMandate: Record<string, unknown>) {
      await prisma.$transaction((tx) => append(tx, { traceId: "trc_signed", ts: new Date(), actor: "agent", eventType: "intent", payload: { mandate_id: "mnd_signed", signed_mandate: signedMandate, public_key_pem: publicKeyPem } }));
      return prisma.$transaction((tx) => buildOwnerBundle(tx, "trc_signed"));
    }

    it("carries the mandate, signature and key so an outsider can check it, and recomputes the check", async () => {
      const bundle = await bundleWith({ document, signature });
      expect(bundle?.mandate).toMatchObject({ id: "mnd_signed", issuer: "usr_issuer", key_id: "k1", signature_verified: true, signature_check: "recomputed" });
      expect(bundle?.mandate.signed).toEqual({ document, signature, public_key_pem: publicKeyPem });
      expect(bundle?.chain.entries[0]?.withheld_fields).toEqual([]);
    });

    it("gives the public bundle the verdict and a hash, and never the mandate, its signature or the key", async () => {
      await bundleWith({ document, signature });
      const bundle = await prisma.$transaction((tx) => buildBundle(tx, "trc_signed"));
      const expectedHash = createHash("sha256").update(canonical({ document, signature }), "utf8").digest("hex");
      expect(bundle?.mandate).toEqual({ id: "mnd_signed", key_id: "k1", signature_verified: true, signature_check: "recomputed", signed_sha256: expectedHash });
      const json = JSON.stringify(bundle);
      expect(json).not.toContain("usr_issuer");
      expect(json).not.toContain(signature.value);
      expect(json).not.toContain("BEGIN PUBLIC KEY");
      expect(bundle?.chain.entries[0]?.withheld_fields).toEqual(["public_key_pem", "signed_mandate"]);
      // The hash covers the signature, so hashing a guessed document alone can't reproduce it.
      const guess = createHash("sha256").update(canonical(document), "utf8").digest("hex");
      expect(bundle?.mandate.signed_sha256).not.toBe(guess);
    });

    it("keeps limit text and a step-up reason out of the public bundle's rows and verdict", async () => {
      await writeRows("trc_public_rows", [
        ["intent", { mandate_id: "mnd_signed", merchant_id: "M" }],
        ["decision", { mandate_id: "mnd_signed", kind: "DENY", reason_code: "MANDATE_BUDGET_EXHAUSTED", detail: "Amount 6000 minor units exceeds total budget 5000 minor units.", redaction_salt: "s1" }],
        ["decision", { mandate_id: "mnd_signed", kind: "STEP_UP", reason_code: "STEP_UP_THRESHOLD", amount_minor: "4000", currency: "USD", redaction_salt: "s2" }],
        ["step_up_resolved", { mandate_id: "mnd_signed", verdict: "approve", revalidated_kind: "STEP_UP", revalidated_reason: "STEP_UP_THRESHOLD", redaction_salt: "s3" }],
      ]);
      const bundle = await prisma.$transaction((tx) => buildBundle(tx, "trc_public_rows"));
      const json = JSON.stringify(bundle);
      expect(json).not.toContain("5000 minor");
      expect(json).not.toContain("STEP_UP_THRESHOLD");
      expect(json).not.toContain("redaction_salt\":\"");
      const fields = bundle?.chain.entries.map((e) => e.withheld_fields);
      expect(fields?.[1]).toEqual(["detail", "redaction_salt"]);
      expect(fields?.[2]).toEqual(["reason_code", "redaction_salt"]);
      expect(fields?.[3]).toEqual(["redaction_salt", "revalidated_reason"]);
    });

    it("keeps the owner bundle's reason code and row text", async () => {
      await writeRows("trc_owner_rows", [
        ["decision", { mandate_id: "mnd_signed", kind: "STEP_UP", reason_code: "STEP_UP_THRESHOLD", amount_minor: "4000", currency: "USD", redaction_salt: "s" }],
      ]);
      const bundle = await prisma.$transaction((tx) => buildOwnerBundle(tx, "trc_owner_rows"));
      expect(bundle?.authorisation.reason_code).toBe("STEP_UP_THRESHOLD");
      expect(bundle?.chain.entries[0]?.payload).toMatchObject({ redaction_salt: "s", reason_code: "STEP_UP_THRESHOLD" });
    });

    it("says not verified when the mandate on the trace doesn't match its signature", async () => {
      const bundle = await bundleWith({ document: { ...document, issuer_id: "usr_other" }, signature });
      expect(bundle?.mandate).toMatchObject({ issuer: "usr_other", key_id: "k1", signature_verified: false, signature_check: "recomputed" });
    });

    describe("in AP2 terms", () => {
      const full = {
        ...document,
        subject_id: "agt_1",
        scope: { merchant_ids: ["M_1"], categories: ["food"], currency: "USD" },
        limits: { max_per_txn_minor: "5000", max_total_minor: "20000", max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 3 },
        step_up: { threshold_minor: "3000" },
        validity: { not_before: "2026-11-01T00:00:00.000Z", not_after: "2026-11-30T00:00:00.000Z" },
        nonce: "a1b2c3d4e5f60718",
      };
      const fullSignature = { alg: "Ed25519", key_id: "k1", value: sign(null, Buffer.from(canonical(full), "utf8"), privateKey).toString("base64url") };

      it("is on the owner's bundle for a mandate whose signature holds", async () => {
        const bundle = await bundleWith({ document: full, signature: fullSignature });
        expect(bundle?.in_ap2_terms?.label).toBe("In AP2 terms (a mapping, not an AP2 mandate)");
        expect(bundle?.in_ap2_terms?.fields.find((f) => f.praman_field === "limits.max_total_minor")?.praman_value).toBe("20000");
      });

      it("is never on the public bundle, which withholds the limits it shows", async () => {
        await bundleWith({ document: full, signature: fullSignature });
        const json = JSON.stringify(await prisma.$transaction((tx) => buildBundle(tx, "trc_signed")));
        expect(json).not.toContain("in_ap2_terms");
        expect(json).not.toContain("In AP2 terms");
        expect(json).not.toContain("payment.budget");
        expect(json).not.toContain("20000");
      });

      it("is null when the signature doesn't hold or there is no signed mandate", async () => {
        expect((await bundleWith({ document: { ...full, nonce: "changed" }, signature: fullSignature }))?.in_ap2_terms).toBeNull();
        await prisma.$transaction((tx) => append(tx, { traceId: "trc_unsigned", ts: new Date(), actor: "agent", eventType: "intent", payload: { mandate_id: "mnd_old" } }));
        expect((await prisma.$transaction((tx) => buildOwnerBundle(tx, "trc_unsigned")))?.in_ap2_terms).toBeNull();
      });
    });

    it("says an older trace with no mandate on it was only inferred", async () => {
      await prisma.$transaction((tx) => append(tx, { traceId: "trc_old", ts: new Date(), actor: "agent", eventType: "intent", payload: { mandate_id: "mnd_old" } }));
      expect((await prisma.$transaction((tx) => buildBundle(tx, "trc_old")))?.mandate).toEqual({ id: "mnd_old", key_id: null, signature_verified: true, signature_check: "inferred", signed_sha256: null });
      expect((await prisma.$transaction((tx) => buildOwnerBundle(tx, "trc_old")))?.mandate).toMatchObject({ issuer: null, signature_check: "inferred", signed: null });
    });
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
    expect(bundle?.approval).toEqual({ verdict: "approve", by: "person" });
  });

  it("names an approval the test harness made as the harness's", async () => {
    await writeRows("trc_bundle_harness", [
      ["intent", { mandate_id: "mnd_h", merchant_id: "DEMO_HARNESS", model_id: "harness/no-model" }],
      ["decision", { mandate_id: "mnd_h", kind: "STEP_UP", reason_code: "STEP_UP_FIRST_MERCHANT", amount_minor: "500", currency: "USD" }],
      ["step_up_resolved", { mandate_id: "mnd_h", approval_id: "apr_h", verdict: "approve", revalidated_kind: "ALLOW", revalidated_reason: "OK" }],
      ["outcome", { mandate_id: "mnd_h", idempotency_key: "k_h", order_id: "sim_1", rail: "simulated", status: "captured", amount_minor: "500", currency: "USD" }],
    ]);
    const bundle = await prisma.$transaction((tx) => buildBundle(tx, "trc_bundle_harness"));
    expect(bundle?.approval).toEqual({ verdict: "approve", by: "test_harness" });
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

describe("buildBundle on a refunded purchase (D-66, D-67)", () => {
  const order = { mandate_id: "mnd_test", idempotency_key: "k_order", order_id: "VLT1", rail: "paypal", currency: "USD" };
  const refund = { ...order, payment_id: "CAP9", refund_key: "r".repeat(64), amount_minor: "450" };

  it("records the refund, who asked, and that it gave no budget back, and keeps the purchase as it was", async () => {
    await writeRows("trc_bundle_refund", [
      ["intent", { mandate_id: "mnd_test", merchant_id: "DEMO_CAFE", model_id: "gemini-3.1-flash-lite" }],
      ["decision", { mandate_id: "mnd_test", kind: "ALLOW", reason_code: "OK", amount_minor: "450", currency: "USD" }],
      ["outcome", { ...order, status: "captured", payment_id: "CAP9", amount_minor: "450" }],
      ["refund_requested", { ...refund, operation: "captures.refund", status: "attempted", requested_by: "operator" }],
      ["refund_outcome", { ...refund, status: "refunded", refund_id: "2JV473619H1766245", failure_code: null }],
    ]);
    const bundle = await prisma.$transaction((tx) => buildBundle(tx, "trc_bundle_refund"));
    expect(bundle?.refund).toEqual({
      status: "refunded",
      refund_id: "2JV473619H1766245",
      amount_minor: "450",
      currency: "USD",
      requested_by: "operator",
      requested_at: "2026-11-08T10:00:00.000Z",
      failure_code: null,
      budget_returned: false,
    });
    expect(bundle?.authorisation).toMatchObject({ decision: "ALLOW", reason_code: "OK" });
    expect(bundle?.execution).toMatchObject({ status: "captured", failed: false, paid_by: "saved_method_no_buyer" });
    expect(bundle?.chain.entries.map((e) => e.event_type)).toEqual(["intent", "decision", "outcome", "refund_requested", "refund_outcome"]);
  });

  it("shows a refund with no answer as requested, and none at all as null", async () => {
    await writeRows("trc_bundle_refund_open", [
      ["outcome", { ...order, status: "captured", payment_id: "CAP9", amount_minor: "450" }],
      ["refund_requested", { ...refund, operation: "captures.refund", status: "attempted", requested_by: "demo_visitor" }],
    ]);
    expect((await prisma.$transaction((tx) => buildBundle(tx, "trc_bundle_refund_open")))?.refund).toMatchObject({ status: "requested", refund_id: null, requested_by: "demo_visitor" });

    await writeRows("trc_bundle_no_refund", [["outcome", { ...order, status: "captured", payment_id: "CAP9", amount_minor: "450" }]]);
    expect((await prisma.$transaction((tx) => buildBundle(tx, "trc_bundle_no_refund")))?.refund).toBeNull();
  });
});
