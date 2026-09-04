import {
  GoogleGenAI,
  ApiError,
  createUserContent,
  createModelContent,
  createPartFromFunctionCall,
  createPartFromFunctionResponse,
  type Content,
} from "@google/genai";
import type { ConversationItem, ModelProvider, ProviderTurn, ToolSpec } from "./provider.js";

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

function isRetryable(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 429 || err.status === 503);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts the exact Content the API returned for a prior turn, if `raw`
 * looks like one of our own GenerateContentResponse objects. Gemini 3's
 * function-call parts carry a `thoughtSignature` that must round-trip
 * unchanged — reconstructing the part from {name, input} alone drops it and
 * the next request is rejected outright (verified against the live API, not
 * assumed).
 */
function extractOriginalModelContent(raw: unknown): Content | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const candidates = (raw as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const content = (candidates[0] as { content?: unknown }).content;
  if (content === null || typeof content !== "object") return undefined;
  return content as Content;
}

function toGeminiContent(item: ConversationItem): Content {
  switch (item.role) {
    case "user":
      return createUserContent(item.text);
    case "assistant": {
      if (item.calls.length === 0) return createModelContent(item.text);
      const original = extractOriginalModelContent(item.raw);
      if (original) return original;
      // Fallback for calls that didn't originate from this provider (e.g.
      // history replayed across providers) — works, but without a thought
      // signature, which only Gemini 3-generation models require.
      return { role: "model", parts: item.calls.map((c) => createPartFromFunctionCall(c.name, c.input)) };
    }
    case "tool_results":
      // Gemini's convention: function responses go back as a "user" turn,
      // same shape as Anthropic's tool_result-as-user-message convention.
      return {
        role: "user",
        parts: item.results.map((r) => createPartFromFunctionResponse(r.id, r.name, { output: r.content })),
      };
  }
}

export class GeminiProvider implements ModelProvider {
  readonly id: string;
  readonly #ai: GoogleGenAI;
  readonly #model: string;

  constructor(apiKey: string, model: string) {
    this.#ai = new GoogleGenAI({ apiKey });
    this.#model = model;
    this.id = `google/${model}`;
  }

  async send(system: string, history: readonly ConversationItem[], tools: readonly ToolSpec[]): Promise<ProviderTurn> {
    let lastErr: unknown;
    for (const delay of [0, ...RETRY_DELAYS_MS]) {
      if (delay > 0) await sleep(delay);
      try {
        return await this.#sendOnce(system, history, tools);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) throw err;
      }
    }
    throw lastErr;
  }

  async #sendOnce(system: string, history: readonly ConversationItem[], tools: readonly ToolSpec[]): Promise<ProviderTurn> {
    const res = await this.#ai.models.generateContent({
      model: this.#model,
      contents: history.map(toGeminiContent),
      config: {
        systemInstruction: system,
        // Note: FunctionDeclaration.parameters expects Gemini's own typed
        // Schema, not raw JSON Schema — parametersJsonSchema is the field
        // meant for that, and is documented as mutually exclusive with
        // `parameters`. Verified against the SDK's own .d.ts, not assumed.
        tools: [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.parameters,
            })),
          },
        ],
      },
    });

    const calls = res.functionCalls ?? [];
    if (calls.length > 0) {
      return {
        kind: "TOOL_CALLS",
        calls: calls.map((c, i) => ({
          // Gemini populates FunctionCall.id when it wants a matching
          // response id back; fall back to a synthesized one only if absent.
          id: c.id ?? `${c.name ?? "call"}_${i}`,
          name: c.name ?? "",
          input: c.args ?? {},
        })),
        raw: res,
      };
    }
    return { kind: "TEXT", text: res.text ?? "", raw: res };
  }
}
