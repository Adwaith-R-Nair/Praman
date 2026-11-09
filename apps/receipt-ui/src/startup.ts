import { createHash, createPublicKey } from "node:crypto";
import { PAYPAL_SANDBOX_BASE_URL } from "@praman/paypal-exec";

/**
 * Public-key fingerprints (sha256 of the SPKI DER) of keys that live in a developer's
 * .env: the local mandate key, and the demo key used for local runs before hosting.
 * The hosted server signs mandates for strangers, so it must never sign with either.
 * A public key is not a secret, so its fingerprint can sit in the repo.
 */
export const DEVELOPER_KEY_FINGERPRINTS: readonly string[] = [
  "bd01981f764c16f5ff3101f14a006a48ce3d89cc5260f2532ff026ac337606b3",
  "25b1c1d11b0ecd8f5ce26c41742e457dc9fb7efdc4b5531eba86610f33f75e86",
];

export type StartupCheck = { readonly ok: true; readonly notes: readonly string[] } | { readonly ok: false; readonly reasons: readonly string[] };

type Fetch = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ readonly status: number }>;

/** The fingerprint of a base64-encoded PEM key's public half, or null if it isn't a key. */
export function keyFingerprint(b64Pem: string): string | null {
  try {
    const key = createPublicKey(Buffer.from(b64Pem, "base64").toString("utf8"));
    return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
  } catch {
    return null;
  }
}

/** Everything that can be checked without the network. Each refusal names the variable and never its value. */
export function checkEnv(env: NodeJS.ProcessEnv): string[] {
  const reasons: string[] = [];
  const production = env["NODE_ENV"] === "production";

  const paypalBase = env["PAYPAL_BASE_URL"];
  if (paypalBase !== undefined && paypalBase !== "" && paypalBase.replace(/\/+$/, "") !== PAYPAL_SANDBOX_BASE_URL) {
    reasons.push(`PAYPAL_BASE_URL is not PayPal's sandbox (${PAYPAL_SANDBOX_BASE_URL}). This server only ever talks to the sandbox.`);
  }
  if (Boolean(env["PAYPAL_CLIENT_ID"]) !== Boolean(env["PAYPAL_CLIENT_SECRET"])) {
    reasons.push("Only one of PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET is set. Set both, or neither.");
  }

  const rzpId = env["RAZORPAY_KEY_ID"];
  if (rzpId !== undefined && rzpId !== "" && !rzpId.startsWith("rzp_test_")) {
    reasons.push("RAZORPAY_KEY_ID is not a test-mode key (it must start with rzp_test_). This server never uses live keys.");
  }
  if (Boolean(rzpId) !== Boolean(env["RAZORPAY_KEY_SECRET"])) {
    reasons.push("Only one of RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET is set. Set both, or neither.");
  }
  const rzpBase = env["RAZORPAY_BASE_URL"];
  if (rzpBase !== undefined && rzpBase !== "") {
    reasons.push("RAZORPAY_BASE_URL is set. This server only calls https://api.razorpay.com with a test-mode key, and takes no other base URL.");
  }

  for (const name of ["DEMO_DAILY_MODEL_CALLS", "DEMO_DAILY_SESSIONS", "DEMO_DAILY_HOUSE_SESSIONS"]) {
    const value = env[name];
    if (value !== undefined && value !== "" && !/^\d{1,7}$/.test(value)) reasons.push(`${name} must be a whole number.`);
  }

  // The demo's shared sandbox buyer (D-85). Its token is a secret: named here, never printed.
  const houseToken = env["DEMO_HOUSE_BUYER_TOKEN"];
  if (houseToken !== undefined && houseToken !== "") {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(houseToken)) {
      reasons.push("DEMO_HOUSE_BUYER_TOKEN is not a PayPal payment token id. Paste the id the consent script saved, with nothing around it.");
    }
    if (!env["PAYPAL_CLIENT_ID"] || !env["PAYPAL_CLIENT_SECRET"]) {
      reasons.push("DEMO_HOUSE_BUYER_TOKEN is set without PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET. Only the sandbox app that saved that buyer can charge it.");
    }
  }

  const proxyHops = env["TRUST_PROXY"];
  if (proxyHops !== undefined && proxyHops !== "" && !/^\d$/.test(proxyHops)) {
    reasons.push("TRUST_PROXY must be the number of proxies in front of this server, 0 to 9 (Render: 3).");
  }

  const demoPrivate = env["DEMO_MANDATE_PRIVATE_KEY"];
  const demoPublic = env["DEMO_MANDATE_PUBLIC_KEY"];
  if (demoPrivate || demoPublic) {
    if (!demoPrivate || !demoPublic) {
      reasons.push("Only one of DEMO_MANDATE_PRIVATE_KEY and DEMO_MANDATE_PUBLIC_KEY is set. Set both, or neither.");
    } else {
      const fromPrivate = keyFingerprint(demoPrivate);
      const fromPublic = keyFingerprint(demoPublic);
      if (fromPrivate === null || fromPublic === null) {
        reasons.push("DEMO_MANDATE_PRIVATE_KEY or DEMO_MANDATE_PUBLIC_KEY is not a base64-encoded PEM key. Make a pair with pnpm keygen.");
      } else if (fromPrivate !== fromPublic) {
        reasons.push("DEMO_MANDATE_PUBLIC_KEY is not the public half of DEMO_MANDATE_PRIVATE_KEY.");
      } else {
        const local = [env["MANDATE_PRIVATE_KEY"], env["MANDATE_PUBLIC_KEY"]].filter((k): k is string => Boolean(k)).map(keyFingerprint);
        if (local.includes(fromPrivate)) {
          reasons.push("The demo key is the local mandate key (MANDATE_PRIVATE_KEY). The demo signs mandates for strangers and needs its own key.");
        } else if (production && DEVELOPER_KEY_FINGERPRINTS.includes(fromPrivate)) {
          reasons.push("The demo key is a developer's local key. A hosted server needs a fresh pair from pnpm keygen that has never been in a .env file.");
        }
      }
    }
  }

  if (production) {
    if (env["MANDATE_PRIVATE_KEY"]) reasons.push("MANDATE_PRIVATE_KEY is set. A hosted server must not hold the local mandate key; unset it.");
    if (!demoPrivate || !demoPublic) reasons.push("DEMO_MANDATE_PRIVATE_KEY and DEMO_MANDATE_PUBLIC_KEY are needed in production. The hosted server exists to run the demo.");
    const base = env["DEMO_BASE_URL"] ?? "";
    if (!base.startsWith("https://")) reasons.push("DEMO_BASE_URL must be the service's https:// address in production, so cookies are Secure and PayPal returns to the right place.");
  }
  return reasons;
}

/**
 * Whether PayPal's sandbox accepts these credentials. Sandbox and live credentials are
 * separate sets, so a client id and secret the sandbox refuses are not sandbox ones.
 * Only a definite refusal stops the server. If the sandbox can't be reached, the server
 * starts anyway, since every PayPal call it makes goes to the sandbox host regardless.
 */
export async function checkPayPalSandbox(env: NodeJS.ProcessEnv, fetchFn: Fetch, timeoutMs = 10_000): Promise<{ readonly refused: string | null; readonly note: string | null }> {
  const clientId = env["PAYPAL_CLIENT_ID"];
  const clientSecret = env["PAYPAL_CLIENT_SECRET"];
  if (!clientId || !clientSecret) return { refused: null, note: null };
  try {
    const res = await fetchFn(`${PAYPAL_SANDBOX_BASE_URL}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 200) return { refused: null, note: null };
    if (res.status === 401 || res.status === 403) {
      return { refused: "PayPal's sandbox refused PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET. They are not sandbox credentials, or they are wrong. This server only uses sandbox credentials.", note: null };
    }
    return { refused: null, note: `PayPal's sandbox answered ${res.status.toString()} to the credential check; starting anyway, sandbox only.` };
  } catch (err) {
    return { refused: null, note: `PayPal's sandbox couldn't be reached for the credential check (${err instanceof Error ? err.name : "unknown error"}); starting anyway, sandbox only.` };
  }
}

/** Every start-up check. The server refuses to start on any reason in the result. */
export async function checkStartup(env: NodeJS.ProcessEnv, fetchFn: Fetch): Promise<StartupCheck> {
  const reasons = checkEnv(env);
  if (reasons.length > 0) return { ok: false, reasons };
  const paypal = await checkPayPalSandbox(env, fetchFn);
  if (paypal.refused !== null) return { ok: false, reasons: [paypal.refused] };
  return { ok: true, notes: paypal.note === null ? [] : [paypal.note] };
}
