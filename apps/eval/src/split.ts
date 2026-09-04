import { createHash } from "node:crypto";

const HELDOUT_FRACTION = 0.3;

/**
 * Deterministic from case_id alone — no array order, corpus size, or stored
 * seed involved, so a case's bucket can never be quietly reshuffled by
 * adding cases later or by re-running this. Must be committed before any
 * tuning happens: the split cannot be allowed to respond to results.
 *
 * Verified unbiased at scale (~30.0% over 100k synthetic ids). On this
 * repo's actual 32-case corpus it happens to land at 16/32 (50%) — sampling
 * variance at small N, not a defect. Not re-salted to chase 30% here: doing
 * that after seeing the outcome would defeat the entire point of committing
 * the split before any tuning.
 */
export function splitAssignment(caseId: string): "dev" | "heldout" {
  const digest = createHash("sha256").update(caseId).digest();
  const bucket = digest.readUInt32BE(0) / 0xffffffff;
  return bucket < HELDOUT_FRACTION ? "heldout" : "dev";
}

export function splitCases<T extends { readonly case_id: string }>(
  cases: readonly T[],
): { readonly dev: readonly T[]; readonly heldout: readonly T[] } {
  const dev: T[] = [];
  const heldout: T[] = [];
  for (const c of cases) {
    (splitAssignment(c.case_id) === "heldout" ? heldout : dev).push(c);
  }
  return { dev, heldout };
}
