import { GeminiProvider } from "@praman/agent-core";
import { PayPalExecutor, PayPalVault, PAYPAL_SANDBOX_BASE_URL } from "@praman/paypal-exec";
import type { DemoDeps } from "./connect.js";
import { SavedMethods, SessionStore } from "./session.js";

export type DemoWiring = { readonly ok: true; readonly deps: DemoDeps } | { readonly ok: false; readonly reason: string };

const pem = (b64: string): string => Buffer.from(b64, "base64").toString("utf8");

/**
 * The demo from .env. It runs only with its own signing key (DEMO_MANDATE_PRIVATE_KEY),
 * never the local MANDATE_PRIVATE_KEY, because the hosted server issues mandates to
 * strangers (design, "Agent's calls"). PayPal and the model are optional: without them
 * the steps that need them say so.
 */
export function demoDepsFromEnv(env: NodeJS.ProcessEnv, port: number): DemoWiring {
  const privateB64 = env["DEMO_MANDATE_PRIVATE_KEY"];
  const publicB64 = env["DEMO_MANDATE_PUBLIC_KEY"];
  if (!privateB64 || !publicB64) return { ok: false, reason: "DEMO_MANDATE_PRIVATE_KEY and DEMO_MANDATE_PUBLIC_KEY are not set" };
  if (privateB64 === env["MANDATE_PRIVATE_KEY"]) return { ok: false, reason: "the demo key is the local mandate key; the demo needs its own" };

  const baseUrl = (env["DEMO_BASE_URL"] || `http://localhost:${port.toString()}`).replace(/\/+$/, "");
  const clientId = env["PAYPAL_CLIENT_ID"];
  const clientSecret = env["PAYPAL_CLIENT_SECRET"];
  const paypalConfig = clientId && clientSecret ? { clientId, clientSecret, baseUrl: PAYPAL_SANDBOX_BASE_URL, fetch: globalThis.fetch } : null;
  const geminiKey = env["GEMINI_API_KEY"];

  return {
    ok: true,
    deps: {
      sessions: new SessionStore({ privateKeyPem: pem(privateB64), publicKeyPem: pem(publicB64), keyId: "praman_demo_k1" }),
      savedMethods: new SavedMethods(),
      publicKeyPem: pem(publicB64),
      paypal:
        paypalConfig === null
          ? null
          : {
              executor: new PayPalExecutor({ ...paypalConfig, checkoutReturn: { returnUrl: `${baseUrl}/demo/checkout/return`, cancelUrl: `${baseUrl}/demo/checkout/cancel` } }),
              vault: new PayPalVault(paypalConfig),
            },
      provider: geminiKey ? new GeminiProvider(geminiKey, "gemini-3.1-flash-lite") : null,
      baseUrl,
      now: () => new Date(),
      log: (line) => console.log(line),
    },
  };
}
