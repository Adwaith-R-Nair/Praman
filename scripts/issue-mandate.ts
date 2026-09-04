import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { signMandate, type MandateDocument } from "@praman/mandate";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const privateKeyPem = Buffer.from(requireEnv("MANDATE_PRIVATE_KEY"), "base64").toString("utf8");

const merchantId = process.argv[2] ?? "MERCH_001";
const outPath = process.argv[3] ?? "mandate.json";

const now = new Date();
const notAfter = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h validity, demo default

const doc: MandateDocument = {
  mandate_id: `mnd_${randomBytes(6).toString("hex")}`,
  version: 1,
  issuer_id: "usr_adwaith",
  subject_id: "agt_lunchbuyer",
  scope: { merchant_ids: [merchantId], categories: ["food", "beverage"], currency: "INR" },
  limits: { max_per_txn_paise: "80000", max_total_paise: "500000", max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 5 },
  step_up: { threshold_paise: "50000" },
  validity: { not_before: now.toISOString(), not_after: notAfter.toISOString() },
  nonce: randomBytes(8).toString("hex"),
};

const signed = signMandate(doc, privateKeyPem, "usr_adwaith_k1");

writeFileSync(outPath, JSON.stringify(signed, null, 2));
console.log(`Mandate written to ${outPath}`);
console.log(`mandate_id: ${doc.mandate_id}`);
console.log(`merchant_ids: ${doc.scope.merchant_ids.join(", ")}`);
console.log(`valid: ${doc.validity.not_before} .. ${doc.validity.not_after}`);
