import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { GeminiProvider } from "@praman/agent-core";
import { computeMetrics } from "./metrics.js";
import { generateBadge, generateReportMarkdown, reportFileStem, type AblationArmStats, type AblationSummary } from "./report.js";
import { runLayer1Corpus, runLayer2Corpus } from "./runner.js";
import type { CaseResult, Layer1Case, Layer2Case } from "./types.js";

// Dev observability only (D-47). "./runner.js" has already imported
// "./db.js", which loads .env and points DATABASE_URL at the test database,
// so this dynamic import can't reach the real one. With no Langfuse keys
// nothing starts; CI has none.
const { startTracing } = await import("@praman/buyer-agent");
const tracing = await startTracing(env);
const { startScoreSink } = await import("./scores.js");
const scores = await startScoreSink(env);

/**
 * The day the ablation results were committed, from git, so the report's date
 * is never typed by hand. Null with no git or no history (a bare tarball).
 */
function ablationCommitDate(outDir: string): string | null {
  try {
    const day = execFileSync("git", ["log", "-1", "--format=%cs", "--", `${outDir}ablation`], { encoding: "utf8" }).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  } catch {
    return null;
  }
}

/**
 * Reads whatever ablation-cli.ts already wrote to eval/ablation/, if it's
 * there, and folds it into the main report — so the report never goes
 * stale relative to the ablation just because someone hand-edited it once.
 * Returns undefined (no section) if the ablation hasn't been run yet.
 */
function readAblationSummary(outDir: string): AblationSummary | undefined {
  const armStats = (arm: "defended" | "undefended"): AblationArmStats | null => {
    const runs: CaseResult[][] = [];
    for (let run = 1; run <= 3; run++) {
      const path = `${outDir}ablation/${arm}-run${run.toString()}.json`;
      if (!existsSync(path)) return null;
      runs.push(JSON.parse(readFileSync(path, "utf8")) as CaseResult[]);
    }
    const combined = runs.flat();
    return {
      runs: combined.length,
      influenced: combined.filter((r) => r.influenced === true).length,
      moneyMoved: combined.filter((r) => r.money_moved).length,
      influencedAndMoneyMoved: combined.filter((r) => r.influenced === true && r.money_moved).length,
    };
  };

  const defended = armStats("defended");
  const undefended = armStats("undefended");
  if (!defended || !undefended) return undefined;

  // CaseResult doesn't carry a model id, and this function may run in a
  // --layer1-only pass where PRAMAN_MODEL was never set this session — fall
  // back to the model ablation-cli.ts actually used, since that's the one
  // fact this function can't otherwise recover from the JSON on disk.
  return {
    model_id: env["PRAMAN_MODEL"] ?? "google/gemini-3.1-flash-lite",
    measured_on: ablationCommitDate(outDir),
    defended,
    undefended,
  };
}

// --dev: labels the run as CI-safe (no live model calls expected) in the
// console output. It doesn't gate anything extra — a failed case already
// exits non-zero regardless of this flag; see docs/BUILD_LOG.md.
const args = new Set(process.argv.slice(2));
const wantLayer1 = args.has("--layer1");
const wantLayer2 = args.has("--layer2");
const dev = args.has("--dev");

if (!wantLayer1 && !wantLayer2) {
  console.error("usage: pnpm eval [--layer1] [--layer2] [--dev]");
  process.exit(1);
}

const results: CaseResult[] = [];
const notMirrored: { case_id: string; why: string }[] = [];

if (wantLayer1) {
  const path = fileURLToPath(new URL("../corpus/layer1.json", import.meta.url));
  const cases = JSON.parse(readFileSync(path, "utf8")) as Layer1Case[];
  console.log(`Layer 1${dev ? " (dev)" : ""}: running ${cases.length.toString()} cases, no live model...`);
  const run = await runLayer1Corpus(cases);
  results.push(...run.results);
  notMirrored.push(...run.not_mirrored);
}

if (wantLayer2) {
  const geminiKey = env["GEMINI_API_KEY"];
  if (!geminiKey) throw new Error("GEMINI_API_KEY is not set — required for --layer2");
  const path = fileURLToPath(new URL("../corpus/layer2.json", import.meta.url));
  const cases = JSON.parse(readFileSync(path, "utf8")) as Layer2Case[];
  const provider = new GeminiProvider(geminiKey, "gemini-3.1-flash-lite");
  // computeMetrics() reads this from the environment rather than taking it
  // as a parameter — set it here so the report says which model was
  // actually tested instead of falling back to "n/a".
  env["PRAMAN_MODEL"] = provider.id;
  console.log(`Layer 2: running ${cases.length.toString()} cases live against ${provider.id}, ~5s apart...`);
  results.push(...(await runLayer2Corpus(cases, provider, 5000, scores.sink)));
}

const metrics = computeMetrics(results);
const outDir = fileURLToPath(new URL("../../../eval/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const ablation = readAblationSummary(outDir);
const reportMd = generateReportMarkdown({
  results,
  metrics,
  generated_at: new Date().toISOString(),
  ...(ablation ? { ablation } : {}),
  ...(notMirrored.length > 0 ? { not_mirrored: notMirrored } : {}),
});
const badge = generateBadge(metrics);

const stem = reportFileStem(wantLayer1, wantLayer2);
writeFileSync(`${outDir}${stem}.md`, reportMd);
writeFileSync(
  `${outDir}${stem}.json`,
  JSON.stringify({ results, metrics }, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2),
);
if (stem === "report") writeFileSync(`${outDir}badge.json`, JSON.stringify(badge, null, 2));

const failed = results.filter((r) => !r.passed).length;
console.log(`\n${(results.length - failed).toString()}/${results.length.toString()} passed`);
if (failed > 0) {
  console.log("Unresolved exceptions:");
  for (const e of metrics.unresolved_exceptions) console.log(`  ${e.case_id}: ${e.detail}`);
}
console.log(`\nWrote ${outDir}${stem}.md, ${stem}.json${stem === "report" ? ", badge.json" : ". Only a run of both layers replaces the committed report."}`);

const { prisma } = await import("./db.js");
await prisma.$disconnect();
await scores.stop();
await tracing.stop();
process.exit(failed > 0 ? 1 : 0);
