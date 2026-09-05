import { prisma } from "@praman/db";
import { append } from "@praman/ledger";
import type { ConversationItem } from "@praman/agent-core";

/**
 * Records the agent's full tool-use transcript against a trace, so the
 * receipt viewer can show what the agent actually read and proposed — not
 * just the final decided intent. Written in its own transaction, separate
 * from runIntent()'s own (control-plane deliberately knows nothing about
 * agent conversation shapes — D-02's boundary: no LLM in the authorisation
 * path, and that includes not coupling the policy engine to agent-core).
 *
 * The transcript contains merchant-authored text an attacker may have
 * tried to inject through. It is EVIDENCE for a human reviewer, never
 * CONTEXT for a model: nothing may ever read this event back into a
 * prompt. If a future replay/debug tool wants to reconstruct a past
 * conversation, it must re-fetch fresh catalog text, not reuse what's
 * stored here.
 */
export async function recordAgentTranscript(traceId: string, transcript: readonly ConversationItem[]): Promise<void> {
  // Ledger payloads must canonicalise cleanly (assertLedgerPayload/canonical()
  // reject anything not plain JSON). A provider's raw turn-replay data is an
  // opaque SDK object with no such guarantee, and isn't needed for human
  // review anyway — strip it rather than risk a throw mid-transaction.
  const forRecord = transcript.map((item) =>
    item.role === "assistant" ? { role: item.role, calls: item.calls, text: item.text } : item,
  );
  await prisma.$transaction((tx) =>
    append(tx, {
      traceId,
      ts: new Date(),
      actor: "agent",
      eventType: "agent_transcript",
      payload: { evidence_only: true, transcript: forRecord },
    }),
  );
}
