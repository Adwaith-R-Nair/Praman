import { describe, expect, it } from "vitest";
import type { PurchaseIntent } from "@praman/policy";
import { canonicalIntent, idempotencyKey, receiptFor } from "../src/idempotency.js";

const BASE: PurchaseIntent = {
  intent_id: "int_1",
  mandate_id: "mnd_01",
  merchant_id: "MERCH_001",
  line_items: [
    { sku: "SKU_B", qty: 1 },
    { sku: "SKU_A", qty: 2 },
  ],
  requested_at: "2026-09-05T10:00:00.000Z",
  agent_rationale: "The user wants lunch.",
};

describe("idempotencyKey", () => {
  it("reordered line items produce the same key", () => {
    const reordered: PurchaseIntent = {
      ...BASE,
      line_items: [
        { sku: "SKU_A", qty: 2 },
        { sku: "SKU_B", qty: 1 },
      ],
    };
    expect(idempotencyKey("mnd_01", reordered)).toBe(idempotencyKey("mnd_01", BASE));
  });

  it("a reworded rationale and a new timestamp produce the same key", () => {
    // The key identifies the CART, not the model's prose about it — otherwise
    // a retry with reworded reasoning derives a different key and the
    // duplicate guard misses it, double-charging.
    const retried: PurchaseIntent = {
      ...BASE,
      requested_at: "2026-09-05T10:05:00.000Z",
      agent_rationale: "Buying lunch for the user because they are hungry.",
    };
    expect(idempotencyKey("mnd_01", retried)).toBe(idempotencyKey("mnd_01", BASE));
  });

  it("a genuinely different cart produces a different key", () => {
    const differentQty: PurchaseIntent = { ...BASE, line_items: [{ sku: "SKU_A", qty: 5 }] };
    expect(idempotencyKey("mnd_01", differentQty)).not.toBe(idempotencyKey("mnd_01", BASE));
  });

  it("the same cart under a different mandate produces a different key", () => {
    expect(idempotencyKey("mnd_02", BASE)).not.toBe(idempotencyKey("mnd_01", BASE));
  });

  it("is deterministic across repeated calls", () => {
    expect(idempotencyKey("mnd_01", BASE)).toBe(idempotencyKey("mnd_01", BASE));
  });
});

describe("canonicalIntent", () => {
  it("excludes agent_rationale and requested_at", () => {
    const parsed = JSON.parse(canonicalIntent(BASE)) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("agent_rationale");
    expect(parsed).not.toHaveProperty("requested_at");
    expect(parsed).toEqual({
      intent_id: "int_1",
      mandate_id: "mnd_01",
      merchant_id: "MERCH_001",
      line_items: [
        { sku: "SKU_A", qty: 2 },
        { sku: "SKU_B", qty: 1 },
      ],
    });
  });
});

describe("receiptFor", () => {
  it("truncates to at most 40 characters", () => {
    const key = idempotencyKey("mnd_01", BASE);
    expect(receiptFor(key).length).toBeLessThanOrEqual(40);
    expect(key.startsWith(receiptFor(key))).toBe(true);
  });
});
