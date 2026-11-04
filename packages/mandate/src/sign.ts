import {
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { canonical, isCurrency, minorFromJSON, type Currency, type DenyCode } from "@praman/shared";
import type { VerifiedMandate } from "@praman/policy";

/** Everything that did not change between schema versions. */
interface MandateDocumentCommon {
  readonly mandate_id: string;
  readonly issuer_id: string;
  readonly subject_id: string;
  readonly validity: { readonly not_before: string; readonly not_after: string };
  readonly nonce: string;
}

interface MandateScope<C extends Currency> {
  readonly merchant_ids: string[];
  readonly categories: string[];
  readonly currency: C;
}

interface MandateRateLimits {
  readonly max_txns_per_window: number;
  readonly window_seconds: number;
  readonly max_denials_per_window: number;
}

/**
 * Mandates issued before the rename to minor units. These names are inside the
 * signed bytes, so they can never change: a v1 document verifies as written and
 * is hydrated to minor units afterwards. Not for new mandates.
 */
export interface MandateDocumentV1 extends MandateDocumentCommon {
  readonly version: 1;
  readonly scope: MandateScope<"INR">;
  readonly limits: MandateRateLimits & {
    readonly max_per_txn_paise: string;
    readonly max_total_paise: string;
  };
  readonly step_up: { readonly threshold_paise: string };
}

export interface MandateDocumentV2 extends MandateDocumentCommon {
  readonly version: 2;
  readonly scope: MandateScope<Currency>;
  readonly limits: MandateRateLimits & {
    readonly max_per_txn_minor: string;
    readonly max_total_minor: string;
  };
  readonly step_up: { readonly threshold_minor: string };
}

/** Wire format: amounts as decimal strings, times as ISO 8601. */
export type MandateDocument = MandateDocumentV1 | MandateDocumentV2;

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

/**
 * The one place a schema version turns into amounts. Anything other than a
 * version we know is refused rather than guessed at, including a correctly
 * signed one: minorFromJSON throws on a missing field, so a document whose
 * names don't match its version is malformed too.
 */
function readAmountLimits(d: MandateDocument): { maxPerTxn: string; maxTotal: string; threshold: string } {
  switch (d.version) {
    case 1:
      return {
        maxPerTxn: d.limits.max_per_txn_paise,
        maxTotal: d.limits.max_total_paise,
        threshold: d.step_up.threshold_paise,
      };
    case 2:
      return {
        maxPerTxn: d.limits.max_per_txn_minor,
        maxTotal: d.limits.max_total_minor,
        threshold: d.step_up.threshold_minor,
      };
    default:
      throw new TypeError("unknown mandate schema version");
  }
}

/**
 * The signed currency is the only source of currency, so a missing one is never
 * assumed. A v1 document counts in paise by name, so anything but INR there
 * can't mean what it says and is malformed. A v2 document in a currency we don't
 * support is well formed but unusable, which is why it gets its own failure.
 */
function readCurrency(d: MandateDocument): Currency | "UNSUPPORTED" {
  if (d.version === 1 && d.scope.currency !== "INR") throw new TypeError("a v1 mandate can only be in INR");
  return isCurrency(d.scope.currency) ? d.scope.currency : "UNSUPPORTED";
}

export type VerifyFailure = "SIGNATURE_INVALID" | "UNSUPPORTED_ALG" | "MALFORMED_DOCUMENT" | "UNSUPPORTED_CURRENCY";

/**
 * What a caller records when verification fails. An unsupported currency has a
 * good signature, so calling it MANDATE_SIGNATURE_INVALID would be false: it
 * gets the same AMOUNT_INVALID that evaluate() gives it.
 */
export function verifyFailureCode(reason: VerifyFailure): DenyCode {
  return reason === "UNSUPPORTED_CURRENCY" ? "AMOUNT_INVALID" : "MANDATE_SIGNATURE_INVALID";
}

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
    const amounts = readAmountLimits(d);
    const currency = readCurrency(d);
    if (currency === "UNSUPPORTED") return { ok: false, reason: "UNSUPPORTED_CURRENCY" };

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
        scope: { merchant_ids: d.scope.merchant_ids, categories: d.scope.categories, currency },
        limits: {
          max_per_txn_minor: minorFromJSON(amounts.maxPerTxn),
          max_total_minor: minorFromJSON(amounts.maxTotal),
          max_txns_per_window: d.limits.max_txns_per_window,
          window_seconds: d.limits.window_seconds,
          max_denials_per_window: d.limits.max_denials_per_window,
        },
        step_up: { threshold_minor: minorFromJSON(amounts.threshold) },
        validity: { not_before: notBefore, not_after: notAfter },
      },
    };
  } catch {
    return { ok: false, reason: "MALFORMED_DOCUMENT" };
  }
}
