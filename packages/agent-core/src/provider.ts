export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * Normalised across providers so a caller never branches on which one sent
 * this turn. `total`, `cached_input` are populated only when the provider's
 * own response actually carries them — never derived, so a report built
 * from this never states a number the provider didn't itself report.
 */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cached_input?: number;
  readonly total?: number;
}

export type ProviderTurn =
  | { readonly kind: "TOOL_CALLS"; readonly calls: readonly ToolCall[]; readonly raw: unknown; readonly usage?: TokenUsage }
  | { readonly kind: "TEXT"; readonly text: string; readonly raw: unknown; readonly usage?: TokenUsage };

/**
 * Neutral conversation format — neither Anthropic's nor Google's. Each
 * provider translates at its own edge; the agent loop never sees a vendor type.
 */
export type ConversationItem =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly calls: readonly ToolCall[];
      readonly text: string;
      /**
       * The provider's own opaque turn data (ProviderTurn.raw), echoed back
       * verbatim when present. Some providers require exact replay of their
       * own prior turn, not a reconstruction from {id, name, input} — Gemini
       * 3-generation models attach a `thoughtSignature` to each function-call
       * part that must round-trip unchanged, or the API rejects the next
       * request outright. A provider that doesn't need this ignores the field.
       */
      readonly raw?: unknown;
    }
  | { readonly role: "tool_results"; readonly results: readonly { id: string; name: string; content: string }[] };

export interface ModelProvider {
  /** Recorded in the ledger and eval report — a result is never separable from the model that produced it. */
  readonly id: string;
  send(
    system: string,
    history: readonly ConversationItem[],
    tools: readonly ToolSpec[],
  ): Promise<ProviderTurn>;
}
