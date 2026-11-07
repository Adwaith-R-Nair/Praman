import { applySettlement, type SettlementResult } from "@praman/control-plane";
import type { SettlementEvent } from "@praman/exec-core";
import { parsePayPalWebhook, PAYPAL_SANDBOX_BASE_URL, verifyPayPalWebhook, webhookClient, type WebhookHeaders } from "@praman/paypal-exec";

/** PayPal events are a few kilobytes. Anything far larger isn't one, and isn't read into memory. */
export const MAX_WEBHOOK_BYTES = 64 * 1024;

export interface PayPalWebhookDeps {
  /** Null when PayPal webhooks aren't configured here, which is answered with 503. */
  readonly webhookId: string | null;
  readonly verify: (rawBody: Buffer, headers: WebhookHeaders, webhookId: string) => Promise<boolean>;
  readonly apply: (event: SettlementEvent, now: Date) => Promise<SettlementResult>;
  readonly now: () => Date;
}

export interface WebhookReply {
  readonly status: number;
  /** Fixed text. Never an error message, and never anything from the delivery. */
  readonly body: string;
}

/**
 * POST /webhooks/paypal. The order matters:
 *
 *   1. verify the raw bytes with PayPal. Nothing is parsed or written before this.
 *   2. read the few fields Praman acts on.
 *   3. record them under the mandate lock.
 *
 * Any non-2xx makes PayPal deliver again later. So a delivery that could not be
 * checked or recorded gets 503 or 500, and one that is forged gets 400 and is never
 * retried into success. A verified event that changes nothing gets 200, so PayPal
 * stops sending it.
 */
export async function handlePayPalWebhook(rawBody: Buffer, headers: WebhookHeaders, deps: PayPalWebhookDeps): Promise<WebhookReply> {
  if (deps.webhookId === null) return { status: 503, body: "PayPal webhooks are not configured" };

  let verified: boolean;
  try {
    verified = await deps.verify(rawBody, headers, deps.webhookId);
  } catch (err) {
    console.error(`paypal webhook: could not verify, PayPal will retry: ${err instanceof Error ? err.name : "unknown error"}`);
    return { status: 503, body: "could not verify the signature right now" };
  }
  if (!verified) {
    console.warn("paypal webhook: rejected a delivery whose signature did not verify; nothing was recorded");
    return { status: 400, body: "signature not verified" };
  }

  const parsed = parsePayPalWebhook(rawBody);
  if (parsed.kind === "ignored") {
    console.warn(`paypal webhook: verified, not acted on: ${parsed.reason}`);
    return { status: 200, body: "ignored" };
  }

  try {
    return { status: 200, body: await deps.apply(parsed.event, deps.now()) };
  } catch (err) {
    console.error(`paypal webhook: could not record event ${parsed.event.event_id}, PayPal will retry: ${String(err)}`);
    return { status: 500, body: "could not record the event" };
  }
}

/** The request body exactly as sent, or null once it passes the limit. */
export async function readRawBody(req: AsyncIterable<unknown>, limit = MAX_WEBHOOK_BYTES): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.isBuffer(chunk) ? chunk : null;
    if (bytes === null) return null;
    size += bytes.length;
    if (size > limit) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/**
 * The live wiring, from .env. Webhooks are on only when the app's client id and
 * secret and the webhook id are all set. Sandbox only, as everywhere else.
 */
export function payPalWebhookDepsFromEnv(env: NodeJS.ProcessEnv): PayPalWebhookDeps {
  const webhookId = env["PAYPAL_WEBHOOK_ID"];
  const clientId = env["PAYPAL_CLIENT_ID"];
  const clientSecret = env["PAYPAL_CLIENT_SECRET"];
  const configured = Boolean(webhookId && clientId && clientSecret);
  const client = configured ? webhookClient({ clientId: clientId ?? "", clientSecret: clientSecret ?? "", baseUrl: PAYPAL_SANDBOX_BASE_URL, fetch: globalThis.fetch }) : null;
  return {
    webhookId: configured ? (webhookId ?? null) : null,
    verify: async (rawBody, headers, id) => {
      if (client === null) throw new Error("PayPal webhooks are not configured");
      return verifyPayPalWebhook(rawBody, headers, id, { client });
    },
    apply: applySettlement,
    now: () => new Date(),
  };
}
