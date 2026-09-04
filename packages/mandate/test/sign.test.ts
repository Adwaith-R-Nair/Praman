import { describe, expect, it } from "vitest";
import { generateKeypair, signMandate, verifyMandate, type MandateDocument, type SignedMandate } from "../src/sign.js";

const { privateKeyPem, publicKeyPem } = generateKeypair();

const BASE_DOC: MandateDocument = {
  mandate_id: "mnd_test",
  version: 1,
  issuer_id: "usr_adwaith",
  subject_id: "agt_lunchbuyer",
  scope: { merchant_ids: ["MERCH_001"], categories: ["food"], currency: "INR" },
  limits: {
    max_per_txn_paise: "80000",
    max_total_paise: "500000",
    max_txns_per_window: 5,
    window_seconds: 3600,
    max_denials_per_window: 5,
  },
  step_up: { threshold_paise: "50000" },
  validity: { not_before: "2026-08-28T00:00:00.000Z", not_after: "2026-08-29T00:00:00.000Z" },
  nonce: "b0f3c9d2a1e84f77",
};

function sign(doc: MandateDocument = BASE_DOC): SignedMandate {
  return signMandate(doc, privateKeyPem, "usr_adwaith_k1");
}

describe("signMandate / verifyMandate", () => {
  it("a validly signed mandate verifies and hydrates into typed values", () => {
    const result = verifyMandate(sign(), publicKeyPem);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.mandate.mandate_id).toBe("mnd_test");
    expect(result.mandate.limits.max_per_txn_paise).toBe(80000n);
    expect(result.mandate.step_up.threshold_paise).toBe(50000n);
    expect(result.mandate.validity.not_before).toBeInstanceOf(Date);
    expect(result.mandate.validity.not_before.toISOString()).toBe("2026-08-28T00:00:00.000Z");
  });

  it.each([
    ["mandate_id", { mandate_id: "mnd_attacker" }],
    ["subject_id", { subject_id: "agt_attacker" }],
    ["nonce", { nonce: "deadbeefdeadbeef" }],
  ] as const)("mutating %s after signing invalidates the signature", (_name, patch) => {
    const signed = sign();
    const tampered = { ...signed, document: { ...signed.document, ...patch } };
    const result = verifyMandate(tampered, publicKeyPem);
    expect(result).toEqual({ ok: false, reason: "SIGNATURE_INVALID" });
  });

  it("mutating a nested field (limits) after signing invalidates the signature", () => {
    const signed = sign();
    const tampered = {
      ...signed,
      document: { ...signed.document, limits: { ...signed.document.limits, max_per_txn_paise: "999999999" } },
    };
    const result = verifyMandate(tampered, publicKeyPem);
    expect(result).toEqual({ ok: false, reason: "SIGNATURE_INVALID" });
  });

  it("a signature from a different key pair fails", () => {
    const otherKeypair = generateKeypair();
    const result = verifyMandate(sign(), otherKeypair.publicKeyPem);
    expect(result).toEqual({ ok: false, reason: "SIGNATURE_INVALID" });
  });

  it("key-order-shuffled document still verifies — canonical() makes property order irrelevant", () => {
    const reordered: MandateDocument = {
      nonce: BASE_DOC.nonce,
      validity: BASE_DOC.validity,
      step_up: BASE_DOC.step_up,
      limits: BASE_DOC.limits,
      scope: BASE_DOC.scope,
      subject_id: BASE_DOC.subject_id,
      issuer_id: BASE_DOC.issuer_id,
      version: BASE_DOC.version,
      mandate_id: BASE_DOC.mandate_id,
    };
    const signedNormal = sign(BASE_DOC);
    const signedReordered = sign(reordered);
    expect(signedReordered.signature.value).toBe(signedNormal.signature.value);
    expect(verifyMandate(signedReordered, publicKeyPem).ok).toBe(true);
  });

  it("rejects an unsupported signature algorithm", () => {
    const signed = sign();
    const forged = { ...signed, signature: { ...signed.signature, alg: "HS256" as "Ed25519" } };
    expect(verifyMandate(forged, publicKeyPem)).toEqual({ ok: false, reason: "UNSUPPORTED_ALG" });
  });

  it("rejects an invalid validity date as MALFORMED_DOCUMENT, not a silently-always-valid mandate", () => {
    // Regression test: new Date("not-a-date") does not throw, it produces an
    // Invalid Date whose getTime() is NaN. evaluate()'s validity checks
    // compare against that with < and > — always false against NaN — so an
    // unchecked hydration here would make a garbage validity window pass as
    // always-valid rather than always-invalid.
    const badDoc: MandateDocument = { ...BASE_DOC, validity: { ...BASE_DOC.validity, not_before: "not-a-date" } };
    const result = verifyMandate(sign(badDoc), publicKeyPem);
    expect(result).toEqual({ ok: false, reason: "MALFORMED_DOCUMENT" });
  });

  it("rejects a malformed amount string as MALFORMED_DOCUMENT", () => {
    const badDoc: MandateDocument = {
      ...BASE_DOC,
      limits: { ...BASE_DOC.limits, max_per_txn_paise: "not-a-number" },
    };
    const result = verifyMandate(sign(badDoc), publicKeyPem);
    expect(result).toEqual({ ok: false, reason: "MALFORMED_DOCUMENT" });
  });
});
