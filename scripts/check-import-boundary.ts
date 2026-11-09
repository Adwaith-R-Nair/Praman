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
const PROTECTED_DIRS = ["packages/policy/src", "packages/ledger/src", "packages/exec-core/src", "packages/razorpay-exec/src", "packages/paypal-exec/src", "packages/channel3/src"];
const FORBIDDEN = ["@praman/agent-core", "@google/genai", "@anthropic-ai/sdk", "@langfuse/", "@opentelemetry/", "@paypal/agent-toolkit"];

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IMPORT_RE = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...walk(full));
    } else if (entry.name.endsWith(".ts")) out.push(full);
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
 * the agent, its providers, the merchant tool server or the MCP gateway any agent can
 * call, may name the refund path. The PayPal auditor is held to the same rule: it reads
 * a refund and can never start one.
 */
const AGENT_DIRS = ["apps/buyer-agent/src", "packages/agent-core/src", "apps/merchant-mcp/src", "apps/mcp-gateway/src", "apps/paypal-auditor/src"];
const REFUND_PATTERNS: readonly RegExp[] = [/\brefundOrder\b/, /\.refund\s*\??\.?\s*\(/, /\/refund\b/, /\breconcileRefund\b/];

for (const dir of AGENT_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const src = readFileSync(file, "utf8");
    for (const pattern of REFUND_PATTERNS) {
      if (pattern.test(src)) violations.push(`${file.replace(ROOT, "")}: names the refund path (${pattern.source})`);
    }
  }
}

/**
 * PayPal's Agent Toolkit is used in one place: the read-only auditor in
 * apps/paypal-auditor (D-92). The toolkit can create, capture and refund, and the
 * auditor switches on four read tools only. So no other workspace package, and no
 * script, may import the toolkit or the auditor or list either as a dependency, and
 * the hosted server and the MCP gateway may not name the auditor at all, which would
 * be how they started it. render.yaml is checked for the same reason.
 */
const AUDITOR_DIR = "apps/paypal-auditor";
const AUDITOR_ONLY = ["@paypal/agent-toolkit", "@praman/paypal-auditor"];
const MAY_NOT_NAME_AUDITOR = ["apps/receipt-ui", "apps/mcp-gateway"];

const workspaceDirs = ["packages", "apps"].flatMap((parent) =>
  readdirSync(join(ROOT, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`),
);
const outsideAuditor = workspaceDirs.filter((dir) => dir !== AUDITOR_DIR);

for (const dir of [...outsideAuditor, "scripts"]) {
  for (const file of walk(join(ROOT, dir))) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(IMPORT_RE)) {
      const specifier = match[1];
      if (specifier !== undefined && AUDITOR_ONLY.some((name) => specifier.startsWith(name))) {
        violations.push(`${file.replace(ROOT, "")}: imports "${specifier}", which only ${AUDITOR_DIR} may`);
      }
    }
    if (MAY_NOT_NAME_AUDITOR.includes(dir) && src.includes("paypal-auditor")) {
      violations.push(`${file.replace(ROOT, "")}: names the PayPal auditor, which this app must never start`);
    }
  }
}

for (const dir of [...outsideAuditor, "."]) {
  const manifest: unknown = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
  if (manifest === null || typeof manifest !== "object") continue;
  for (const [section, deps] of Object.entries(manifest)) {
    if (!section.toLowerCase().endsWith("dependencies") || deps === null || typeof deps !== "object") continue;
    for (const name of Object.keys(deps)) {
      if (AUDITOR_ONLY.includes(name)) violations.push(`${dir}/package.json: lists "${name}" in ${section}, which only ${AUDITOR_DIR} may`);
    }
  }
}

if (readFileSync(join(ROOT, "render.yaml"), "utf8").includes("paypal-auditor")) {
  violations.push("render.yaml: names the PayPal auditor, which the hosted server must never start");
}

if (violations.length > 0) {
  console.error("Import-boundary violation — a protected package imports a forbidden module, agent code names the refund path, or something outside the auditor reaches PayPal's Agent Toolkit:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(`Import boundary OK: ${PROTECTED_DIRS.join(", ")} import none of ${FORBIDDEN.join(", ")}.`);
console.log(`Refund boundary OK: ${AGENT_DIRS.join(", ")} never name the refund path.`);
console.log(`Toolkit boundary OK: only ${AUDITOR_DIR} imports or depends on ${AUDITOR_ONLY.join(" or ")}, and ${MAY_NOT_NAME_AUDITOR.join(", ")} and render.yaml never name it.`);
