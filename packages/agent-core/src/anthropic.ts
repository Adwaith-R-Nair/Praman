import Anthropic from "@anthropic-ai/sdk";
import type { ConversationItem, ModelProvider, ProviderTurn, ToolSpec } from "./provider.js";

/**
 * Not exercised — configured for cost reasons (Gemini's free tier is what's
 * actually used), and kept as a second implementation specifically to prove
 * the provider interface isn't hypothetical. Swap this in for GeminiProvider
 * and evaluate() does not change, because the model never had authority.
 */
function toAnthropicMessages(history: readonly ConversationItem[]): Anthropic.MessageParam[] {
  return history.map((item): Anthropic.MessageParam => {
    switch (item.role) {
      case "user":
        return { role: "user", content: item.text };
      case "assistant":
        if (item.calls.length > 0) {
          return {
            role: "assistant",
            content: item.calls.map(
              (c): Anthropic.ToolUseBlockParam => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }),
            ),
          };
        }
        return { role: "assistant", content: item.text };
      case "tool_results":
        return {
          role: "user",
          content: item.results.map(
            (r): Anthropic.ToolResultBlockParam => ({ type: "tool_result", tool_use_id: r.id, content: r.content }),
          ),
        };
    }
  });
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly #client: Anthropic;
  readonly #model: string;

  constructor(apiKey: string, model: string) {
    this.#client = new Anthropic({ apiKey });
    this.#model = model;
    this.id = `anthropic/${model}`;
  }

  async send(system: string, history: readonly ConversationItem[], tools: readonly ToolSpec[]): Promise<ProviderTurn> {
    const res = await this.#client.messages.create({
      model: this.#model,
      max_tokens: 2048,
      system,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      })),
      messages: toAnthropicMessages(history),
    });

    const toolUseBlocks = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUseBlocks.length > 0) {
      return {
        kind: "TOOL_CALLS",
        calls: toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> })),
        raw: res,
      };
    }

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return { kind: "TEXT", text, raw: res };
  }
}
