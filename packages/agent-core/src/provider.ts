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

export type ProviderTurn =
  | { readonly kind: "TOOL_CALLS"; readonly calls: readonly ToolCall[]; readonly raw: unknown }
  | { readonly kind: "TEXT"; readonly text: string; readonly raw: unknown };

/**
 * Neutral conversation format — neither Anthropic's nor Google's. Each
 * provider translates at its own edge; the agent loop never sees a vendor type.
 */
export type ConversationItem =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "assistant"; readonly calls: readonly ToolCall[]; readonly text: string }
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
