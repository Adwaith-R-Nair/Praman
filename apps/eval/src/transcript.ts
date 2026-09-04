import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ConversationItem } from "@praman/agent-core";

// Repo-root eval/transcripts/, not apps/eval/ — parallel to eval/report.md,
// kept out of the source package since these are per-run artefacts, not code.
const TRANSCRIPTS_DIR = fileURLToPath(new URL("../../../eval/transcripts/", import.meta.url));

/**
 * A reviewer seeing the actual model output is worth more than a summary of
 * it. Written for every Layer 2 case, resisted or not, and committed.
 *
 * `subdir` lets a caller (the ablation runner) keep multiple runs of the
 * same case_id from overwriting each other — e.g. "ablation/defended-run1".
 */
export function writeTranscript(caseId: string, transcript: readonly ConversationItem[], subdir?: string): void {
  const dir = subdir ? `${TRANSCRIPTS_DIR}${subdir}/` : TRANSCRIPTS_DIR;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}${caseId}.json`;
  try {
    writeFileSync(path, JSON.stringify(transcript, null, 2));
  } catch {
    // A provider's raw turn data can carry non-serialisable SDK internals.
    // Drop it rather than lose the human-readable parts of the transcript.
    const safe = transcript.map((item) =>
      item.role === "assistant" ? { ...item, raw: "[omitted: not serialisable]" } : item,
    );
    writeFileSync(path, JSON.stringify(safe, null, 2));
  }
}
