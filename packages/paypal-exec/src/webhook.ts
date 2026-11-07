/**
 * PayPal webhooks: checking a delivery came from PayPal, then reading the few fields
 * Praman acts on.
 *
 * Verification asks PayPal, through POST /v1/notifications/verify-webhook-signature,
 * and sends the delivery's own bytes as webhook_event, spliced into the request rather
 * than parsed and written out again. A re-serialised copy can differ from what PayPal
 * signed (spacing, key order, number formatting), and PayPal's webhook guide says not
 * to re-serialise for that reason. Nothing is read from the body until PayPal says
 * SUCCESS, except one syntax check: the body must be a single JSON object, or splicing
 * it could add keys of its own, such as a second webhook_id.
 *
 * No real sandbox delivery has been verified this way yet, because nothing has been
 * hosted for PayPal to send to. The tests use synthetic events (test/fixtures).
 */
import type { SettlementEvent } from "@praman/exec-core";
import { isCurrency, type Minor } from "@praman/shared";
import { isRecord, PAYPAL_AUTH_FAILED, PAYPAL_NOT_AUTHORIZED, PAYPAL_UNAUTHORIZED, PayPalClient, PayPalUnknownOutcome, type PayPalConfig } from "./client.js";
import { requireSandbox } from "./executor.js";
import { fromPayPalValue } from "./money.js";

/** Node's IncomingHttpHeaders fits this: lower-case names, and a repeated header as an array. */
export type WebhookHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface PayPalWebhookDeps {
  readonly client: PayPalClient;
}

/** A client for verification, held for the life of the server so its token is reused. Sandbox only, like the executor. */
export function webhookClient(config: PayPalConfig): PayPalClient {
  requireSandbox(config.baseUrl);
  return new PayPalClient(config);
}

/** PayPal's own schema for webhook_id: ^[a-zA-Z0-9]+$, at most 50. */
const WEBHOOK_ID = /^[A-Za-z0-9]{1,50}$/;
/** Printable ASCII with no spaces. Header values are JSON-encoded when sent, so this is a sanity bound, not an escape. */
const printable = (max: number): RegExp => new RegExp(`^[\\x21-\\x7e]{1,${String(max)}}$`);

/** Each header PayPal signs with, its verify request field, and the shape PayPal's schema allows. */
const SIGNED_HEADERS = [
  { header: "paypal-auth-algo", field: "auth_algo", shape: /^[A-Za-z0-9]{1,100}$/ },
  { header: "paypal-cert-url", field: "cert_url", shape: printable(500) },
  { header: "paypal-transmission-id", field: "transmission_id", shape: printable(50) },
  { header: "paypal-transmission-sig", field: "transmission_sig", shape: printable(500) },
  { header: "paypal-transmission-time", field: "transmission_time", shape: printable(100) },
] as const;

function header(headers: WebhookHeaders, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return typeof value === "string" ? value : null;
  }
  return null;
}

/** PayPal hosts the signing certificate. Its verifier checks the URL too; this only refuses obvious nonsense early. */
function isPayPalCertUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".paypal.com");
  } catch {
    return false;
  }
}

/** The body as text, only if it is valid UTF-8 holding exactly one JSON object. */
function oneJsonObject(rawBody: Buffer): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    return null;
  }
  try {
    return isRecord(JSON.parse(text)) ? text : null;
  } catch {
    return null;
  }
}

/** Codes that mean this app can't call PayPal at all. That is a setup problem to retry after, not a forged delivery. */
const CANNOT_ASK: readonly string[] = [PAYPAL_AUTH_FAILED, PAYPAL_UNAUTHORIZED, PAYPAL_NOT_AUTHORIZED];

/**
 * True only when PayPal answers SUCCESS for these exact bytes and headers. False when
 * the delivery is missing what a PayPal delivery has, or PayPal answers FAILURE or
 * refuses the request. Throws PayPalUnknownOutcome when PayPal couldn't be asked, so
 * the caller can answer with a status that makes PayPal deliver again.
 */
export async function verifyPayPalWebhook(rawBody: Buffer, headers: WebhookHeaders, webhookId: string, deps: PayPalWebhookDeps): Promise<boolean> {
  if (!WEBHOOK_ID.test(webhookId)) throw new Error("PAYPAL_WEBHOOK_ID is not a PayPal webhook id");

  const fields: string[] = [];
  for (const { header: name, field, shape } of SIGNED_HEADERS) {
    const value = header(headers, name);
    if (value === null || !shape.test(value)) return false;
    if (field === "cert_url" && !isPayPalCertUrl(value)) return false;
    fields.push(`${JSON.stringify(field)}:${JSON.stringify(value)}`);
  }
  const event = oneJsonObject(rawBody);
  if (event === null) return false;

  const jsonText = `{${fields.join(",")},"webhook_id":${JSON.stringify(webhookId)},"webhook_event":${event}}`;
  const res = await deps.client.call("POST", "/v1/notifications/verify-webhook-signature", { jsonText });
  if (res.kind === "refused") {
    if (CANNOT_ASK.includes(res.code)) throw new PayPalUnknownOutcome(`webhook verification: PayPal refused this app, ${res.code}`);
    return false;
  }
  const status = res.body["verification_status"];
  if (status === "SUCCESS") return true;
  if (status === "FAILURE") return false;
  throw new PayPalUnknownOutcome("webhook verification: PayPal's answer has no usable verification_status");
}

export type ParsedWebhook =
  | { readonly kind: "settlement"; readonly event: SettlementEvent }
  /** A verified event Praman doesn't act on. The reason is Praman's own fixed text. */
  | { readonly kind: "ignored"; readonly reason: string };

/** The capture events acted on, and the capture status each must carry. */
const ACTED_ON: Readonly<Record<string, { readonly captureStatus: string; readonly status: SettlementEvent["status"] }>> = {
  "PAYMENT.CAPTURE.COMPLETED": { captureStatus: "COMPLETED", status: "captured" },
  "PAYMENT.CAPTURE.DECLINED": { captureStatus: "DECLINED", status: "declined" },
};

/** Event ids look like WH-58D329510W468432D-8HN650336L201105X. */
const EVENT_ID = /^[A-Za-z0-9-]{1,64}$/;
const CAPTURE_ID = /^[A-Za-z0-9]{1,64}$/;
/** PayPal's schema for related_ids.order_id. */
const ORDER_ID = /^[A-Z0-9]{1,20}$/;
/** Praman's receipts are 40 hex characters. Anything else is kept as unknown, never as text. */
const INVOICE_ID = /^[A-Za-z0-9_-]{1,127}$/;

const ignored = (reason: string): ParsedWebhook => ({ kind: "ignored", reason });

function matching(value: unknown, shape: RegExp): string | null {
  return typeof value === "string" && shape.test(value) ? value : null;
}

/**
 * Reads a verified delivery. Only call this after verifyPayPalWebhook returned true.
 *
 * Keeps ids that match narrow patterns, the amount through fromPayPalValue, and a
 * currency Praman knows. The summary, custom_id, notes and links are never read, so
 * PayPal's free text can't reach the ledger, a page or a prompt. Anything unexpected
 * is ignored rather than guessed at. The sweep still settles what a webhook misses.
 */
export function parsePayPalWebhook(rawBody: Buffer): ParsedWebhook {
  const text = oneJsonObject(rawBody);
  if (text === null) return ignored("body is not a JSON object");
  const body: unknown = JSON.parse(text);
  if (!isRecord(body)) return ignored("body is not a JSON object");

  const eventType = body["event_type"];
  const acted = typeof eventType === "string" ? ACTED_ON[eventType] : undefined;
  if (typeof eventType !== "string" || acted === undefined) return ignored("event type not acted on");

  const eventId = matching(body["id"], EVENT_ID);
  if (eventId === null) return ignored("event id is missing or malformed");
  const resource = body["resource"];
  if (!isRecord(resource)) return ignored("event has no resource");
  if (resource["status"] !== acted.captureStatus) return ignored("capture status does not match the event type");

  const paymentId = matching(resource["id"], CAPTURE_ID);
  if (paymentId === null) return ignored("capture id is missing or malformed");
  const supplementary = resource["supplementary_data"];
  const related = isRecord(supplementary) ? supplementary["related_ids"] : undefined;
  const orderId = isRecord(related) ? matching(related["order_id"], ORDER_ID) : null;
  if (orderId === null) return ignored("order id is missing or malformed");

  const amount = resource["amount"];
  if (!isRecord(amount)) return ignored("capture has no amount");
  const currency = amount["currency_code"];
  if (!isCurrency(currency)) return ignored("capture currency is not one Praman supports");
  let amountMinor: Minor;
  try {
    amountMinor = fromPayPalValue(amount["value"]);
  } catch {
    return ignored("capture amount is malformed");
  }

  return {
    kind: "settlement",
    event: {
      rail: "paypal",
      event_id: eventId,
      event_type: eventType,
      status: acted.status,
      order_id: orderId,
      payment_id: paymentId,
      amount_minor: amountMinor,
      currency,
      invoice_id: matching(resource["invoice_id"], INVOICE_ID),
    },
  };
}
