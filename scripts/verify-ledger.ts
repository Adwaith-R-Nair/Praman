import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// @praman/db throws at import time if DATABASE_URL is unset, and static
// imports are hoisted above a module's own top-level code — so loading dotenv
// has to happen before a DYNAMIC import of @praman/db, not a static one, or
// this config() call would run too late regardless of source order. Resolved
// against this file's own location, not process.cwd(), same fix as
// prisma.config.ts and vitest.config.ts.
config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const { prisma } = await import("@praman/db");
const { verifyChain } = await import("@praman/ledger");

const result = await prisma.$transaction((tx) => verifyChain(tx));

if (result.ok) {
  console.log(`✓ ledger intact — ${result.checked} entries verified`);
  console.log(`  head: ${result.head}`);
  process.exit(0);
}

console.error(`✗ LEDGER BROKEN at seq ${result.brokenAt}`);
console.error(`  reason: ${result.reason}`);
console.error(`  ${result.detail}`);
process.exit(1);
