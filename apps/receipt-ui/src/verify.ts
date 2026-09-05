import { prisma } from "@praman/db";
import { read, verifyChain, type BreakReason, type VerifyResult } from "@praman/ledger";
import { BREAK_REASON_PLAIN } from "./reason-codes.js";

export interface TraceVerification {
  readonly chainOk: boolean;
  readonly checked: number;
  readonly head: string | null;
  readonly brokenAtSeq: number | null;
  readonly breakReason: string | null;
  readonly breakReasonPlain: string | null;
  readonly breakDetail: string | null;
  /** Whether every one of THIS trace's own entries is confirmed intact — not the same as chainOk. */
  readonly traceVerified: boolean;
}

/**
 * Pure classification, no I/O — separated so a caller checking many traces
 * (the index page) can run the expensive global verifyChain() walk ONCE and
 * classify every trace against that single result, rather than re-walking
 * the whole ledger once per trace listed.
 */
export function classifyTrace(chainResult: VerifyResult, ownSeqs: readonly number[]): TraceVerification {
  if (chainResult.ok) {
    return {
      chainOk: true,
      checked: chainResult.checked,
      head: chainResult.head,
      brokenAtSeq: null,
      breakReason: null,
      breakReasonPlain: null,
      breakDetail: null,
      traceVerified: true,
    };
  }

  const brokenAtSeq = Number(chainResult.brokenAt);
  const maxOwnSeq = Math.max(...ownSeqs);

  return {
    chainOk: false,
    checked: 0,
    head: null,
    brokenAtSeq,
    breakReason: chainResult.reason,
    breakReasonPlain: BREAK_REASON_PLAIN[chainResult.reason as BreakReason] ?? chainResult.reason,
    breakDetail: chainResult.detail,
    // Every one of this trace's own entries was confirmed intact before the
    // walk ever reached the break — a corruption elsewhere in the shared
    // chain, after this record, doesn't make this record untrustworthy.
    traceVerified: maxOwnSeq < brokenAtSeq,
  };
}

/**
 * The hash chain is one global sequence interleaving every trace's
 * entries — there is no way to verify "just this trace" in isolation, only
 * the whole chain up to wherever it's intact. This runs the full check
 * (same as `pnpm verify-ledger`) and then reports whether THIS trace's own
 * entries fall entirely within the verified range, which is the honest
 * answer to "can I trust this record" even though the check itself is global.
 */
export async function verifyTrace(traceId: string): Promise<TraceVerification | null> {
  const [chainResult, entries] = await prisma.$transaction(async (tx) => [await verifyChain(tx), await read(tx, traceId)] as const);
  if (entries.length === 0) return null;
  return classifyTrace(chainResult, entries.map((e) => Number(e.seq)));
}
