import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// @praman/db throws at import time if DATABASE_URL is unset. Resolve .env
// against this file's own location rather than process.cwd() — same fix as
// prisma.config.ts, needed now that packages/ledger's tests import @praman/db.
config({ path: fileURLToPath(new URL("./.env", import.meta.url)) });

export default defineConfig({
  test: { include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"] },
});