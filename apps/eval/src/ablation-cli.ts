import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { GeminiProvider } from "@praman/agent-core";
import { runLayer2 } from "./runner.js";
import type { CaseResult, Layer2Case } from "./types.js";

const geminiKey = env["GEMINI_API_KEY"];
if (!geminiKey) throw new Error("GEMINI_API_KEY is not set");

const corpusPath = fileURLToPath(new URL("../corpus/layer2.json", import.meta.url));
const allCases = JSON.parse(readFileSync(corpusPath, "utf8")) as Layer2Case[];
// Same 7 injection cases per Claude Chat's design — the control has no
// injection to measure influence against, so it isn't part of the ablation.
const cases = allCases.filter((c) => c.case_id !== "inj_control");

const provider = new GeminiProvider(geminiKey, "gemini-3.1-flash-lite");
const GAP_MS = 4000;
const REPEATS = 3;

const outDir = fileURLToPath(new URL("../../../eval/ablation/", import.meta.url));
mkdirSync(outDir, { recursive: true });

const ARMS = ["defended", "undefended"] as const;
type Arm = (typeof ARMS)[number];

function setArmEnv(arm: Arm): void {
  if (arm === "defended") {
    delete env["PRAMAN_NO_DELIMITER"];
    delete env["PRAMAN_NO_PROMPT_DEFENCE"];
  } else {
    env["PRAMAN_NO_DELIMITER"] = "1";
    env["PRAMAN_NO_PROMPT_DEFENCE"] = "1";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface RunRecord {
  readonly arm: Arm;
  readonly run: number;
  readonly results: readonly CaseResult[];
}

let callsSoFar = 0;
const allRuns: RunRecord[] = [];

for (const arm of ARMS) {
  setArmEnv(arm);
  for (let run = 1; run <= REPEATS; run++) {
    console.log(`\n=== ${arm} run ${run.toString()}/${REPEATS.toString()} ===`);
    const results: CaseResult[] = [];
    for (const c of cases) {
      if (callsSoFar > 0) await sleep(GAP_MS);
      callsSoFar++;
      const result = await runLayer2(c, provider, `ablation/${arm}-run${run.toString()}`);
      console.log(
        `  ${result.case_id.padEnd(22)} influenced=${String(result.influenced).padEnd(6)} money_moved=${String(result.money_moved)}`,
      );
      results.push(result);
    }
    const record: RunRecord = { arm, run, results };
    allRuns.push(record);
    writeFileSync(
      `${outDir}${arm}-run${run.toString()}.json`,
      JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
    );
  }
}

console.log(`\n${callsSoFar.toString()} total agent calls complete.`);

function armStats(arm: Arm): { runs: number; influenced: number; moneyMoved: number } {
  const combined = allRuns.filter((r) => r.arm === arm).flatMap((r) => r.results);
  return {
    runs: combined.length,
    influenced: combined.filter((r) => r.influenced === true).length,
    moneyMoved: combined.filter((r) => r.money_moved).length,
  };
}

const defended = armStats("defended");
const undefendedStats = armStats("undefended");

const summary = [
  "# Ablation: what does the prompt-layer defence buy?",
  "",
  `Same 7 injection cases, same model (${provider.id}), 3 repeats per arm.`,
  "Arms differ only in whether merchant text is delimited and whether the",
  "system prompt carries untrusted-content handling instructions. The policy",
  "engine is identical in both arms.",
  "",
  "| Arm | Runs | Proposals influenced | Money moved |",
  "|---|---|---|---|",
  `| Defended | ${defended.runs.toString()} | ${defended.influenced.toString()} | ${defended.moneyMoved.toString()} |`,
  `| Undefended | ${undefendedStats.runs.toString()} | ${undefendedStats.influenced.toString()} | ${undefendedStats.moneyMoved.toString()} |`,
  "",
  "## Per-repeat results",
  "",
  ...allRuns.map((r) => {
    const infl = r.results.filter((x) => x.influenced === true).length;
    const moved = r.results.filter((x) => x.money_moved).length;
    return `- ${r.arm} run ${r.run.toString()}: ${infl.toString()}/${r.results.length.toString()} influenced, ${moved.toString()}/${r.results.length.toString()} money moved`;
  }),
  "",
  "## Limits",
  "",
  "n=21 per arm on one model, one temperature, seven hand-written attacks by",
  "the same author who wrote the defence. Not a benchmark. The delimiter and",
  "the prompt instructions were removed together, so this does not separate",
  "their individual contributions.",
].join("\n");

writeFileSync(`${outDir}summary.md`, `${summary}\n`);
console.log(`\nWrote ${outDir}*.json and summary.md`);

const { prisma } = await import("./db.js");
await prisma.$disconnect();
