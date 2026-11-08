import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// dotenv must load before any dynamic import reaches @praman/db (see scripts/approve.ts).
// quiet: stdout is the MCP channel, and one stray line there breaks the client.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { createGateway } = await import("./gateway.js");
const { gatewayFromEnv } = await import("./env.js");

const loaded = gatewayFromEnv(process.env);
if (!loaded.ok) {
  console.error(`praman-mcp: not starting: ${loaded.error}`);
  process.exit(1);
}
const { deps, mode } = loaded.value;
console.error(`praman-mcp: mandate ${deps.signed.document.mandate_id}, merchants ${deps.merchants.join(", ")}, rail ${mode}`);

await createGateway(deps).connect(new StdioServerTransport());
