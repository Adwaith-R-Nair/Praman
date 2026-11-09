import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// The builder's one-time consent as the demo's sandbox buyer (D-85, docs/DEPLOY.md step 9).
// It talks to PayPal's sandbox only, with this sandbox app's credentials from .env, and
// saves the payment token to a file outside the repo. The token is never printed.
//
//   pnpm house-buyer [file]     default file: ~/.praman/house-buyer-token

const REPO = fileURLToPath(new URL("../", import.meta.url));
config({ path: `${REPO}.env`, quiet: true });

const { PayPalVault, PAYPAL_SANDBOX_BASE_URL } = await import("@praman/paypal-exec");
const { consentAsHouseBuyer } = await import("../apps/receipt-ui/src/demo/house-consent.js");
type ConsentResult = import("../apps/receipt-ui/src/demo/house-consent.js").ConsentResult;

const clientId = process.env["PAYPAL_CLIENT_ID"];
const clientSecret = process.env["PAYPAL_CLIENT_SECRET"];
if (!clientId || !clientSecret) {
  console.error("house-buyer: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set in .env. Use the same sandbox app as the hosted demo: only that app can charge the token.");
  process.exit(1);
}

const outPath = process.argv[2] ?? join(homedir(), ".praman", "house-buyer-token");
const base = (process.env["DEMO_BASE_URL"] || "http://localhost:4100").replace(/\/+$/, "");
const lines = createInterface({ input: process.stdin, output: process.stdout });

const result = await consentAsHouseBuyer(
  new PayPalVault({ clientId, clientSecret, baseUrl: PAYPAL_SANDBOX_BASE_URL, fetch: globalThis.fetch }),
  { outPath, repoRoot: REPO, returnUrl: `${base}/`, requestId: createHash("sha256").update(`house-setup|${new Date().toISOString()}`, "utf8").digest("hex") },
  {
    say: (line) => console.log(line),
    waitForApproval: async () => {
      await lines.question("Press Enter once PayPal has shown the approval as done. ");
    },
  },
).catch((err: unknown): ConsentResult => ({ ok: false, reason: `PayPal couldn't be asked (${err instanceof Error ? err.name : "unknown error"}). Nothing was saved.` }));
lines.close();

if (!result.ok) {
  console.error(`house-buyer: ${result.reason}`);
  process.exit(1);
}
console.log("Next: paste that file's one line into Render as DEMO_HOUSE_BUYER_TOKEN (docs/DEPLOY.md, step 9).");
