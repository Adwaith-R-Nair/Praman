import { context, propagation, trace } from "@opentelemetry/api";

/**
 * Dev observability only (D-47). Starts Langfuse tracing for an entrypoint
 * (the demo, the eval CLIs) and stops it again. Library code never calls
 * this: it only creates spans, which do nothing until an entrypoint has
 * started tracing here.
 *
 * Every value comes in through `config`, never from process.env directly,
 * so a test can point tracing at a local or closed port without a real key
 * in the environment being picked up by the Langfuse processor's own
 * fallback.
 */
export interface TracingConfig {
  readonly LANGFUSE_PUBLIC_KEY?: string | undefined;
  readonly LANGFUSE_SECRET_KEY?: string | undefined;
  readonly LANGFUSE_BASE_URL?: string | undefined;
}

/** What happened to the spans still buffered when tracing stopped. */
export type StopOutcome = "off" | "flushed" | "timed_out" | "failed";

export interface Tracing {
  /** False when no keys were configured. Nothing was started, and stop() returns "off". */
  readonly active: boolean;
  /**
   * Sends whatever spans are still buffered, but waits at most `timeoutMs`.
   * A slow or unreachable Langfuse host costs the caller that much time and
   * no more. Never throws. Afterwards the global OpenTelemetry providers are
   * unregistered, so a span started later goes nowhere.
   */
  stop(timeoutMs?: number): Promise<StopOutcome>;
}

export const DEFAULT_FLUSH_TIMEOUT_MS = 3000;

const INACTIVE: Tracing = { active: false, stop: () => Promise.resolve("off") };

export async function startTracing(config: TracingConfig): Promise<Tracing> {
  const publicKey = config.LANGFUSE_PUBLIC_KEY;
  const secretKey = config.LANGFUSE_SECRET_KEY;
  // Both keys, or nothing starts. LangfuseSpanProcessor doesn't refuse
  // missing credentials: it logs a warning and every export then fails.
  if (!publicKey || !secretKey) return INACTIVE;

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { LangfuseSpanProcessor } = await import("@langfuse/otel");
  const sdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey,
        secretKey,
        baseUrl: config.LANGFUSE_BASE_URL || "https://cloud.langfuse.com",
      }),
    ],
  });
  sdk.start();

  return {
    active: true,
    async stop(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<StopOutcome> {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<StopOutcome>((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), timeoutMs);
        // A pending timer must not keep a finished process alive.
        timer.unref();
      });
      const shutdown = sdk.shutdown().then(
        (): StopOutcome => "flushed",
        (): StopOutcome => "failed",
      );
      const outcome = await Promise.race([shutdown, deadline]);
      clearTimeout(timer);
      trace.disable();
      context.disable();
      propagation.disable();
      return outcome;
    },
  };
}
