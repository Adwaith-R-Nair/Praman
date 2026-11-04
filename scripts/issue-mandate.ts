import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { signMandate, type MandateDocument } from "@praman/mandate";
import { isCurrency, type Currency } from "@praman/shared";

// Same reason as approve.ts/verify-ledger.ts — dotenv must load before
// requireEnv() reads MANDATE_PRIVATE_KEY from process.env.
config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const privateKeyPem = Buffer.from(requireEnv("MANDATE_PRIVATE_KEY"), "base64").toString("utf8");

const merchantId = process.argv[2] ?? "MERCH_001";
const outPath = process.argv[3] ?? "mandate.json";
const currency = process.argv[4] ?? "INR";
if (!isCurrency(currency)) throw new Error(`Unsupported currency: ${currency}`);

// Limits are amounts in the mandate's own currency, not converted figures: 80000
// is ₹800 and would be $800, so each currency states its own demo limits.
const LIMITS: Readonly<Record<Currency, { perTxn: string; total: string; threshold: string }>> = {
  INR: { perTxn: "80000", total: "500000", threshold: "50000" },
  USD: { perTxn: "5000", total: "30000", threshold: "2500" },
};
const limits = LIMITS[currency];

const now = new Date();
const notAfter = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h validity, demo default

const doc: MandateDocument = {
  mandate_id: `mnd_${randomBytes(6).toString("hex")}`,
  version: 2,
  issuer_id: "usr_adwaith",
  subject_id: "agt_lunchbuyer",
  scope: { merchant_ids: [merchantId], categories: ["food", "beverage"], currency },
  limits: { max_per_txn_minor: limits.perTxn, max_total_minor: limits.total, max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 5 },
  step_up: { threshold_minor: limits.threshold },
  validity: { not_before: now.toISOString(), not_after: notAfter.toISOString() },
  nonce: randomBytes(8).toString("hex"),
};

const signed = signMandate(doc, privateKeyPem, "usr_adwaith_k1");

writeFileSync(outPath, JSON.stringify(signed, null, 2));
console.log(`Mandate written to ${outPath}`);
console.log(`mandate_id: ${doc.mandate_id}`);
console.log(`merchant_ids: ${doc.scope.merchant_ids.join(", ")}`);
console.log(`currency: ${doc.scope.currency}`);
console.log(`valid: ${doc.validity.not_before} .. ${doc.validity.not_after}`);
