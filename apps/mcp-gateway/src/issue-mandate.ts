import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { signMandate } from "@praman/mandate";
import { DEFAULT_MANDATE_PATH } from "./env.js";
import { GATEWAY_TERMS, gatewayMandate } from "./terms.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const privateKeyB64 = process.env["MANDATE_PRIVATE_KEY"];
if (!privateKeyB64) {
  console.error("✗ MANDATE_PRIVATE_KEY is not set in .env");
  process.exit(1);
}
const hours = Number(process.argv[2] ?? "24");
if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
  console.error("usage: pnpm mcp:mandate [hours, 1 to 168, default 24]");
  process.exit(1);
}

const outPath = process.env["PRAMAN_MCP_MANDATE"] || DEFAULT_MANDATE_PATH;
const doc = gatewayMandate(new Date(), hours);
writeFileSync(outPath, JSON.stringify(signMandate(doc, Buffer.from(privateKeyB64, "base64").toString("utf8"), "usr_adwaith_k1"), null, 2));

console.log(`✓ mandate ${doc.mandate_id} written to ${outPath}`);
console.log(`  merchants ${doc.scope.merchant_ids.join(", ")}, categories ${doc.scope.categories.join(", ")}, ${doc.scope.currency}`);
console.log(`  per purchase up to ${GATEWAY_TERMS.max_per_txn_minor} cents, total ${GATEWAY_TERMS.max_total_minor}, a person approves from ${GATEWAY_TERMS.threshold_minor}`);
console.log(`  valid until ${doc.validity.not_after}. Restart the MCP server to pick it up.`);
