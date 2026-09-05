import { wrapUntrusted } from "@praman/shared";
import type { ConversationItem, ModelProvider } from "@praman/agent-core";
import { createCatalogClient, type CatalogClient } from "./catalog-client.js";
import { TOOLS } from "./tools.js";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_NO_DEFENCE } from "./prompt.js";

/** Bounded so an injected loop cannot burn budget or probe indefinitely. */
const MAX_TURNS = 12;

export interface ProposedCart {
  readonly merchant_id: string;
  readonly line_items: readonly { sku: string; qty: number }[];
  readonly rationale: string;
}

export type AgentResult =
  | { readonly kind: "PROPOSED"; readonly cart: ProposedCart; readonly transcript: readonly ConversationItem[]; readonly modelId: string }
  | { readonly kind: "NO_PROPOSAL"; readonly reason: string; readonly transcript: readonly ConversationItem[]; readonly modelId: string }
  | { readonly kind: "TURN_LIMIT"; readonly transcript: readonly ConversationItem[]; readonly modelId: string };

/**
 * Ablation-only escape hatch. Read live, per call, not cached — the
 * ablation runner toggles this mid-process across arms. Every real run
 * (demo, eval, anything without this env var) delimits merchant text; D-07
 * is untouched.
 */
function wrapMerchantText(text: string): string {
  return process.env["PRAMAN_NO_DELIMITER"] === "1" ? text : wrapUntrusted(text);
}

// Titles and descriptions are merchant-authored regardless of which
// CatalogClient fetched them — wrapping happens here, once, at the
// boundary where this text is about to enter a prompt (D-07), not inside
// either client implementation.
async function runTool(name: string, input: Record<string, unknown>, catalog: CatalogClient): Promise<string> {
  if (name === "list_catalog") {
    const category = typeof input["category"] === "string" ? input["category"] : undefined;
    const items = await catalog.listCatalog(category);
    return items
      .map(
        (i) =>
          `sku=${i.sku} category=${i.category} price_paise=${i.price_paise} in_stock=${i.in_stock}\n` +
          wrapMerchantText(`${i.title}\n${i.description}`),
      )
      .join("\n\n");
  }

  if (name === "get_sku") {
    const item = await catalog.getSku(String(input["sku"]));
    if (!item) return `No such SKU: ${String(input["sku"])}`;
    return (
      `sku=${item.sku} category=${item.category} price_paise=${item.price_paise} in_stock=${item.in_stock}\n` +
      wrapMerchantText(`${item.title}\n${item.description}`)
    );
  }

  return `Unknown tool: ${name}`;
}

export async function runAgent(provider: ModelProvider, goal: string, merchantId: string): Promise<AgentResult> {
  const history: ConversationItem[] = [{ role: "user", text: `Merchant: ${merchantId}\nGoal: ${goal}` }];
  // Read live, not hoisted above the loop — same reasoning as wrapMerchantText.
  const systemPrompt = process.env["PRAMAN_NO_PROMPT_DEFENCE"] === "1" ? SYSTEM_PROMPT_NO_DEFENCE : SYSTEM_PROMPT;

  // One client for the whole call, not one per tool call — under PRAMAN_MCP=1
  // that's one subprocess per runAgent(), not one per list_catalog/get_sku.
  const catalog = createCatalogClient(merchantId);
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await provider.send(systemPrompt, history, TOOLS);

      if (res.kind === "TEXT") {
        return { kind: "NO_PROPOSAL", reason: res.text, transcript: history, modelId: provider.id };
      }

      let proposed: ProposedCart | null = null;
      const toolResults: { id: string; name: string; content: string }[] = [];

      for (const call of res.calls) {
        if (call.name === "propose_intent") {
          proposed = {
            merchant_id: String(call.input["merchant_id"]),
            line_items: (call.input["line_items"] as { sku: string; qty: number }[] | undefined) ?? [],
            rationale: String(call.input["rationale"] ?? ""),
          };
          break;
        }
        toolResults.push({ id: call.id, name: call.name, content: await runTool(call.name, call.input, catalog) });
      }

      history.push({ role: "assistant", calls: res.calls, text: "", raw: res.raw });

      if (proposed) {
        return { kind: "PROPOSED", cart: proposed, transcript: history, modelId: provider.id };
      }

      history.push({ role: "tool_results", results: toolResults });
    }
  } finally {
    await catalog.close();
  }

  return { kind: "TURN_LIMIT", transcript: history, modelId: provider.id };
}
