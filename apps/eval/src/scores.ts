import type { StopOutcome, TracingConfig } from "@praman/buyer-agent";
import type { CaseResult } from "./types.js";

/**
 * Dev observability only (D-47). After a Layer 2 case runs, its two
 * deterministic results are copied onto the case's Langfuse trace, so a
 * developer looking at a trace sees whether the injection reached the cart
 * and whether money moved. The values come from the runner's own
 * CaseResult. Nothing reads them back: eval/report.md is computed from
 * CaseResult, never from Langfuse, and no model scores anything here.
 */
export interface DeterministicScore {
  readonly name: "influenced" | "money_moved";
  readonly value: 0 | 1;
}

export function deterministicScores(r: CaseResult): readonly DeterministicScore[] {
  return [
    { name: "influenced", value: r.influenced === true ? 1 : 0 },
    { name: "money_moved", value: r.money_moved ? 1 : 0 },
  ];
}

/** The one Langfuse call this file makes, kept narrow so a test can stand in for the client. */
export interface ScoreClient {
  readonly score: {
    create(body: {
      readonly id: string;
      readonly traceId: string;
      readonly name: string;
      readonly value: number;
      readonly dataType: "BOOLEAN";
      readonly comment: string;
    }): void;
  };
}

export interface ScoreSink {
  push(langfuseTraceId: string, result: CaseResult): void;
}

export function langfuseScoreSink(client: ScoreClient): ScoreSink {
  return {
    push(langfuseTraceId, result) {
      for (const s of deterministicScores(result)) {
        client.score.create({
          // Fixed per trace and name, so pushing again updates the score
          // rather than adding a second one.
          id: `${langfuseTraceId}-${s.name}`,
          traceId: langfuseTraceId,
          name: s.name,
          value: s.value,
          dataType: "BOOLEAN",
          comment: "Copied from the eval runner's result. eval/report.md is the source of truth.",
        });
      }
    },
  };
}

export interface Scores {
  /** Undefined when no Langfuse keys are configured. */
  readonly sink: ScoreSink | undefined;
  /** Sends queued scores, waiting at most `timeoutMs`. Never throws. */
  stop(timeoutMs?: number): Promise<StopOutcome>;
}

const OFF: Scores = { sink: undefined, stop: () => Promise.resolve("off") };

export async function startScoreSink(config: TracingConfig): Promise<Scores> {
  const publicKey = config.LANGFUSE_PUBLIC_KEY;
  const secretKey = config.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return OFF;

  const { LangfuseClient } = await import("@langfuse/client");
  const client = new LangfuseClient({
    publicKey,
    secretKey,
    baseUrl: config.LANGFUSE_BASE_URL || "https://cloud.langfuse.com",
  });

  return {
    sink: langfuseScoreSink(client),
    async stop(timeoutMs = 3000): Promise<StopOutcome> {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<StopOutcome>((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), timeoutMs);
        timer.unref();
      });
      const shutdown = client.shutdown().then(
        (): StopOutcome => "flushed",
        (): StopOutcome => "failed",
      );
      const outcome = await Promise.race([shutdown, deadline]);
      clearTimeout(timer);
      return outcome;
    },
  };
}
