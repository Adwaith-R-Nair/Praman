import { prisma, listCatalogForAgent } from "@praman/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

export interface CatalogItem {
  readonly sku: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly price_paise: string;
  readonly in_stock: boolean;
}

/**
 * Whatever transport fetched the catalog, the shape coming out is the
 * same — so wrapMerchantText()/the agent-facing text format in
 * runTool() (agent.ts) only has to exist once, applied at the one
 * boundary that actually matters, regardless of which client produced
 * the data.
 */
export interface CatalogClient {
  listCatalog(category?: string): Promise<readonly CatalogItem[]>;
  getSku(sku: string): Promise<CatalogItem | null>;
  close(): Promise<void>;
}

class DirectCatalogClient implements CatalogClient {
  constructor(private readonly merchantId: string) {}

  async listCatalog(category?: string): Promise<readonly CatalogItem[]> {
    const items = await listCatalogForAgent(prisma, this.merchantId);
    const filtered = category ? items.filter((i) => i.category === category) : items;
    return filtered.map(toCatalogItem);
  }

  async getSku(sku: string): Promise<CatalogItem | null> {
    const items = await listCatalogForAgent(prisma, this.merchantId);
    const item = items.find((i) => i.sku === sku);
    return item ? toCatalogItem(item) : null;
  }

  async close(): Promise<void> {
    // No connection of its own — prisma's own lifecycle is the caller's concern.
  }
}

function toCatalogItem(item: {
  sku: string;
  title: string;
  description: string;
  category: string;
  price_paise: { toString(): string };
  in_stock: boolean;
}): CatalogItem {
  return {
    sku: item.sku,
    title: item.title,
    description: item.description,
    category: item.category,
    price_paise: item.price_paise.toString(),
    in_stock: item.in_stock,
  };
}

/**
 * callTool()'s return type is a union — the plain content-array shape used
 * here, or an experimental task-based "toolResult" shape this codebase
 * never requests. Narrowing explicitly rather than asserting, since a
 * server sending back a shape this client doesn't handle should fail
 * loudly, not silently coerce.
 */
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function isErrorResult(result: ToolResult): boolean {
  return "isError" in result && result.isError === true;
}

function firstText(result: ToolResult): string {
  if (!("content" in result) || !Array.isArray(result.content)) {
    throw new Error("mcp tool returned no text content");
  }
  const first = result.content[0] as { type: string; text?: string } | undefined;
  if (!first || typeof first.text !== "string") throw new Error("mcp tool returned no text content");
  return first.text;
}

/**
 * Talks to apps/merchant-mcp/src/server.ts as a real, separate process over
 * stdio — the same protocol any other MCP client (Claude Desktop, another
 * agent) would use to reach this merchant. Connects lazily, on first tool
 * call, and only once per runAgent() call — spawning a subprocess per tool
 * call would make even one demo run pay for N process starts.
 */
class McpCatalogClient implements CatalogClient {
  private client: Client | null = null;

  constructor(private readonly merchantId: string) {}

  private async connection(): Promise<Client> {
    if (this.client) return this.client;
    const serverPath = fileURLToPath(new URL("../../merchant-mcp/src/server.ts", import.meta.url));
    const transport = new StdioClientTransport({
      command: "pnpm",
      args: ["exec", "tsx", serverPath],
      env: { ...process.env, MERCHANT_MCP_MERCHANT_ID: this.merchantId } as Record<string, string>,
    });
    const client = new Client({ name: "praman-buyer-agent", version: "0.0.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async listCatalog(category?: string): Promise<readonly CatalogItem[]> {
    const client = await this.connection();
    const result = await client.callTool({ name: "list_catalog", arguments: category ? { category } : {} });
    return JSON.parse(firstText(result)) as CatalogItem[];
  }

  async getSku(sku: string): Promise<CatalogItem | null> {
    const client = await this.connection();
    const result = await client.callTool({ name: "get_sku", arguments: { sku } });
    if (isErrorResult(result)) return null;
    return JSON.parse(firstText(result)) as CatalogItem;
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
  }
}

/**
 * PRAMAN_MCP=1 routes the agent's catalog reads through the real MCP
 * server as a subprocess; unset (the default) calls listCatalogForAgent()
 * directly. Evals use the direct path — spawning a subprocess per one of
 * 40 corpus cases would be slow and flaky — the demo and video use MCP.
 */
export function createCatalogClient(merchantId: string): CatalogClient {
  return process.env["PRAMAN_MCP"] === "1" ? new McpCatalogClient(merchantId) : new DirectCatalogClient(merchantId);
}
