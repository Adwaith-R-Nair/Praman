import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";

// dotenv/config's bare import resolves .env against process.cwd(), which
// is packages/db when the CLI is invoked from here — not the repo root
// where the real .env lives. Resolve against this file's own location
// instead, so `prisma migrate` works the same regardless of invocation dir.
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

// The CLI (migrate, generate) connects with DIRECT_DATABASE_URL when it is set. On the
// hosted demo, DATABASE_URL is Neon's pooled address, which the running server uses;
// migrations take an advisory lock and need a direct connection, not a pooler. Unset,
// as in local dev, the CLI uses DATABASE_URL as before. The server never reads this file.
const direct = process.env["DIRECT_DATABASE_URL"];

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: direct !== undefined && direct !== "" ? direct : env("DATABASE_URL"),
  },
});
