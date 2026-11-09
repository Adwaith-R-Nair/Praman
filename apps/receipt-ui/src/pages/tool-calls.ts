import { escapeHtml } from "../html.js";

/**
 * The model's tool calls on a trace, read from its agent_transcript rows. Everything
 * here is untrusted: the tool name and input are model output, and a result can hold
 * merchant text. It is evidence for a reader and is only ever shown as escaped text.
 * Nothing reads it back into a prompt, and nothing decides from it.
 *
 * A transcript holds what the agent saw and sent, and the agent is never told a
 * mandate's limits or a step-up's reason (D-08), so this adds nothing to a public page
 * that the public dispute bundle's `agent.tool_calls` doesn't already carry (D-84).
 */
export interface ToolCallView {
  readonly name: string;
  /** The call's input as compact JSON text. */
  readonly input: string;
  /** Exactly what the tool returned to the model, or null when the transcript records no result. */
  readonly result: string | null;
}

/** Bounds on what one page shows. The dispute bundle has the full transcript. */
export const MAX_TOOL_CALLS_SHOWN = 40;
export const MAX_RESULT_CHARS_SHOWN = 12_000;

const UNTRUSTED_OPEN = "<untrusted_merchant_content>";

/** The tools that hand a cart to Praman. They return nothing the model reads back as a tool result. */
const PROPOSAL_TOOLS: ReadonlySet<string> = new Set(["propose_intent", "propose_purchase"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function inputText(input: unknown): string {
  try {
    return JSON.stringify(input === undefined ? {} : input) ?? "{}";
  } catch {
    return "(input could not be shown)";
  }
}

/**
 * Calls in the order the model made them, each with the result that answered it. A
 * result belongs to the calls of the assistant turn just before it, matched by id and
 * used once, so ids a provider repeats across turns can't pair a call with another
 * turn's result. A row that isn't shaped like a transcript gives no calls.
 */
export function toolCallsOf(entries: readonly { readonly eventType: string; readonly payload: unknown }[]): ToolCallView[] {
  const calls: ToolCallView[] = [];
  for (const entry of entries) {
    if (entry.eventType !== "agent_transcript" || !isRecord(entry.payload)) continue;
    const transcript = entry.payload["transcript"];
    if (!Array.isArray(transcript)) continue;
    const items: readonly unknown[] = transcript;

    items.forEach((item, index) => {
      if (!isRecord(item) || item["role"] !== "assistant" || !Array.isArray(item["calls"])) return;
      const next = items[index + 1];
      const answers: unknown[] = isRecord(next) && next["role"] === "tool_results" && Array.isArray(next["results"]) ? [...next["results"]] : [];
      const made: readonly unknown[] = item["calls"];
      for (const call of made) {
        if (!isRecord(call) || typeof call["name"] !== "string") continue;
        const at = answers.findIndex((a) => isRecord(a) && a["id"] === call["id"] && typeof a["content"] === "string");
        const answer = at === -1 ? null : answers.splice(at, 1)[0];
        const content = isRecord(answer) ? answer["content"] : null;
        calls.push({ name: call["name"], input: inputText(call["input"]), result: typeof content === "string" ? content : null });
      }
    });
  }
  return calls;
}

function resultHtml(call: ToolCallView): string {
  if (call.result === null) {
    const why = PROPOSAL_TOOLS.has(call.name)
      ? "No result came back to the model. This call is the proposal: it names items and quantities only. Praman priced it from the catalog and decided."
      : "No result is recorded for this call.";
    return `<p class="tool-none">${escapeHtml(why)}</p>`;
  }
  const merchant = call.result.includes(UNTRUSTED_OPEN);
  const blocks = call.result.split(UNTRUSTED_OPEN).length - 1;
  const size = `${call.result.length.toString()} characters`;
  const summary = merchant ? `Result: ${blocks.toString()} ${blocks === 1 ? "block" : "blocks"} of merchant text, ${size}` : `Result: ${size}`;
  const shown = call.result.slice(0, MAX_RESULT_CHARS_SHOWN);
  const cut = call.result.length - shown.length;
  return `<details class="tool-result">
          <summary>${escapeHtml(summary)}</summary>
          <div class="untrusted">
            <span class="stamp">${merchant ? "merchant data" : "tool output"}</span>
            <p class="untrusted-note">Exactly what the tool returned to the model, delimiters included. Treated as data, never as instructions.</p>
            <pre class="tool-text">${escapeHtml(shown)}</pre>
            ${cut > 0 ? `<p class="untrusted-note">${escapeHtml(`${cut.toString()} more characters are in the dispute bundle.`)}</p>` : ""}
          </div>
        </details>`;
}

/** The trace page's "What the agent did" section, or nothing when the trace has no recorded calls. */
export function toolCallsHtml(calls: readonly ToolCallView[]): string {
  if (calls.length === 0) return "";
  const shown = calls.slice(0, MAX_TOOL_CALLS_SHOWN);
  const more = calls.length - shown.length;
  const items = shown
    .map(
      (call) => `<li class="tool-call">
        <div class="tool-head"><span class="tool-name data">${escapeHtml(call.name)}</span></div>
        <div class="tool-input"><span class="tool-label">input</span> <code class="data">${escapeHtml(call.input)}</code></div>
        ${resultHtml(call)}
      </li>`,
    )
    .join("\n");
  return `<section class="tool-calls">
  <h2>What the agent did</h2>
  <p class="tool-lede">The model's tool calls, in order, from the transcript on the ledger. Names and inputs are the model's own output. From a proposal Praman reads the item and the quantity, and the price comes from the catalog.</p>
  <ol class="tool-list">${items}</ol>
  ${more > 0 ? `<p class="tool-none">${escapeHtml(`${more.toString()} more ${more === 1 ? "call is" : "calls are"} in the dispute bundle.`)}</p>` : ""}
</section>`;
}
