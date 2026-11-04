import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  generateKeypair,
  signMandate,
  verifyMandate,
  type MandateDocument,
  type MandateDocumentV1,
  type MandateDocumentV2,
  type SignedMandate,
} from "../src/sign.js";

const { privateKeyPem, publicKeyPem } = generateKeypair();

const BASE_DOC: MandateDocumentV2 = {
  mandate_id: "mnd_test",
  version: 2,
  issuer_id: "usr_adwaith",
  subject_id: "agt_lunchbuyer",
  scope: { merchant_ids: ["MERCH_001"], categories: ["food"], currency: "INR" },
  limits: {
    max_per_txn_minor: "80000",
    max_total_minor: "500000",
    max_txns_per_window: 5,
    window_seconds: 3600,
    max_denials_per_window: 5,
  },
  step_up: { threshold_minor: "50000" },
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
    expect(result.mandate.limits.max_per_txn_minor).toBe(80000n);
    expect(result.mandate.step_up.threshold_minor).toBe(50000n);
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
      document: { ...BASE_DOC, limits: { ...BASE_DOC.limits, max_per_txn_minor: "999999999" } },
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
      limits: { ...BASE_DOC.limits, max_per_txn_minor: "not-a-number" },
    };
    const result = verifyMandate(sign(badDoc), publicKeyPem);
    expect(result).toEqual({ ok: false, reason: "MALFORMED_DOCUMENT" });
  });
});

const V1_DOC: MandateDocumentV1 = {
  mandate_id: "mnd_frozen_v1",
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

// Produced by the code as it stood at 04e9ed1, before the rename, from a
// throwaway key whose private half was discarded. A signature created now
// could not catch a change to what gets signed. This one can.
const FROZEN_V1_PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAOkyilBNH2vKgkMPLzvdDXxsXBUuk32bhcqvl82tbo8w=\n-----END PUBLIC KEY-----\n";
const FROZEN_V1_SIGNED: SignedMandate = {
  document: V1_DOC,
  signature: {
    alg: "Ed25519",
    key_id: "usr_adwaith_k1",
    value: "B8Z3LaO_cBHPJukI-kOxwKiYAnA4q_ksAkvP8B63s7_rQZAj906ApO635DN4pt5O4gX49G0xqZJwCd7o422RAQ",
  },
};

describe("mandate schema versions", () => {
  it("verifies a v1 mandate signed before the rename, hydrated to minor units", () => {
    const result = verifyMandate(FROZEN_V1_SIGNED, FROZEN_V1_PUBLIC_KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.mandate.limits.max_total_minor).toBe(500000n);
    expect(result.mandate.limits.max_per_txn_minor).toBe(80000n);
    expect(result.mandate.step_up.threshold_minor).toBe(50000n);
    expect(result.mandate.scope.currency).toBe("INR");
  });

  it("v1 and v2 documents with the same limits hydrate to the same mandate", () => {
    const v1 = verifyMandate(signMandate({ ...V1_DOC }, privateKeyPem, "k1"), publicKeyPem);
    const v2 = verifyMandate(
      signMandate({ ...BASE_DOC, mandate_id: V1_DOC.mandate_id, scope: V1_DOC.scope, validity: V1_DOC.validity,
        limits: { ...BASE_DOC.limits, max_per_txn_minor: "80000", max_total_minor: "500000" },
        step_up: { threshold_minor: "50000" } }, privateKeyPem, "k1"),
      publicKeyPem,
    );
    expect(v1).toEqual(v2);
  });

  it("a signed v1 mandate cannot be relabelled as v2", () => {
    const relabelled = { ...FROZEN_V1_SIGNED, document: { ...V1_DOC, version: 2 } } as unknown as SignedMandate;
    expect(verifyMandate(relabelled, FROZEN_V1_PUBLIC_KEY)).toEqual({ ok: false, reason: "SIGNATURE_INVALID" });
  });

  it.each([
    ["a v2 document carrying v1 field names", { ...V1_DOC, version: 2 }],
    ["a v1 document carrying v2 field names", { ...BASE_DOC, version: 1 }],
    ["an unknown schema version", { ...BASE_DOC, version: 3 }],
  ])("refuses %s, even when correctly signed", (_name, doc) => {
    const signed = signMandate(doc as unknown as MandateDocument, privateKeyPem, "k1");
    expect(verifyMandate(signed, publicKeyPem)).toEqual({ ok: false, reason: "MALFORMED_DOCUMENT" });
  });

  it("the eval corpus keeps one v1 fixture, and it verifies", () => {
    const path = fileURLToPath(new URL("../../../apps/eval/fixtures/mandates/lunch_5000_high_stepup.json", import.meta.url));
    const doc = JSON.parse(readFileSync(path, "utf8")) as MandateDocument;
    expect(doc.version).toBe(1);
    expect(verifyMandate(signMandate(doc, privateKeyPem, "k1"), publicKeyPem).ok).toBe(true);
  });
});
