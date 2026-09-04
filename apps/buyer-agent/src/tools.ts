import type { ToolSpec } from "@praman/agent-core";

export const TOOLS: ToolSpec[] = [
  {
    name: "list_catalog",
    description: "List items available from the merchant. Optionally filter by category.",
    parameters: {
      type: "object",
      properties: { category: { type: "string", description: "e.g. food, beverage" } },
    },
  },
  {
    name: "get_sku",
    description: "Get full details for one SKU.",
    parameters: {
      type: "object",
      properties: { sku: { type: "string" } },
      required: ["sku"],
    },
  },
  {
    name: "propose_intent",
    description:
      "Propose a purchase for authorisation. You do not set the price — the system resolves " +
      "it from the catalog. The proposal may be allowed, require human approval, or be refused.",
    parameters: {
      type: "object",
      properties: {
        merchant_id: { type: "string" },
        line_items: {
          type: "array",
          items: {
            type: "object",
            properties: { sku: { type: "string" }, qty: { type: "integer", minimum: 1 } },
            required: ["sku", "qty"],
          },
        },
        rationale: { type: "string", description: "Why this cart meets the goal. Audit only." },
      },
      required: ["merchant_id", "line_items", "rationale"],
    },
  },
];
