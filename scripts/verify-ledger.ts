import { prisma } from "@praman/db";
import { verifyChain } from "@praman/ledger";

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
