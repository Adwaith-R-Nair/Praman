import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Same reason as approve.ts and verify-ledger.ts — dotenv must load before
// any dynamic import reaches @praman/db.
config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const { prisma } = await import("@praman/db");
const { formatINR, paiseFromDb } = await import("@praman/shared");

const pending = await prisma.approval.findMany({
  where: { status: "pending" },
  orderBy: { createdAt: "asc" },
});

if (pending.length === 0) {
  console.log("no pending approvals");
} else {
  const now = Date.now();
  for (const apr of pending) {
    const ageMin = Math.floor((now - apr.createdAt.getTime()) / 60_000);
    console.log(
      `${apr.approvalId}  ${formatINR(paiseFromDb(apr.amountPaise)).padEnd(12)}  ${ageMin.toString().padStart(3)}m old  mandate=${apr.mandateId}`,
    );
  }
}

await prisma.$disconnect();
