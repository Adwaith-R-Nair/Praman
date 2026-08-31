import { addPaise, mulPaise, subPaise, ZERO_PAISE } from "@praman/shared";
import type { Decision, EvaluateInput } from "./types.js";

export function evaluate(input: EvaluateInput): Decision {
  const { intent, mandate, state, catalog, now, idempotency_key } = input;
  const ts = now.getTime();

  // 1. Idempotency — cheap, fatal, irreversible.
  if (state.seen_idempotency_keys.includes(idempotency_key)) {
    return {
      kind: "DENY",
      reason_code: "DUPLICATE_INTENT",
      detail: `Idempotency key ${idempotency_key} has already been processed.`,
    };
  }

  // 2. Revocation — ledger-derived, no DB read needed.
  if (state.revoked) {
    return {
      kind: "DENY",
      reason_code: "MANDATE_REVOKED",
      detail: "This mandate has been revoked by the issuer.",
    };
  }

  // 3. Validity window — before not_before.
  if (ts < mandate.validity.not_before.getTime()) {
    return {
      kind: "DENY",
      reason_code: "MANDATE_NOT_YET_VALID",
      detail: `Mandate is not yet valid. Valid from ${mandate.validity.not_before.toISOString()}.`,
    };
  }

  // 4. Validity window — after not_after.
  if (ts > mandate.validity.not_after.getTime()) {
    return {
      kind: "DENY",
      reason_code: "MANDATE_EXPIRED",
      detail: `Mandate expired at ${mandate.validity.not_after.toISOString()}.`,
    };
  }

  // 5. Subject binding — intent must reference this exact mandate.
  if (intent.mandate_id !== mandate.mandate_id) {
    return {
      kind: "DENY",
      reason_code: "MANDATE_SUBJECT_MISMATCH",
      detail: `Intent references mandate ${intent.mandate_id}, expected ${mandate.mandate_id}.`,
    };
  }

  // 6. Merchant scope — closed allowlist, no wildcard.
  if (!mandate.scope.merchant_ids.includes(intent.merchant_id)) {
    return {
      kind: "DENY",
      reason_code: "MERCHANT_OUT_OF_SCOPE",
      detail: `Merchant ${intent.merchant_id} is not in the allowed merchant list.`,
    };
  }

  // 7. Catalog merchant binding — catalog must match intent merchant.
  if (catalog.merchant_id !== intent.merchant_id) {
    return {
      kind: "DENY",
      reason_code: "MERCHANT_OUT_OF_SCOPE",
      detail: `Catalog merchant ${catalog.merchant_id} does not match intent merchant ${intent.merchant_id}.`,
    };
  }

  // 8. Line items sanity — empty cart or non-positive qty is invalid.
  if (
    intent.line_items.length === 0 ||
    intent.line_items.some((item) => !Number.isInteger(item.qty) || item.qty <= 0)
  ) {
    return {
      kind: "DENY",
      reason_code: "AMOUNT_INVALID",
      detail: "Cart is empty or contains items with non-positive integer quantities.",
    };
  }

  // 9. Aggregate quantities per SKU. Duplicate line items must not each
  //    pass the stock check independently — a cart split across two line
  //    items for the same SKU is still one demand on that SKU's stock.
  const quantities = new Map<string, number>();
  for (const item of intent.line_items) {
    quantities.set(item.sku, (quantities.get(item.sku) ?? 0) + item.qty);
  }

  // 10–12. Validate each distinct SKU once against the aggregated
  // quantity, then resolve the amount from the catalog. One lookup per
  // SKU — prices never come from the model.
  let amount = ZERO_PAISE;
  for (const [sku, qty] of quantities) {
    const catalogItem = catalog.items.get(sku);
    if (catalogItem === undefined) {
      return {
        kind: "DENY",
        reason_code: "SKU_UNKNOWN",
        detail: `SKU ${sku} is not in the merchant catalog.`,
      };
    }
    if (!mandate.scope.categories.includes(catalogItem.category)) {
      return {
        kind: "DENY",
        reason_code: "CATEGORY_OUT_OF_SCOPE",
        detail: `Category ${catalogItem.category} is not in the allowed category list.`,
      };
    }
    if (qty > catalogItem.stock_qty) {
      return {
        kind: "DENY",
        reason_code: "INSUFFICIENT_STOCK",
        detail: `Requested quantity ${qty} for SKU ${sku} exceeds available stock ${catalogItem.stock_qty}.`,
      };
    }
    amount = addPaise(amount, mulPaise(catalogItem.price_paise, qty));
  }

  // 13. Amount must be positive.
  if (amount === ZERO_PAISE) {
    return {
      kind: "DENY",
      reason_code: "AMOUNT_INVALID",
      detail: "Resolved amount is zero.",
    };
  }

  // 14. Per-transaction cap.
  if (amount > mandate.limits.max_per_txn_paise) {
    return {
      kind: "DENY",
      reason_code: "MANDATE_AMOUNT_EXCEEDED",
      detail: `Amount ${amount.toString()} paise exceeds per-transaction limit ${mandate.limits.max_per_txn_paise.toString()} paise.`,
    };
  }

  // 15. Cumulative budget.
  if (addPaise(state.spent_paise, amount) > mandate.limits.max_total_paise) {
    return {
      kind: "DENY",
      reason_code: "MANDATE_BUDGET_EXHAUSTED",
      detail: `Spending ${addPaise(state.spent_paise, amount).toString()} paise would exceed total budget ${mandate.limits.max_total_paise.toString()} paise.`,
    };
  }

  // 16. Velocity — count timestamps strictly inside the window.
  const windowMs = mandate.limits.window_seconds * 1000;
  const txnsInWindow = state.txn_timestamps.filter(
    (t) => ts - t.getTime() < windowMs,
  ).length;
  if (txnsInWindow >= mandate.limits.max_txns_per_window) {
    return {
      kind: "DENY",
      reason_code: "VELOCITY_EXCEEDED",
      detail: `${txnsInWindow} transactions in the last ${mandate.limits.window_seconds.toString()} seconds exceeds limit of ${mandate.limits.max_txns_per_window.toString()}.`,
    };
  }

  // 17. First-merchant step-up — merchant not yet transacted under this mandate.
  if (!state.merchants_transacted.includes(intent.merchant_id)) {
    return {
      kind: "STEP_UP",
      amount_paise: amount,
      reason_code: "STEP_UP_FIRST_MERCHANT",
    };
  }

  // 18. Threshold step-up — amount at or above the human-approval threshold.
  if (amount >= mandate.step_up.threshold_paise) {
    return {
      kind: "STEP_UP",
      amount_paise: amount,
      reason_code: "STEP_UP_THRESHOLD",
    };
  }

  // 19. All clear.
  return {
    kind: "ALLOW",
    amount_paise: amount,
    reason_code: "OK",
    remaining_paise: subPaise(subPaise(mandate.limits.max_total_paise, state.spent_paise), amount),
  };
}
