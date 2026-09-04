import {
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { canonical, paiseFromJSON } from "@praman/shared";
import type { VerifiedMandate } from "@praman/policy";

/** Wire format: amounts as decimal strings, times as ISO 8601. */
export interface MandateDocument {
  readonly mandate_id: string;
  readonly version: 1;
  readonly issuer_id: string;
  readonly subject_id: string;
  readonly scope: { readonly merchant_ids: string[]; readonly categories: string[]; readonly currency: "INR" };
  readonly limits: {
    readonly max_per_txn_paise: string;
    readonly max_total_paise: string;
    readonly max_txns_per_window: number;
    readonly window_seconds: number;
  };
  readonly step_up: { readonly threshold_paise: string };
  readonly validity: { readonly not_before: string; readonly not_after: string };
  readonly nonce: string;
}

export interface SignedMandate {
  readonly document: MandateDocument;
  readonly signature: { readonly alg: "Ed25519"; readonly key_id: string; readonly value: string };
}

export function generateKeypair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function signMandate(doc: MandateDocument, privateKeyPem: string, keyId: string): SignedMandate {
  const preimage = Buffer.from(canonical(doc), "utf8");
  const signature = cryptoSign(null, preimage, createPrivateKey(privateKeyPem));
  return { document: doc, signature: { alg: "Ed25519", key_id: keyId, value: signature.toString("base64url") } };
}

export type VerifyFailure = "SIGNATURE_INVALID" | "UNSUPPORTED_ALG" | "MALFORMED_DOCUMENT";

/**
 * Verifies, then hydrates into the policy's VerifiedMandate. The type name is a
 * precondition: nothing can construct one without passing through here.
 */
export function verifyMandate(
  signed: SignedMandate,
  publicKeyPem: string,
): { ok: true; mandate: VerifiedMandate } | { ok: false; reason: VerifyFailure } {
  if (signed.signature.alg !== "Ed25519") return { ok: false, reason: "UNSUPPORTED_ALG" };

  const preimage = Buffer.from(canonical(signed.document), "utf8");
  const valid = cryptoVerify(
    null,
    preimage,
    createPublicKey(publicKeyPem),
    Buffer.from(signed.signature.value, "base64url"),
  );
  if (!valid) return { ok: false, reason: "SIGNATURE_INVALID" };

  try {
    const d = signed.document;

    const notBefore = new Date(d.validity.not_before);
    const notAfter = new Date(d.validity.not_after);
    // new Date() does not throw on a malformed string — it returns an Invalid
    // Date, whose getTime() is NaN. evaluate()'s validity checks are
    // `ts < not_before.getTime()` / `ts > not_after.getTime()`; any comparison
    // against NaN is always false, so an unchecked Invalid Date here would
    // make BOTH the "too early" and "too late" checks silently never fire —
    // a mandate with a garbage validity window would pass as always-valid.
    if (Number.isNaN(notBefore.getTime())) throw new TypeError("validity.not_before is not a valid date");
    if (Number.isNaN(notAfter.getTime())) throw new TypeError("validity.not_after is not a valid date");

    return {
      ok: true,
      mandate: {
        mandate_id: d.mandate_id,
        scope: { merchant_ids: d.scope.merchant_ids, categories: d.scope.categories, currency: "INR" },
        limits: {
          max_per_txn_paise: paiseFromJSON(d.limits.max_per_txn_paise),
          max_total_paise: paiseFromJSON(d.limits.max_total_paise),
          max_txns_per_window: d.limits.max_txns_per_window,
          window_seconds: d.limits.window_seconds,
        },
        step_up: { threshold_paise: paiseFromJSON(d.step_up.threshold_paise) },
        validity: { not_before: notBefore, not_after: notAfter },
      },
    };
  } catch {
    return { ok: false, reason: "MALFORMED_DOCUMENT" };
  }
}
