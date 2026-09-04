import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// @praman/db throws at import time if DATABASE_URL is unset. Resolve .env
// against this file's own location rather than process.cwd() — same fix as
// prisma.config.ts, needed now that packages/ledger's tests import @praman/db.
config({ path: fileURLToPath(new URL("./.env", import.meta.url)) });

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // The ledger's integration tests share one physical hash chain in one
    // Postgres database and TRUNCATE it between tests. Running test files in
    // parallel (Vitest's default) lets one file's TRUNCATE interleave with
    // another's inserts — not flakiness, the real single-chain constraint
    // showing up in the test harness.
    fileParallelism: false,
  },
});