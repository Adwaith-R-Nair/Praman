/**
 * PayPal's vault: a buyer approves saving their PayPal account once, and the merchant
 * can then charge it with no buyer present (D-49). Three calls, each sorted the same
 * way as every other PayPal answer (client.ts):
 *
 *   setup token     the merchant asks; the buyer approves it on PayPal's page
 *   payment token   made from an approved setup token; this is what a charge names
 *   delete          the merchant gives the payment token up
 *
 * A payment token is a secret. Anyone holding it, with this app's credentials, can
 * charge the buyer. This module returns it to its caller and nowhere else: it is never
 * logged, and nothing here puts it in an error message.
 */
import { isRecord, PayPalClient, PayPalUnknownOutcome, type PayPalConfig } from "./client.js";
import { requireSandbox } from "./executor.js";

export type VaultResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };

export interface SetupToken {
  readonly id: string;
  /** PayPal's page where the buyer approves saving their account. */
  readonly approveUrl: string;
}

/** PayPal's token ids are short and plain. Anything else isn't one, and isn't kept. */
const TOKEN_ID = /^[A-Za-z0-9-]{1,64}$/;

function readTokenId(body: Record<string, unknown>, what: string): string {
  const id = body["id"];
  if (typeof id !== "string" || !TOKEN_ID.test(id)) throw new PayPalUnknownOutcome(`PayPal: ${what} answer has no usable id`);
  return id;
}

/** The buyer is sent here, so only a PayPal page over https passes, as with a checkout link. */
function approveLink(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  const link: unknown = links.find((l: unknown) => isRecord(l) && l["rel"] === "approve");
  if (!isRecord(link) || typeof link["href"] !== "string") return null;
  try {
    const url = new URL(link["href"]);
    return url.protocol === "https:" && url.hostname.endsWith(".paypal.com") ? url.href : null;
  } catch {
    return null;
  }
}

export class PayPalVault {
  readonly #client: PayPalClient;

  constructor(config: PayPalConfig) {
    requireSandbox(config.baseUrl);
    this.#client = new PayPalClient(config);
  }

  /**
   * Asks PayPal for a page where the buyer approves saving their account for this
   * merchant. The request id is the caller's, derived, so asking twice for one session
   * gets the same setup token back.
   */
  async createSetupToken(req: { readonly requestId: string; readonly returnUrl: string; readonly cancelUrl: string; readonly brandName: string }): Promise<VaultResult<SetupToken>> {
    const res = await this.#client.call("POST", "/v3/vault/setup-tokens", {
      requestId: req.requestId,
      body: {
        payment_source: {
          paypal: {
            usage_type: "MERCHANT",
            experience_context: { return_url: req.returnUrl, cancel_url: req.cancelUrl, brand_name: req.brandName, shipping_preference: "NO_SHIPPING" },
          },
        },
      },
    });
    if (res.kind === "refused") return { ok: false, code: res.code };
    const id = readTokenId(res.body, "setup token");
    const approveUrl = approveLink(res.body["links"]);
    if (approveUrl === null) throw new PayPalUnknownOutcome("PayPal: setup token answer has no usable approve link");
    return { ok: true, value: { id, approveUrl } };
  }

  /** Turns a setup token the buyer approved into a payment token. Refused while the buyer hasn't approved. */
  async createPaymentToken(setupTokenId: string, requestId: string): Promise<VaultResult<{ readonly id: string }>> {
    const res = await this.#client.call("POST", "/v3/vault/payment-tokens", {
      requestId,
      body: { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
    });
    if (res.kind === "refused") return { ok: false, code: res.code };
    return { ok: true, value: { id: readTokenId(res.body, "payment token") } };
  }

  /** Gives a payment token up at PayPal, so it can't be charged again by anyone. */
  async deletePaymentToken(paymentTokenId: string): Promise<VaultResult<null>> {
    if (!TOKEN_ID.test(paymentTokenId)) return { ok: false, code: "PAYMENT_TOKEN_INVALID" };
    const res = await this.#client.call("DELETE", `/v3/vault/payment-tokens/${encodeURIComponent(paymentTokenId)}`);
    return res.kind === "refused" ? { ok: false, code: res.code } : { ok: true, value: null };
  }
}
