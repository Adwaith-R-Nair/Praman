import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Same reason as approve.ts/verify-ledger.ts — dotenv must load before any
// dynamic import reaches @praman/db.
config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const traceId = process.argv[2];
if (!traceId) {
  console.error("usage: pnpm dispute <trace_id>");
  process.exit(1);
}

const { prisma } = await import("@praman/db");
const { buildBundle } = await import("@praman/dispute");

const bundle = await prisma.$transaction((tx) => buildBundle(tx, traceId));

if (!bundle) {
  console.error(`✗ no such trace: ${traceId}`);
  await prisma.$disconnect();
  process.exit(1);
}

const outDir = fileURLToPath(new URL("../disputes", import.meta.url));
mkdirSync(outDir, { recursive: true });
const outPath = fileURLToPath(new URL(`../disputes/${traceId}.json`, import.meta.url));
writeFileSync(outPath, JSON.stringify(bundle, null, 2));

console.log(`✓ dispute bundle written: disputes/${traceId}.json`);
console.log(`  decision: ${bundle.authorisation.decision ?? "unknown"} (${bundle.authorisation.reason_code ?? "n/a"})`);
console.log(`  chain: ${bundle.chain.global_chain_ok ? "intact" : "BROKEN"}, trace fully verified: ${bundle.chain.trace_fully_verified.toString()}`);

await prisma.$disconnect();
