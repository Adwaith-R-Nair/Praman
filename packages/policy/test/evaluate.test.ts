import { describe, expect, it } from "vitest";
import { minor } from "@praman/shared";
import { evaluate } from "../src/evaluate.js";
import type {
  PurchaseIntent,
  VerifiedMandate,
  LedgerDerivedState,
  CatalogSnapshot,
  EvaluateInput,
} from "../src/types.js";

const MERCHANT = "MERCH_001";
const OTHER_MERCHANT = "MERCH_002";
const CATEGORY = "food";
const SKU = "SKU_FOOD_001";
const NOW = new Date("2026-08-28T12:00:00Z");
const NOT_BEFORE = new Date("2026-08-28T00:00:00Z");
const NOT_AFTER = new Date("2026-08-29T00:00:00Z");

/** Seeded LCG in [0, 1) — deterministic stand-in for Math.random(). */
function makeRng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/**
 * Freezes plain objects and arrays. Note: Object.freeze does NOT prevent
 * Map.set or Set.add — collection internals live outside the own-property
 * slots freezing acts on. This therefore locks down the object graph, not
 * the Map/Set instances within it (catalog.items, merchants_transacted,
 * seen_idempotency_keys).
 */
function deepFreeze<T>(value: T): T {
  if (value instanceof Map) {
    for (const v of value.values()) deepFreeze(v);
    return Object.freeze(value);
  }
  if (Array.isArray(value)) {
    for (const v of value) deepFreeze(v);
    return Object.freeze(value) as T;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    for (const v of Object.values(value)) deepFreeze(v);
    return Object.freeze(value);
  }
  return value;
}

function makeMandate(overrides: Partial<VerifiedMandate> = {}): VerifiedMandate {
  return {
    mandate_id: "mnd_01",
    scope: {
      merchant_ids: [MERCHANT],
      categories: [CATEGORY],
      currency: "INR",
    },
    limits: {
      max_per_txn_minor: minor(80000n),
      max_total_minor: minor(500000n),
      max_txns_per_window: 5,
      window_seconds: 3600,
      max_denials_per_window: 5,
    },
    step_up: {
      threshold_minor: minor(50000n),
    },
    validity: {
      not_before: NOT_BEFORE,
      not_after: NOT_AFTER,
    },
    ...overrides,
  };
}

function makeIntent(overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
  return {
    intent_id: "int_01",
    mandate_id: "mnd_01",
    merchant_id: MERCHANT,
    line_items: [{ sku: SKU, qty: 1 }],
    requested_at: NOW.toISOString(),
    agent_rationale: "Test purchase",
    ...overrides,
  };
}

function makeState(overrides: Partial<LedgerDerivedState> = {}): LedgerDerivedState {
  return {
    spent_minor: minor(0n),
    txn_timestamps: [],
    revoked: false,
    merchants_transacted: new Set<string>(),
    released_keys: new Set<string>(),
    seen_idempotency_keys: new Set<string>(),
    denied_attempts: [],
    ...overrides,
  };
}

function makeCatalog(overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    merchant_id: MERCHANT,
    items: new Map([
      [
        SKU,
        {
          sku: SKU,
          category: CATEGORY,
          price_minor: minor(10000n),
          currency: "INR",
          stock_qty: 10,
        },
      ],
    ]),
    ...overrides,
  };
}

function makeInput(
  intentOverrides: Partial<PurchaseIntent> = {},
  mandateOverrides: Partial<VerifiedMandate> = {},
  stateOverrides: Partial<LedgerDerivedState> = {},
  catalogOverrides: Partial<CatalogSnapshot> = {},
): EvaluateInput {
  return {
    intent: makeIntent(intentOverrides),
    mandate: makeMandate(mandateOverrides),
    state: makeState(stateOverrides),
    catalog: makeCatalog(catalogOverrides),
    now: NOW,
    idempotency_key: "idem_01",
  };
}

describe("evaluate", () => {
  // ── 1. DUPLICATE_INTENT ────────────────────────────────────────
  describe("DUPLICATE_INTENT", () => {
    it("denies when idempotency key already seen", () => {
      const result = evaluate({
        ...makeInput(),
        idempotency_key: "idem_seen",
        state: makeState({ seen_idempotency_keys: new Set(["idem_seen"]) }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "DUPLICATE_INTENT",
        detail: expect.stringContaining("idem_seen"),
      });
    });

    it("allows when idempotency key is new", () => {
      const result = evaluate(makeInput());
      expect(result.kind).not.toBe("DENY");
    });
  });

  // ── 2. MANDATE_REVOKED ────────────────────────────────────────
  describe("MANDATE_REVOKED", () => {
    it("denies when mandate is revoked", () => {
      const result = evaluate({
        ...makeInput(),
        state: makeState({ revoked: true }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "MANDATE_REVOKED",
        detail: expect.any(String),
      });
    });
  });

  // ── 2b. DENIAL_RATE_EXCEEDED ───────────────────────────────────
  describe("DENIAL_RATE_EXCEEDED", () => {
    it("denies when denials in the window reach the cap", () => {
      // Default mandate: max_denials_per_window 5, window_seconds 3600.
      const deniedAttempts = Array.from({ length: 5 }, (_, i) => new Date(NOW.getTime() - i * 1000));
      const result = evaluate({
        ...makeInput(),
        state: makeState({ denied_attempts: deniedAttempts }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "DENIAL_RATE_EXCEEDED",
        detail: expect.stringContaining("5"),
      });
    });

    it("does not count denials outside the window", () => {
      // window_seconds is 3600 — these are all more than an hour before NOW.
      const staleDenials = Array.from({ length: 5 }, (_, i) => new Date(NOW.getTime() - 3600_000 - i * 1000));
      const result = evaluate({
        ...makeInput(),
        state: makeState({ denied_attempts: staleDenials }),
      });
      expect(result.reason_code).not.toBe("DENIAL_RATE_EXCEEDED");
    });

    it("does not brick a legitimate agent — denials below the threshold don't trigger it", () => {
      const fewDenials = Array.from({ length: 4 }, (_, i) => new Date(NOW.getTime() - i * 1000));
      const result = evaluate({
        ...makeInput(),
        state: makeState({ denied_attempts: fewDenials }),
      });
      // 4 prior denials, cap is 5 — this intent should be evaluated normally,
      // not blocked by the cap itself.
      expect(result.reason_code).not.toBe("DENIAL_RATE_EXCEEDED");
    });
  });

  // ── 3. MANDATE_NOT_YET_VALID ──────────────────────────────────
  describe("MANDATE_NOT_YET_VALID", () => {
    it("denies when now is before not_before", () => {
      const result = evaluate({
        ...makeInput(),
        now: new Date("2026-08-27T12:00:00Z"),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "MANDATE_NOT_YET_VALID",
        detail: expect.any(String),
      });
    });

    it("treats not_before exactly as valid", () => {
      // Code checks `ts < not_before`, so the boundary instant itself is
      // not yet-invalid — a deliberate choice, pinned here rather than
      // left accidental.
      const result = evaluate({
        ...makeInput(),
        now: NOT_BEFORE,
      });
      expect(result.kind).not.toBe("DENY");
    });
  });

  // ── 4. MANDATE_EXPIRED ────────────────────────────────────────
  describe("MANDATE_EXPIRED", () => {
    it("denies when now is after not_after", () => {
      const result = evaluate({
        ...makeInput(),
        now: new Date("2026-08-29T00:00:01Z"),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "MANDATE_EXPIRED",
        detail: expect.any(String),
      });
    });

    it("treats the expiry instant itself as still valid", () => {
      // Code checks `ts > not_after`, so the boundary instant itself has
      // not yet expired — a deliberate choice, pinned here rather than
      // left accidental.
      const result = evaluate({
        ...makeInput(),
        now: NOT_AFTER,
      });
      expect(result.kind).not.toBe("DENY");
    });
  });

  // ── 5. MANDATE_SUBJECT_MISMATCH ───────────────────────────────
  describe("MANDATE_SUBJECT_MISMATCH", () => {
    it("denies when intent.mandate_id differs from mandate.mandate_id", () => {
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({ mandate_id: "mnd_wrong" }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "MANDATE_SUBJECT_MISMATCH",
        detail: expect.any(String),
      });
    });
  });

  // ── 5b. AMOUNT_INVALID (mandate currency) ─────────────────────
  describe("AMOUNT_INVALID — mandate currency", () => {
    it("still denies an unsupported mandate currency", () => {
      // scope.currency only allows supported currencies at compile time. The
      // only way to construct another is to bypass the type, which is exactly
      // the untyped-hydration boundary this check defends against.
      const mandate = makeMandate({
        scope: {
          merchant_ids: [MERCHANT],
          categories: [CATEGORY],
          currency: "JPY" as VerifiedMandate["scope"]["currency"],
        },
      });
      const result = evaluate({ ...makeInput(), mandate });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "AMOUNT_INVALID",
        detail: expect.stringContaining("JPY"),
      });
    });
  });

  // ── 10b. CURRENCY_MISMATCH ────────────────────────────────────
  describe("CURRENCY_MISMATCH", () => {
    const SKU_B = "SKU_FOOD_002";
    const SKU_C = "SKU_FOOD_003";

    function itemIn(sku: string, currency: "INR" | "USD", price: bigint, category = CATEGORY) {
      return [sku, { sku, category, price_minor: minor(price), currency, stock_qty: 10 }] as const;
    }

    function mandateIn(currency: "INR" | "USD"): VerifiedMandate {
      return makeMandate({ scope: { merchant_ids: [MERCHANT], categories: [CATEGORY], currency } });
    }

    const transacted = makeState({ merchants_transacted: new Set([MERCHANT]) });

    it("allows a USD mandate buying a USD item, with the exact amount", () => {
      const result = evaluate({
        ...makeInput(),
        mandate: mandateIn("USD"),
        state: transacted,
        catalog: makeCatalog({ items: new Map([itemIn(SKU, "USD", 1250n)]) }),
      });
      expect(result.kind).toBe("ALLOW");
      expect(result.kind !== "DENY" && result.amount_minor).toBe(1250n);
    });

    it("steps up a USD purchase at a new merchant exactly as it would in INR", () => {
      const result = evaluate({
        ...makeInput(),
        mandate: mandateIn("USD"),
        catalog: makeCatalog({ items: new Map([itemIn(SKU, "USD", 1250n)]) }),
      });
      expect(result).toEqual({ kind: "STEP_UP", amount_minor: 1250n, reason_code: "STEP_UP_FIRST_MERCHANT" });
    });

    it("denies a USD mandate buying an INR item", () => {
      // The case this exists for: 50000 means ₹500 here, and would read as $500.
      const result = evaluate({
        ...makeInput(),
        mandate: mandateIn("USD"),
        state: transacted,
        catalog: makeCatalog({ items: new Map([itemIn(SKU, "INR", 50000n)]) }),
      });
      expect(result).toEqual({ kind: "DENY", reason_code: "CURRENCY_MISMATCH", detail: expect.stringContaining(SKU) });
    });

    it("denies an INR mandate buying a USD item", () => {
      const result = evaluate({
        ...makeInput(),
        mandate: mandateIn("INR"),
        state: transacted,
        catalog: makeCatalog({ items: new Map([itemIn(SKU, "USD", 1250n)]) }),
      });
      expect(result).toEqual({ kind: "DENY", reason_code: "CURRENCY_MISMATCH", detail: expect.stringContaining(SKU) });
    });

    it("denies a cart where only one item is in the wrong currency", () => {
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({
          line_items: [
            { sku: SKU, qty: 1 },
            { sku: SKU_B, qty: 1 },
          ],
        }),
        mandate: mandateIn("USD"),
        state: transacted,
        catalog: makeCatalog({ items: new Map([itemIn(SKU, "USD", 1250n), itemIn(SKU_B, "INR", 1250n)]) }),
      });
      expect(result).toEqual({ kind: "DENY", reason_code: "CURRENCY_MISMATCH", detail: expect.stringContaining(SKU_B) });
    });

    it("reports the mismatch deterministically across cart order", () => {
      // SKU_B is the wrong currency, SKU_C is unknown. Sorted order reaches SKU_B
      // first, however the agent happened to list the cart.
      const catalog = makeCatalog({ items: new Map([itemIn(SKU, "USD", 1250n), itemIn(SKU_B, "INR", 1250n)]) });
      const carts = [
        [SKU, SKU_B, SKU_C],
        [SKU_C, SKU_B, SKU],
        [SKU_B, SKU_C, SKU],
      ];
      const results = carts.map((order) =>
        evaluate({
          ...makeInput(),
          intent: makeIntent({ line_items: order.map((sku) => ({ sku, qty: 1 })) }),
          mandate: mandateIn("USD"),
          state: transacted,
          catalog,
        }),
      );
      for (const result of results) {
        expect(result).toEqual(results[0]);
        expect(result).toEqual({ kind: "DENY", reason_code: "CURRENCY_MISMATCH", detail: expect.stringContaining(SKU_B) });
      }
    });

    it("an unknown SKU still reports SKU_UNKNOWN, since it has no currency to compare", () => {
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({ line_items: [{ sku: "SKU_MISSING", qty: 1 }] }),
        mandate: mandateIn("USD"),
        catalog: makeCatalog({ items: new Map([itemIn(SKU, "INR", 1250n)]) }),
      });
      expect(result).toMatchObject({ kind: "DENY", reason_code: "SKU_UNKNOWN" });
    });

    it("is checked before category, so a wrong-currency item never reaches the amount", () => {
      const result = evaluate({
        ...makeInput(),
        mandate: mandateIn("USD"),
        state: transacted,
        catalog: makeCatalog({ items: new Map([itemIn(SKU, "INR", 1250n, "giftcard")]) }),
      });
      expect(result).toMatchObject({ kind: "DENY", reason_code: "CURRENCY_MISMATCH" });
    });
  });

  // ── 6. MERCHANT_OUT_OF_SCOPE ──────────────────────────────────
  describe("MERCHANT_OUT_OF_SCOPE", () => {
    it("denies when merchant not in mandate scope", () => {
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({ merchant_id: OTHER_MERCHANT }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "MERCHANT_OUT_OF_SCOPE",
        detail: expect.stringContaining(OTHER_MERCHANT),
      });
    });

    it("denies when catalog merchant does not match intent merchant", () => {
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({ merchant_id: MERCHANT }),
        catalog: makeCatalog({ merchant_id: OTHER_MERCHANT }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "MERCHANT_OUT_OF_SCOPE",
        detail: expect.stringContaining("Catalog merchant"),
      });
    });
  });

  // ── 7. AMOUNT_INVALID (empty / bad qty) ──────────────────────
  describe("AMOUNT_INVALID — line items", () => {
    it("denies empty line_items", () => {
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({ line_items: [] }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "AMOUNT_INVALID",
        detail: expect.any(String),
      });
    });

    it("denies zero quantity", () => {
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({ line_items: [{ sku: SKU, qty: 0 }] }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "AMOUNT_INVALID",
        detail: expect.any(String),
      });
    });

    it("denies negative quantity", () => {
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({ line_items: [{ sku: SKU, qty: -1 }] }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "AMOUNT_INVALID",
        detail: expect.any(String),
      });
    });

    it("denies fractional quantity", () => {
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({ line_items: [{ sku: SKU, qty: 1.5 }] }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "AMOUNT_INVALID",
        detail: expect.any(String),
      });
    });
  });

  // ── 8. SKU_UNKNOWN ────────────────────────────────────────────
  describe("SKU_UNKNOWN", () => {
    it("denies when SKU is not in catalog", () => {
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({ line_items: [{ sku: "SKU_GHOST", qty: 1 }] }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "SKU_UNKNOWN",
        detail: expect.stringContaining("SKU_GHOST"),
      });
    });
  });

  // ── 9. CATEGORY_OUT_OF_SCOPE ──────────────────────────────────
  describe("CATEGORY_OUT_OF_SCOPE", () => {
    it("denies when SKU category is not in mandate scope", () => {
      const catalog: CatalogSnapshot = {
        merchant_id: MERCHANT,
        items: new Map([
          [
            "SKU_ELEC_001",
            {
              sku: "SKU_ELEC_001",
              category: "electronics",
              price_minor: minor(10000n),
              currency: "INR",
              stock_qty: 5,
            },
          ],
        ]),
      };
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({ line_items: [{ sku: "SKU_ELEC_001", qty: 1 }] }),
        catalog,
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "CATEGORY_OUT_OF_SCOPE",
        detail: expect.stringContaining("electronics"),
      });
    });
  });

  // ── 10. INSUFFICIENT_STOCK ────────────────────────────────────
  describe("INSUFFICIENT_STOCK", () => {
    it("denies when requested qty exceeds stock", () => {
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({ line_items: [{ sku: SKU, qty: 999 }] }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "INSUFFICIENT_STOCK",
        detail: expect.stringContaining("999"),
      });
    });
  });

  // ── 11. AMOUNT_INVALID (zero resolved amount) ────────────────
  describe("AMOUNT_INVALID — zero amount", () => {
    it("denies when resolved amount is zero", () => {
      const catalog: CatalogSnapshot = {
        merchant_id: MERCHANT,
        items: new Map([
          [
            SKU,
            {
              sku: SKU,
              category: CATEGORY,
              price_minor: minor(0n),
              currency: "INR",
              stock_qty: 10,
            },
          ],
        ]),
      };
      const result = evaluate({
        ...makeInput(),
        catalog,
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "AMOUNT_INVALID",
        detail: expect.stringContaining("zero"),
      });
    });
  });

  // ── 12. MANDATE_AMOUNT_EXCEEDED ──────────────────────────────
  describe("MANDATE_AMOUNT_EXCEEDED", () => {
    it("denies when amount exceeds max_per_txn_minor", () => {
      const catalog: CatalogSnapshot = {
        merchant_id: MERCHANT,
        items: new Map([
          [
            SKU,
            {
              sku: SKU,
              category: CATEGORY,
              price_minor: minor(90000n),
              currency: "INR",
              stock_qty: 10,
            },
          ],
        ]),
      };
      const result = evaluate({
        ...makeInput(),
        catalog,
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "MANDATE_AMOUNT_EXCEEDED",
        detail: expect.any(String),
      });
    });
  });

  // ── 13. MANDATE_BUDGET_EXHAUSTED ─────────────────────────────
  describe("MANDATE_BUDGET_EXHAUSTED", () => {
    it("denies when spent + amount > max_total_minor", () => {
      const result = evaluate({
        ...makeInput(),
        state: makeState({ spent_minor: minor(495000n) }),
        // amount = 10000 (default SKU price × 1 qty), spent + amount = 505000 > 500000
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "MANDATE_BUDGET_EXHAUSTED",
        detail: expect.any(String),
      });
    });

    it("denies at exactly one minor unit over budget", () => {
      const mandate = makeMandate({
        limits: {
          max_per_txn_minor: minor(100000n),
          max_total_minor: minor(20000n),
          max_txns_per_window: 5,
          window_seconds: 3600,
          max_denials_per_window: 5,
        },
      });
      const catalog: CatalogSnapshot = {
        merchant_id: MERCHANT,
        items: new Map([
          [
            SKU,
            {
              sku: SKU,
              category: CATEGORY,
              price_minor: minor(10001n),
              currency: "INR",
              stock_qty: 10,
            },
          ],
        ]),
      };
      const result = evaluate({
        ...makeInput(),
        mandate,
        catalog,
        state: makeState({ spent_minor: minor(10000n) }),
        // spent=10000, amount=10001, total=20001 > 20000
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "MANDATE_BUDGET_EXHAUSTED",
        detail: expect.any(String),
      });
    });
  });

  // ── 14. VELOCITY_EXCEEDED ────────────────────────────────────
  describe("VELOCITY_EXCEEDED", () => {
    it("denies when txns in window >= max_txns_per_window", () => {
      // All 5 timestamps well inside the 3600s window
      const timestamps = Array.from({ length: 5 }, (_, i) =>
        new Date(NOW.getTime() - (i + 1) * 60_000),
      );
      const result = evaluate({
        ...makeInput(),
        state: makeState({
          txn_timestamps: timestamps,
          merchants_transacted: new Set([MERCHANT]),
        }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "VELOCITY_EXCEEDED",
        detail: expect.any(String),
      });
    });

    it("allows when txns are outside the window", () => {
      // 5 txns all more than 3600s ago — outside the window
      const timestamps = Array.from({ length: 5 }, (_, i) =>
        new Date(NOW.getTime() - (3600 + i * 60 + 1) * 1000),
      );
      const result = evaluate({
        ...makeInput(),
        state: makeState({
          txn_timestamps: timestamps,
          merchants_transacted: new Set([MERCHANT]),
        }),
      });
      expect(result.kind).not.toBe("DENY");
    });
  });

  // ── 15. STEP_UP_FIRST_MERCHANT ───────────────────────────────
  describe("STEP_UP_FIRST_MERCHANT", () => {
    it("triggers when merchant not in merchants_transacted", () => {
      const result = evaluate(makeInput());
      expect(result).toEqual({
        kind: "STEP_UP",
        amount_minor: minor(10000n),
        reason_code: "STEP_UP_FIRST_MERCHANT",
      });
    });
  });

  // ── 16. STEP_UP_THRESHOLD ────────────────────────────────────
  describe("STEP_UP_THRESHOLD", () => {
    it("triggers when amount >= threshold", () => {
      const catalog: CatalogSnapshot = {
        merchant_id: MERCHANT,
        items: new Map([
          [
            SKU,
            {
              sku: SKU,
              category: CATEGORY,
              price_minor: minor(50000n),
              currency: "INR",
              stock_qty: 10,
            },
          ],
        ]),
      };
      const result = evaluate({
        ...makeInput(),
        catalog,
        state: makeState({ merchants_transacted: new Set([MERCHANT]) }),
      });
      expect(result).toEqual({
        kind: "STEP_UP",
        amount_minor: minor(50000n),
        reason_code: "STEP_UP_THRESHOLD",
      });
    });

    it("at exactly the threshold (≥, not >)", () => {
      const mandate = makeMandate({
        step_up: { threshold_minor: minor(10000n) },
      });
      const result = evaluate({
        ...makeInput(),
        mandate,
        state: makeState({ merchants_transacted: new Set([MERCHANT]) }),
      });
      expect(result).toEqual({
        kind: "STEP_UP",
        amount_minor: minor(10000n),
        reason_code: "STEP_UP_THRESHOLD",
      });
    });
  });

  // ── 17. ALLOW ────────────────────────────────────────────────
  describe("ALLOW", () => {
    it("returns amount and remaining_minor", () => {
      const result = evaluate({
        ...makeInput(),
        state: makeState({
          spent_minor: minor(100000n),
          merchants_transacted: new Set([MERCHANT]),
        }),
      });
      expect(result).toEqual({
        kind: "ALLOW",
        amount_minor: minor(10000n),
        reason_code: "OK",
        remaining_minor: minor(390000n), // 500000 - 100000 - 10000
      });
    });

    it("allows at exactly max_per_txn_minor (boundary: allowed, not denied)", () => {
      const mandate = makeMandate({
        step_up: { threshold_minor: minor(80001n) },
      });
      const catalog: CatalogSnapshot = {
        merchant_id: MERCHANT,
        items: new Map([
          [
            SKU,
            {
              sku: SKU,
              category: CATEGORY,
              price_minor: minor(80000n),
              currency: "INR",
              stock_qty: 10,
            },
          ],
        ]),
      };
      const result = evaluate({
        ...makeInput(),
        mandate,
        catalog,
        state: makeState({ merchants_transacted: new Set([MERCHANT]) }),
      });
      expect(result).toEqual({
        kind: "ALLOW",
        amount_minor: minor(80000n),
        reason_code: "OK",
        remaining_minor: minor(420000n), // 500000 - 0 - 80000
      });
    });
  });

  // ── Boundary: velocity at exactly the window edge ────────────
  describe("velocity boundary", () => {
    it("allows txn at exactly the window edge (not counted)", () => {
      // One txn at exactly 3600s ago — ts - t = 3600000, which is NOT < 3600000
      const edgeTime = new Date(NOW.getTime() - 3600 * 1000);
      const result = evaluate({
        ...makeInput(),
        state: makeState({
          txn_timestamps: [edgeTime, edgeTime, edgeTime, edgeTime, edgeTime],
          merchants_transacted: new Set([MERCHANT]),
        }),
      });
      // 0 txns inside the window (< 3600000ms), so velocity passes
      expect(result.kind).not.toBe("DENY");
    });

    it("allows when only one txn is inside the window edge (count below limit)", () => {
      // 4 txns 3601s ago (outside), 1 txn 3599s ago (inside) — 1 < 5, should pass
      const outside = new Date(NOW.getTime() - 3601 * 1000);
      const inside = new Date(NOW.getTime() - 3599 * 1000);
      const result = evaluate({
        ...makeInput(),
        state: makeState({
          txn_timestamps: [outside, outside, outside, outside, inside],
          merchants_transacted: new Set([MERCHANT]),
        }),
      });
      expect(result.kind).not.toBe("DENY");
    });
  });

  // ── Boundary: multi-item cart breaches total but not per-item ─
  describe("multi-item boundary", () => {
    it("denies when total exceeds cap but no single item does", () => {
      // max_per_txn = 80000 (₹800). Two DISTINCT SKUs at 45000 each: neither
      // item alone breaches the cap, but the summed cart (90000) does.
      const SKU_B = "SKU_FOOD_002";
      const catalog: CatalogSnapshot = {
        merchant_id: MERCHANT,
        items: new Map([
          [
            SKU,
            {
              sku: SKU,
              category: CATEGORY,
              price_minor: minor(45000n),
              currency: "INR",
              stock_qty: 10,
            },
          ],
          [
            SKU_B,
            {
              sku: SKU_B,
              category: CATEGORY,
              price_minor: minor(45000n),
              currency: "INR",
              stock_qty: 10,
            },
          ],
        ]),
      };
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({
          line_items: [
            { sku: SKU, qty: 1 },
            { sku: SKU_B, qty: 1 },
          ],
        }),
        catalog,
        state: makeState({ merchants_transacted: new Set([MERCHANT]) }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "MANDATE_AMOUNT_EXCEEDED",
        detail: expect.any(String),
      });
    });
  });

  // ── Duplicate SKU aggregation ─────────────────────────────────
  describe("duplicate SKU aggregation", () => {
    it("denies insufficient stock when duplicate line items sum past stock_qty", () => {
      // Same SKU split across two line items, 6 + 6 = 12, against stock of 10.
      // Checking each line item independently (6 <= 10, 6 <= 10) misses this.
      // Price is kept low so the per-txn cap doesn't mask the stock bug.
      const catalog: CatalogSnapshot = {
        merchant_id: MERCHANT,
        items: new Map([
          [
            SKU,
            {
              sku: SKU,
              category: CATEGORY,
              price_minor: minor(1000n),
              currency: "INR",
              stock_qty: 10,
            },
          ],
        ]),
      };
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({
          line_items: [
            { sku: SKU, qty: 6 },
            { sku: SKU, qty: 6 },
          ],
        }),
        catalog,
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "INSUFFICIENT_STOCK",
        detail: expect.any(String),
      });
    });

    it("returns the same reason code regardless of line-item order", () => {
      // Two invalid SKUs, invalid for DIFFERENT reasons: one unknown to the
      // catalog, one known but out of the mandate's category scope. Which
      // reason code comes back must depend only on the SKUs, never on which
      // one the agent happened to list first.
      const catalog: CatalogSnapshot = {
        merchant_id: MERCHANT,
        items: new Map([
          [
            "SKU_ELEC_001",
            {
              sku: "SKU_ELEC_001",
              category: "electronics",
              price_minor: minor(1000n),
              currency: "INR",
              stock_qty: 10,
            },
          ],
        ]),
      };
      const forward = evaluate({
        ...makeInput(),
        intent: makeIntent({
          line_items: [
            { sku: "SKU_ELEC_001", qty: 1 },
            { sku: "SKU_GHOST", qty: 1 },
          ],
        }),
        catalog,
      });
      const reversed = evaluate({
        ...makeInput(),
        intent: makeIntent({
          line_items: [
            { sku: "SKU_GHOST", qty: 1 },
            { sku: "SKU_ELEC_001", qty: 1 },
          ],
        }),
        catalog,
      });
      expect(forward).toEqual(reversed);
    });
  });

  // ── Precedence: ordering is the security property ────────────
  describe("precedence", () => {
    it("denies unknown SKU before evaluating amount", () => {
      // Unknown SKU alongside a known SKU whose price alone would breach
      // the per-txn cap. If amount were resolved first, this could ALLOW
      // or fail differently. SKU_UNKNOWN must win — validate before compute.
      const catalog: CatalogSnapshot = {
        merchant_id: MERCHANT,
        items: new Map([
          [
            SKU,
            {
              sku: SKU,
              category: CATEGORY,
              price_minor: minor(90000n), // exceeds max_per_txn_minor (80000) alone
              currency: "INR",
              stock_qty: 10,
            },
          ],
        ]),
      };
      const result = evaluate({
        ...makeInput(),
        intent: makeIntent({
          line_items: [
            { sku: SKU, qty: 1 },
            { sku: "SKU_GHOST", qty: 1 },
          ],
        }),
        catalog,
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "SKU_UNKNOWN",
        detail: expect.stringContaining("SKU_GHOST"),
      });
    });

    it("expired mandate beats an otherwise-allowable purchase", () => {
      // now is after not_after, but the cart is well within every other limit.
      const result = evaluate({
        ...makeInput(),
        now: new Date("2026-08-29T00:00:01Z"),
        state: makeState({ merchants_transacted: new Set([MERCHANT]) }),
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "MANDATE_EXPIRED",
        detail: expect.any(String),
      });
    });

    it("first-merchant step-up takes precedence over threshold step-up", () => {
      // New merchant AND amount above threshold — must report FIRST_MERCHANT,
      // not THRESHOLD, per the check ordering.
      const catalog: CatalogSnapshot = {
        merchant_id: MERCHANT,
        items: new Map([
          [
            SKU,
            {
              sku: SKU,
              category: CATEGORY,
              price_minor: minor(60000n), // above default threshold of 50000
              currency: "INR",
              stock_qty: 10,
            },
          ],
        ]),
      };
      const result = evaluate({
        ...makeInput(),
        catalog,
        // merchants_transacted left empty — this is the first purchase at MERCHANT
      });
      expect(result).toEqual({
        kind: "STEP_UP",
        amount_minor: minor(60000n),
        reason_code: "STEP_UP_FIRST_MERCHANT",
      });
    });
  });

  // ── Property tests ──────────────────────────────────────────
  describe("properties", () => {
    it("same input evaluated twice gives identical output", () => {
      const input = makeInput();
      const a = evaluate(input);
      const b = evaluate(input);
      expect(a).toEqual(b);
    });

    it("budget denial is monotonic across a sweep of increasing spend", () => {
      // Default mandate: max_total_minor = 500000n. Default intent resolves
      // to amount = 10000n (SKU price 10000 * qty 1). Denial begins the
      // first minor unit past (max_total - amount); once true, it must stay true
      // for every higher spend — a real sweep, not two spot checks.
      const maxTotal = 500000n;
      const amount = 10000n;
      const denialStarts = maxTotal - amount + 1n;

      for (let spend = denialStarts; spend <= denialStarts + 100000n; spend += 5000n) {
        const result = evaluate({
          ...makeInput(),
          state: makeState({ spent_minor: minor(spend) }),
        });
        expect(result).toMatchObject({
          kind: "DENY",
          reason_code: "MANDATE_BUDGET_EXHAUSTED",
        });
      }
    });

    it("1000 random inputs never throw", () => {
      // Seeded LCG, not Math.random() — a failure on a given iteration must
      // be reproducible by re-running with the same seed.
      const rand = makeRng(42);

      for (let i = 0; i < 1000; i++) {
        const qty = Math.floor(rand() * 10) + 1;
        const stock = qty + Math.floor(rand() * 10);
        const price = BigInt(Math.floor(rand() * 100000) + 1);
        const maxPerTxn = BigInt(Math.floor(rand() * 200000) + 1);
        const maxTotal = maxPerTxn + BigInt(Math.floor(rand() * 200000));
        const spent = BigInt(Math.floor(rand() * Number(maxTotal)));
        const windowSec = Math.floor(rand() * 7200) + 1;
        const maxTxns = Math.floor(rand() * 10) + 1;
        const threshold = BigInt(Math.floor(rand() * 200000) + 1);
        const numPastTxns = Math.floor(rand() * 10);
        const transactedMerchant = rand() > 0.5 ? MERCHANT : OTHER_MERCHANT;

        const input: EvaluateInput = {
          intent: {
            intent_id: `int_${i}`,
            mandate_id: "mnd_01",
            merchant_id: MERCHANT,
            line_items: [{ sku: SKU, qty }],
            requested_at: NOW.toISOString(),
            agent_rationale: "random",
          },
          mandate: makeMandate({
            limits: {
              max_per_txn_minor: minor(maxPerTxn),
              max_total_minor: minor(maxTotal),
              max_txns_per_window: maxTxns,
              window_seconds: windowSec,
              max_denials_per_window: 5,
            },
            step_up: { threshold_minor: minor(threshold) },
          }),
          state: makeState({
            spent_minor: minor(spent),
            merchants_transacted: new Set([transactedMerchant]),
            txn_timestamps: Array.from({ length: numPastTxns }, (_, j) =>
              new Date(NOW.getTime() - j * 60000),
            ),
          }),
          catalog: makeCatalog({
            items: new Map([
              [
                SKU,
                {
                  sku: SKU,
                  category: CATEGORY,
                  price_minor: minor(price),
                  currency: "INR",
                  stock_qty: stock,
                },
              ],
            ]),
          }),
          now: NOW,
          idempotency_key: `idem_${i}`,
        };

        expect(() => evaluate(input)).not.toThrow();
      }
    });

    it("does not mutate the plain-object/array parts of its input", () => {
      // deepFreeze cannot lock down catalog.items (a Map), merchants_transacted
      // or seen_idempotency_keys (Sets) — see its comment. This covers intent,
      // mandate, and the array/object shapes within them; it is not a proof
      // that evaluate() never calls .set() or .add() on the collections.
      const input = deepFreeze(makeInput());
      expect(() => evaluate(input)).not.toThrow();
    });
  });
});
