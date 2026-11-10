import { describe, expect, it } from "vitest";
import { AP2_LABEL, ap2Lines, inAp2Terms } from "../src/ap2.js";

const V2 = {
  version: 2,
  mandate_id: "mnd_v2",
  issuer_id: "usr_1",
  subject_id: "agt_1",
  scope: { merchant_ids: ["M_1", "M_2"], categories: ["food"], currency: "USD" },
  limits: { max_per_txn_minor: "5000", max_total_minor: "20000", max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 3 },
  step_up: { threshold_minor: "3000" },
  validity: { not_before: "2026-11-01T00:00:00.000Z", not_after: "2026-11-30T00:00:00.000Z" },
  nonce: "a1b2c3d4e5f60718",
};

const V1 = {
  version: 1,
  mandate_id: "mnd_v1",
  issuer_id: "usr_1",
  subject_id: "agt_1",
  scope: { merchant_ids: ["M_1"], categories: ["food"], currency: "INR" },
  limits: { max_per_txn_paise: "50000", max_total_paise: "150000", max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 3 },
  step_up: { threshold_paise: "30000" },
  validity: { not_before: "2026-09-01T00:00:00.000Z", not_after: "2026-09-30T00:00:00.000Z" },
  nonce: "0011223344556677",
};

function row(view: ReturnType<typeof inAp2Terms>, field: string) {
  const found = view?.fields.find((f) => f.praman_field === field);
  if (found === undefined) throw new Error(`no row for ${field}`);
  return found;
}

describe("inAp2Terms", () => {
  it("maps a v2 mandate field by field onto AP2's own names", () => {
    const view = inAp2Terms(V2);
    expect(view?.label).toBe("In AP2 terms (a mapping, not an AP2 mandate)");
    expect(view?.praman_version).toBe(2);
    expect(row(view, "scope.merchant_ids")).toMatchObject({
      praman_value: ["M_1", "M_2"],
      ap2_v0_1: "IntentMandate.merchants",
      ap2_v0_2: "payment.allowed_payees, checkout.allowed_merchants",
      fit: "direct",
    });
    expect(row(view, "limits.max_per_txn_minor")).toMatchObject({ praman_value: "5000", ap2_v0_2: "payment.amount_range, field max", fit: "direct" });
    expect(row(view, "limits.max_total_minor")).toMatchObject({ praman_value: "20000", ap2_v0_2: "payment.budget, field max", fit: "direct" });
    expect(row(view, "scope.currency")).toMatchObject({ praman_value: "USD", fit: "direct" });
    expect(row(view, "step_up.threshold_minor")).toMatchObject({ praman_value: "3000", ap2_v0_1: "IntentMandate.user_cart_confirmation_required", ap2_v0_2: null, fit: "loose" });
    expect(row(view, "validity.not_after")).toMatchObject({ praman_value: "2026-11-30T00:00:00.000Z", ap2_v0_1: "IntentMandate.intent_expiry", fit: "direct" });
    expect(row(view, "scope.categories")).toMatchObject({ praman_value: ["food"], fit: "none" });
    expect(row(view, "limits.max_denials_per_window")).toMatchObject({ praman_value: "3", ap2_v0_1: null, ap2_v0_2: null, fit: "none" });
    expect(row(view, "subject_id")).toMatchObject({ praman_value: "agt_1", ap2_v0_2: "cnf", fit: "gap" });
    expect(row(view, "signature")).toMatchObject({ fit: "gap" });
  });

  it("lists the AP2 fields Praman's mandate has no value for, and does not fill them", () => {
    const view = inAp2Terms(V2);
    expect(view?.ap2_with_no_praman_value.map((r) => r.ap2)).toEqual([
      "IntentMandate.natural_language_description",
      "IntentMandate.skus",
      "IntentMandate.requires_refundability",
      "closed Checkout Mandate (Cart Mandate in v0.1), checkout_jwt",
      "closed Payment Mandate (Payment Mandate in v0.1)",
    ]);
    expect(view?.gaps).toHaveLength(9);
    expect(view?.gaps[0]).toMatch(/^No verifiable-credential format\./);
  });

  it("maps a v1 mandate under its own signed field names, in paise", () => {
    const view = inAp2Terms(V1);
    expect(view?.praman_version).toBe(1);
    expect(row(view, "limits.max_per_txn_paise")).toMatchObject({ praman_value: "50000", ap2_v0_2: "payment.amount_range, field max" });
    expect(row(view, "limits.max_total_paise")).toMatchObject({ praman_value: "150000", ap2_v0_2: "payment.budget, field max" });
    expect(row(view, "step_up.threshold_paise")).toMatchObject({ praman_value: "30000" });
    expect(row(view, "scope.currency").praman_value).toBe("INR");
    expect(view?.fields.some((f) => f.praman_field.endsWith("_minor"))).toBe(false);
  });

  it("returns null for a document it can't read rather than guessing", () => {
    expect(inAp2Terms(null)).toBeNull();
    expect(inAp2Terms({ ...V2, version: 3 })).toBeNull();
    expect(inAp2Terms({ ...V2, version: 1 })).toBeNull();
    expect(inAp2Terms({ ...V2, limits: { ...V2.limits, max_total_minor: 20000 } })).toBeNull();
    expect(inAp2Terms({ mandate_id: "mnd_partial", version: 2, scope: { currency: "USD" } })).toBeNull();
  });

  it("never calls itself an AP2 mandate or compliant", () => {
    const text = JSON.stringify(inAp2Terms(V2)) + ap2Lines(inAp2Terms(V2)).join("\n");
    expect(text.toLowerCase()).not.toMatch(/(?<!not )compliant|compatible|interoperable/);
    expect(AP2_LABEL).toBe("In AP2 terms (a mapping, not an AP2 mandate)");
  });

  it("prints the label first and one line per field for the operator", () => {
    const lines = ap2Lines(inAp2Terms(V2));
    expect(lines[0]).toBe("In AP2 terms (a mapping, not an AP2 mandate)");
    expect(lines).toContain("  limits.max_total_minor = 20000  ->  v0.2 payment.budget, field max  [direct]");
    expect(lines).toContain("  limits.max_denials_per_window = 3  ->  no AP2 counterpart  [none]");
    expect(ap2Lines(null)).toEqual(["In AP2 terms: not shown, because this trace has no verified signed mandate"]);
  });
});
