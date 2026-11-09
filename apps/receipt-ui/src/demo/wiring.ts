import { GeminiProvider } from "@praman/agent-core";
import { PayPalExecutor, PayPalVault, PAYPAL_SANDBOX_BASE_URL } from "@praman/paypal-exec";
import type { DemoDeps } from "./connect.js";
import { HouseBuyer } from "./house.js";
import { capFromEnv, DbDailyUsage, DEFAULT_DAILY_HOUSE_SESSIONS, DEFAULT_DAILY_MODEL_CALLS, DEFAULT_DAILY_SESSIONS } from "./limits.js";
import { SavedMethods, SessionStore } from "./session.js";

export type DemoWiring = { readonly ok: true; readonly deps: DemoDeps } | { readonly ok: false; readonly reason: string };

const pem = (b64: string): string => Buffer.from(b64, "base64").toString("utf8");

/**
 * The demo from .env. It runs only with its own signing key (DEMO_MANDATE_PRIVATE_KEY),
 * never the local MANDATE_PRIVATE_KEY, because the hosted server issues mandates to
 * strangers (design, "Agent's calls"). PayPal and the model are optional: without them
 * the steps that need them say so.
 *
 * DEMO_HOUSE_BUYER_TOKEN is the switch for the demo's shared sandbox buyer (D-85): the
 * payment token of one sandbox account the builder approved saving. Unset, there is no
 * house buyer. Set with DEMO_DAILY_HOUSE_SESSIONS at 0, or with no PayPal credentials to
 * charge it with, it is switched off: nothing offers it, no session is put on it, and the
 * server still knows the token, so it still never deletes it at PayPal. A visitor who logs
 * in as that same sandbox account can still be charged on it, as any login is (D-85).
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
  const houseToken = env["DEMO_HOUSE_BUYER_TOKEN"];
  const houseSessions = capFromEnv(env, "DEMO_DAILY_HOUSE_SESSIONS", DEFAULT_DAILY_HOUSE_SESSIONS);
  const house = houseToken ? new HouseBuyer(houseToken, { on: paypalConfig !== null && houseSessions > 0 }) : null;

  return {
    ok: true,
    deps: {
      sessions: new SessionStore({ privateKeyPem: pem(privateB64), publicKeyPem: pem(publicB64), keyId: "praman_demo_k1" }),
      savedMethods: new SavedMethods(),
      usage: new DbDailyUsage({
        session: capFromEnv(env, "DEMO_DAILY_SESSIONS", DEFAULT_DAILY_SESSIONS),
        model_call: capFromEnv(env, "DEMO_DAILY_MODEL_CALLS", DEFAULT_DAILY_MODEL_CALLS),
        house_session: house?.on === true ? houseSessions : 0,
      }),
      publicKeyPem: pem(publicB64),
      paypal:
        paypalConfig === null
          ? null
          : {
              executor: new PayPalExecutor({ ...paypalConfig, checkoutReturn: { returnUrl: `${baseUrl}/demo/checkout/return`, cancelUrl: `${baseUrl}/demo/checkout/cancel` } }),
              vault: new PayPalVault(paypalConfig),
            },
      house,
      // checkStartup has already refused anything but one digit here.
      proxyHops: /^\d$/.test(env["TRUST_PROXY"] ?? "") ? Number(env["TRUST_PROXY"]) : 0,
      provider: geminiKey ? new GeminiProvider(geminiKey, "gemini-3.1-flash-lite") : null,
      baseUrl,
      now: () => new Date(),
      log: (line) => console.log(line),
    },
  };
}

/** One start-up line saying which way the house-buyer switch is. Null, so nothing is said, on a server without the secret. Never the token. */
export function houseStartupNote(house: HouseBuyer | null): string | null {
  if (house === null) return null;
  return house.on
    ? "house buyer on: visitors may skip the PayPal login"
    : "house buyer off: DEMO_DAILY_HOUSE_SESSIONS is 0, or there are no PayPal credentials. Its token is still known here and is not deleted at PayPal.";
}
