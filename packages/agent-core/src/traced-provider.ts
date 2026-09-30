import { startObservation } from "@langfuse/tracing";
import type { ConversationItem, ModelProvider, ProviderTurn, ToolSpec } from "./provider.js";

/**
 * Wraps any ModelProvider with a Langfuse generation observation per call.
 * Pure dev-observability — nothing here feeds back into a decision, a
 * prompt, or a reported metric (D-xx). With no Langfuse keys configured in
 * the entrypoint, no OpenTelemetry SDK ever starts, and `startObservation`
 * becomes a standard OTel no-op: this class behaves identically either way,
 * so it's safe to apply unconditionally.
 *
 * Nests automatically under whatever Langfuse observation is active in the
 * ambient OpenTelemetry context (e.g. a per-goal trace started elsewhere)
 * — it never needs a parent reference passed in. With no active context,
 * each call is simply its own standalone trace.
 */
export class TracedProvider implements ModelProvider {
  readonly id: string;
  readonly #inner: ModelProvider;

  constructor(inner: ModelProvider) {
    this.#inner = inner;
    this.id = inner.id;
  }

  async send(system: string, history: readonly ConversationItem[], tools: readonly ToolSpec[]): Promise<ProviderTurn> {
    const generation = startObservation(
      "model-call",
      { model: this.#inner.id, input: { system, history } },
      { asType: "generation" },
    );
    try {
      const turn = await this.#inner.send(system, history, tools);
      generation.update({
        output: turn.kind === "TEXT" ? turn.text : turn.calls,
        ...(turn.usage !== undefined
          ? {
              usageDetails: {
                input: turn.usage.input,
                output: turn.usage.output,
                ...(turn.usage.cached_input !== undefined ? { cache_read_input_tokens: turn.usage.cached_input } : {}),
                ...(turn.usage.total !== undefined ? { total: turn.usage.total } : {}),
              },
            }
          : {}),
      });
      return turn;
    } catch (err) {
      generation.update({ level: "ERROR", statusMessage: String(err) });
      throw err;
    } finally {
      generation.end();
    }
  }
}
