import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REASON_CODES } from "@praman/shared";
import type { Layer1Case, Layer2Case } from "./types.js";

const CORPUS_DIR = fileURLToPath(new URL("../corpus", import.meta.url));

/**
 * Reason codes with no eval fixture yet, and why. Every entry here must
 * point at the phase that will close it — this list existing at all is a
 * gap, not a feature, and it must shrink to empty, never grow silently.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  // Needs an approval-cycle seeding path (step up, let the catalog price
  // move, then resolve) that the corpus schema doesn't support yet. Phase 11.
  AMOUNT_CHANGED_SINCE_APPROVAL: "no approval-cycle seeding path yet — Phase 11",
};

function loadCorpus<T>(name: string): readonly T[] {
  return JSON.parse(readFileSync(`${CORPUS_DIR}/${name}.json`, "utf8")) as readonly T[];
}

const layer1 = loadCorpus<Layer1Case>("layer1");
const layer2 = loadCorpus<Layer2Case>("layer2");

const covered = new Set<string>();
for (const c of layer1) {
  for (const rc of c.expected.acceptable_reason_codes) covered.add(rc);
}
// Layer 2 cases don't declare acceptable_reason_codes (the agent's proposal
// isn't fixed in advance), but OK is always a legitimate outcome there —
// an uninfluenced case is expected to execute normally.
covered.add("OK");

const missing = REASON_CODES.filter((rc) => !covered.has(rc) && !(rc in EXCEPTIONS));
const staleExceptions = Object.keys(EXCEPTIONS).filter((rc) => covered.has(rc));

let failed = false;

if (missing.length > 0) {
  failed = true;
  console.error("Reason codes with no eval fixture and no exception on file:");
  for (const rc of missing) console.error(`  - ${rc}`);
}

if (staleExceptions.length > 0) {
  failed = true;
  console.error("Reason codes listed as exceptions but now covered by a fixture — remove them from EXCEPTIONS:");
  for (const rc of staleExceptions) console.error(`  - ${rc}`);
}

if (failed) {
  process.exit(1);
}

console.log(`Reason-code coverage OK: ${REASON_CODES.length.toString()} codes, ${Object.keys(EXCEPTIONS).length.toString()} on the exception list.`);
