import { describe, expect, it } from "vitest";
import { paise } from "@praman/shared";
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

/** Recursively freezes an object graph, including Map values. */
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
      max_per_txn_paise: paise(80000n),
      max_total_paise: paise(500000n),
      max_txns_per_window: 5,
      window_seconds: 3600,
    },
    step_up: {
      threshold_paise: paise(50000n),
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
    spent_paise: paise(0n),
    txn_timestamps: [],
    revoked: false,
    merchants_transacted: new Set<string>(),
    seen_idempotency_keys: new Set<string>(),
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
          price_paise: paise(10000n),
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
    it("denies when mandate currency is not INR", () => {
      // scope.currency is typed as the literal "INR" — the only way to
      // construct a non-INR mandate is to bypass the type, which is exactly
      // the untyped-hydration boundary this check defends against.
      const mandate = makeMandate({
        scope: {
          merchant_ids: [MERCHANT],
          categories: [CATEGORY],
          currency: "USD" as VerifiedMandate["scope"]["currency"],
        },
      });
      const result = evaluate({ ...makeInput(), mandate });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "AMOUNT_INVALID",
        detail: expect.stringContaining("USD"),
      });
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
              price_paise: paise(10000n),
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
              price_paise: paise(0n),
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
    it("denies when amount exceeds max_per_txn_paise", () => {
      const catalog: CatalogSnapshot = {
        merchant_id: MERCHANT,
        items: new Map([
          [
            SKU,
            {
              sku: SKU,
              category: CATEGORY,
              price_paise: paise(90000n),
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
    it("denies when spent + amount > max_total_paise", () => {
      const result = evaluate({
        ...makeInput(),
        state: makeState({ spent_paise: paise(495000n) }),
        // amount = 10000 (default SKU price × 1 qty), spent + amount = 505000 > 500000
      });
      expect(result).toEqual({
        kind: "DENY",
        reason_code: "MANDATE_BUDGET_EXHAUSTED",
        detail: expect.any(String),
      });
    });

    it("denies at exactly one paise over budget", () => {
      const mandate = makeMandate({
        limits: {
          max_per_txn_paise: paise(100000n),
          max_total_paise: paise(20000n),
          max_txns_per_window: 5,
          window_seconds: 3600,
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
              price_paise: paise(10001n),
              stock_qty: 10,
            },
          ],
        ]),
      };
      const result = evaluate({
        ...makeInput(),
        mandate,
        catalog,
        state: makeState({ spent_paise: paise(10000n) }),
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
        amount_paise: paise(10000n),
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
              price_paise: paise(50000n),
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
        amount_paise: paise(50000n),
        reason_code: "STEP_UP_THRESHOLD",
      });
    });

    it("at exactly the threshold (≥, not >)", () => {
      const mandate = makeMandate({
        step_up: { threshold_paise: paise(10000n) },
      });
      const result = evaluate({
        ...makeInput(),
        mandate,
        state: makeState({ merchants_transacted: new Set([MERCHANT]) }),
      });
      expect(result).toEqual({
        kind: "STEP_UP",
        amount_paise: paise(10000n),
        reason_code: "STEP_UP_THRESHOLD",
      });
    });
  });

  // ── 17. ALLOW ────────────────────────────────────────────────
  describe("ALLOW", () => {
    it("returns amount and remaining_paise", () => {
      const result = evaluate({
        ...makeInput(),
        state: makeState({
          spent_paise: paise(100000n),
          merchants_transacted: new Set([MERCHANT]),
        }),
      });
      expect(result).toEqual({
        kind: "ALLOW",
        amount_paise: paise(10000n),
        reason_code: "OK",
        remaining_paise: paise(390000n), // 500000 - 100000 - 10000
      });
    });

    it("allows at exactly max_per_txn_paise (boundary: allowed, not denied)", () => {
      const mandate = makeMandate({
        step_up: { threshold_paise: paise(80001n) },
      });
      const catalog: CatalogSnapshot = {
        merchant_id: MERCHANT,
        items: new Map([
          [
            SKU,
            {
              sku: SKU,
              category: CATEGORY,
              price_paise: paise(80000n),
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
        amount_paise: paise(80000n),
        reason_code: "OK",
        remaining_paise: paise(420000n), // 500000 - 0 - 80000
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
              price_paise: paise(45000n),
              stock_qty: 10,
            },
          ],
          [
            SKU_B,
            {
              sku: SKU_B,
              category: CATEGORY,
              price_paise: paise(45000n),
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
              price_paise: paise(1000n),
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
              price_paise: paise(1000n),
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
              price_paise: paise(90000n), // exceeds max_per_txn_paise (80000) alone
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
              price_paise: paise(60000n), // above default threshold of 50000
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
        amount_paise: paise(60000n),
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
      // Default mandate: max_total_paise = 500000n. Default intent resolves
      // to amount = 10000n (SKU price 10000 * qty 1). Denial begins the
      // first paise past (max_total - amount); once true, it must stay true
      // for every higher spend — a real sweep, not two spot checks.
      const maxTotal = 500000n;
      const amount = 10000n;
      const denialStarts = maxTotal - amount + 1n;

      for (let spend = denialStarts; spend <= denialStarts + 100000n; spend += 5000n) {
        const result = evaluate({
          ...makeInput(),
          state: makeState({ spent_paise: paise(spend) }),
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
              max_per_txn_paise: paise(maxPerTxn),
              max_total_paise: paise(maxTotal),
              max_txns_per_window: maxTxns,
              window_seconds: windowSec,
            },
            step_up: { threshold_paise: paise(threshold) },
          }),
          state: makeState({
            spent_paise: paise(spent),
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
                  price_paise: paise(price),
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

    it("does not mutate its inputs", () => {
      const input = deepFreeze(makeInput());
      expect(() => evaluate(input)).not.toThrow();
    });
  });
});
