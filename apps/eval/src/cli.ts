import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { GeminiProvider } from "@praman/agent-core";
import { computeMetrics } from "./metrics.js";
import { generateBadge, generateReportMarkdown } from "./report.js";
import { runLayer1Corpus, runLayer2Corpus } from "./runner.js";
import type { CaseResult, Layer1Case, Layer2Case } from "./types.js";

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

if (wantLayer1) {
  const path = fileURLToPath(new URL("../corpus/layer1.json", import.meta.url));
  const cases = JSON.parse(readFileSync(path, "utf8")) as Layer1Case[];
  console.log(`Layer 1${dev ? " (dev)" : ""}: running ${cases.length.toString()} cases, no live model...`);
  results.push(...(await runLayer1Corpus(cases)));
}

if (wantLayer2) {
  const geminiKey = env["GEMINI_API_KEY"];
  if (!geminiKey) throw new Error("GEMINI_API_KEY is not set — required for --layer2");
  const path = fileURLToPath(new URL("../corpus/layer2.json", import.meta.url));
  const cases = JSON.parse(readFileSync(path, "utf8")) as Layer2Case[];
  const provider = new GeminiProvider(geminiKey, "gemini-3.1-flash-lite");
  console.log(`Layer 2: running ${cases.length.toString()} cases live against ${provider.id}, ~5s apart...`);
  results.push(...(await runLayer2Corpus(cases, provider)));
}

const metrics = computeMetrics(results);
const reportMd = generateReportMarkdown({ results, metrics, generated_at: new Date().toISOString() });
const badge = generateBadge(metrics);

const outDir = fileURLToPath(new URL("../../../eval/", import.meta.url));
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}report.md`, reportMd);
writeFileSync(
  `${outDir}report.json`,
  JSON.stringify({ results, metrics }, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2),
);
writeFileSync(`${outDir}badge.json`, JSON.stringify(badge, null, 2));

const failed = results.filter((r) => !r.passed).length;
console.log(`\n${(results.length - failed).toString()}/${results.length.toString()} passed`);
if (failed > 0) {
  console.log("Unresolved exceptions:");
  for (const e of metrics.unresolved_exceptions) console.log(`  ${e.case_id}: ${e.detail}`);
}
console.log(`\nWrote ${outDir}report.md, report.json, badge.json`);

const { prisma } = await import("./db.js");
await prisma.$disconnect();
process.exit(failed > 0 ? 1 : 0);
