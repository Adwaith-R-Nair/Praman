import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";

// dotenv/config's bare import resolves .env against process.cwd(), which
// is packages/db when the CLI is invoked from here — not the repo root
// where the real .env lives. Resolve against this file's own location
// instead, so `prisma migrate` works the same regardless of invocation dir.
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
