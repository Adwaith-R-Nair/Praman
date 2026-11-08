import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Invariant 1 in CLAUDE.md: no LLM call may ever reach the money-deciding
 * packages. This turns that from a convention into a build failure by
 * scanning their source for an import of anything model- or
 * observability-adjacent — including Langfuse, ahead of Phase 10, so it can
 * never be wired in here even by accident.
 */
const PROTECTED_DIRS = ["packages/policy/src", "packages/ledger/src", "packages/exec-core/src", "packages/razorpay-exec/src", "packages/paypal-exec/src"];
const FORBIDDEN = ["@praman/agent-core", "@google/genai", "@anthropic-ai/sdk", "@langfuse/", "@opentelemetry/", "@paypal/agent-toolkit"];

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IMPORT_RE = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const violations: string[] = [];

for (const dir of PROTECTED_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(IMPORT_RE)) {
      const specifier = match[1];
      if (specifier !== undefined && FORBIDDEN.some((f) => specifier.startsWith(f))) {
        violations.push(`${file.replace(ROOT, "")}: imports "${specifier}"`);
      }
    }
  }
}

/**
 * The other direction. Only a person starts a refund (D-66): an operator with
 * `pnpm refund`, or a demo visitor on their own trace page. So nothing a model drives,
 * the agent, its providers or the merchant tool server, may name the refund path.
 */
const AGENT_DIRS = ["apps/buyer-agent/src", "packages/agent-core/src", "apps/merchant-mcp/src"];
const REFUND_PATTERNS: readonly RegExp[] = [/\brefundOrder\b/, /\.refund\s*\??\.?\s*\(/, /\/refund\b/, /\breconcileRefund\b/];

for (const dir of AGENT_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const src = readFileSync(file, "utf8");
    for (const pattern of REFUND_PATTERNS) {
      if (pattern.test(src)) violations.push(`${file.replace(ROOT, "")}: names the refund path (${pattern.source})`);
    }
  }
}

if (violations.length > 0) {
  console.error("Import-boundary violation — a protected package imports a forbidden module, or agent code names the refund path:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(`Import boundary OK: ${PROTECTED_DIRS.join(", ")} import none of ${FORBIDDEN.join(", ")}.`);
console.log(`Refund boundary OK: ${AGENT_DIRS.join(", ")} never name the refund path.`);
