import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Eval runs must never touch the real database — they TRUNCATE between
// cases. Load .env, then force DATABASE_URL to TEST_DATABASE_URL *before*
// @praman/db is ever imported. Must be a dynamic import: static imports are
// hoisted above this file's own top-level code (same fix as
// scripts/verify-ledger.ts), so a static import of @praman/db here would
// already have thrown before this override ran.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const testUrl = process.env["TEST_DATABASE_URL"];
if (!testUrl) throw new Error("TEST_DATABASE_URL is not set — eval runs must never touch the real database");
process.env["DATABASE_URL"] = testUrl;

const { prisma } = await import("@praman/db");
export { prisma };
export type { PrismaTx } from "@praman/db";
