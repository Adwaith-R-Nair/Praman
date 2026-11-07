/**
 * The HTTP conversation with PayPal: tokens, headers, and sorting every answer
 * into one of three things.
 *
 *   ok       PayPal did it, or had already done it. The body says what.
 *   refused  PayPal named why it won't, or couldn't have run the call at all.
 *   throw    Nobody knows. PayPalUnknownOutcome, and the caller's record stays pending.
 *
 * Only PayPal's codes are kept, never its free text, and they have to look like
 * codes. They end up in the ledger and in logs. Nothing here prints a credential
 * or a token.
 */

export interface PayPalConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
  /** Milliseconds. For tests of token expiry. */
  readonly now?: () => number;
}

export type PayPalResponse =
  | { readonly kind: "ok"; readonly body: Record<string, unknown> }
  | { readonly kind: "refused"; readonly status: number; readonly code: string; readonly issues: readonly string[] };

/** The Executor contract's throw: this call may or may not have happened at PayPal. */
export class PayPalUnknownOutcome extends Error {
  override readonly name = "PayPalUnknownOutcome";
}

export const PAYPAL_AUTH_FAILED = "PAYPAL_AUTH_FAILED";
export const PAYPAL_UNAUTHORIZED = "PAYPAL_UNAUTHORIZED";
export const PAYPAL_NOT_AUTHORIZED = "PAYPAL_NOT_AUTHORIZED";

const FAILURE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  [PAYPAL_AUTH_FAILED]: "PayPal refused the app's client id and secret when asked for a token. Check that they are this sandbox app's.",
  [PAYPAL_UNAUTHORIZED]: "PayPal refused the bearer token twice, once on a token fetched just for the repeat.",
  [PAYPAL_NOT_AUTHORIZED]:
    "PayPal says this app may not make this call. Likely the app's feature is switched off in the developer dashboard, or PayPal is still handing out a cached token with the scopes it had before the feature was enabled. Enable the feature, then terminate the old token.",
};

/** A sentence for a human about a failure code this client produces, or null for one of PayPal's own. */
export function describePayPalFailure(code: string): string | null {
  return FAILURE_DESCRIPTIONS[code] ?? null;
}

/** Without this, a hung connection would hold up T2 with no outcome. A timeout rejects, which is an unknown outcome. */
export const PAYPAL_REQUEST_TIMEOUT_MS = 30_000;
/** Don't start a call on a token about to run out. */
const TOKEN_MARGIN_MS = 60_000;
/** These statuses mean a refusal, but only count once PayPal has named the reason: anything could send a bare 4xx. */
const REFUSING_STATUSES: readonly number[] = [400, 403, 404, 422];
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The codes in a PayPal error body, most specific first: each details[].issue, then name. */
function namedCodes(body: unknown): string[] {
  if (!isRecord(body)) return [];
  const details = Array.isArray(body["details"]) ? body["details"] : [];
  const issues = details.map((d: unknown) => (isRecord(d) ? d["issue"] : undefined));
  return [...issues, body["name"]].filter((c): c is string => typeof c === "string" && CODE.test(c));
}

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

type TokenResult = { readonly kind: "token"; readonly value: string } | Extract<PayPalResponse, { kind: "refused" }>;

export class PayPalClient {
  readonly #config: PayPalConfig;
  #token: CachedToken | null = null;
  #tokenFetch: Promise<TokenResult> | null = null;

  constructor(config: PayPalConfig) {
    this.#config = config;
  }

  #now(): number {
    return this.#config.now ? this.#config.now() : Date.now();
  }

  /**
   * A rejected fetch is a network error or a timeout, and so is a body that stops
   * arriving. Either way, the call may have landed.
   */
  async #send(what: string, url: string, init: RequestInit): Promise<{ readonly status: number; readonly text: string }> {
    const send = this.#config.fetch;
    try {
      const res = await send(url, { ...init, signal: AbortSignal.timeout(PAYPAL_REQUEST_TIMEOUT_MS) });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      throw new PayPalUnknownOutcome(`${what}: no answer from PayPal (${err instanceof Error ? err.name : "unknown error"})`);
    }
  }

  async #fetchToken(): Promise<TokenResult> {
    const { clientId, clientSecret, baseUrl } = this.#config;
    const res = await this.#send("token", `${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { kind: "refused", status: res.status, code: PAYPAL_AUTH_FAILED, issues: [PAYPAL_AUTH_FAILED] };
    }
    const body = parseJson(res.text);
    if (res.status !== 200 || !isRecord(body)) throw new PayPalUnknownOutcome(`token: PayPal answered ${res.status} with no usable body`);
    const value = body["access_token"];
    const expiresIn = body["expires_in"];
    if (typeof value !== "string" || value === "" || typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
      throw new PayPalUnknownOutcome("token: PayPal's answer has no usable token or expiry");
    }
    this.#token = { value, expiresAt: this.#now() + expiresIn * 1000 };
    return { kind: "token", value };
  }

  /** Cached in memory until close to expiry. Simultaneous callers share one fetch. */
  async #getToken(): Promise<TokenResult> {
    if (this.#token !== null && this.#now() < this.#token.expiresAt - TOKEN_MARGIN_MS) {
      return { kind: "token", value: this.#token.value };
    }
    this.#tokenFetch ??= this.#fetchToken().finally(() => {
      this.#tokenFetch = null;
    });
    return this.#tokenFetch;
  }

  /** Only if it's still the one in use: another call may have replaced it already. */
  #dropToken(value: string): void {
    if (this.#token?.value === value) this.#token = null;
  }

  async #attempt(method: string, path: string, requestId: string | undefined, jsonBody: string | undefined, token: string): Promise<{ readonly status: number; readonly text: string }> {
    return this.#send(`${method} ${path}`, `${this.#config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // PayPal's default answer is only id, status and links. Without the amount
        // there would be nothing to compare, and D-26's silent reuse would go unseen.
        Prefer: "return=representation",
        ...(requestId === undefined ? {} : { "PayPal-Request-Id": requestId }),
      },
      ...(jsonBody === undefined ? {} : { body: jsonBody }),
    });
  }

  /**
   * One PayPal API call. A 401 gets one new token and one repeat. PayPal didn't
   * run a call it refused to authenticate, and the repeat carries the same key.
   */
  async call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: { readonly requestId?: string; readonly body?: unknown; readonly jsonText?: string } = {},
  ): Promise<PayPalResponse> {
    // jsonText is a body already written as JSON, sent as it is. Webhook verification
    // needs it, so the event PayPal checks is the exact bytes it signed.
    const jsonBody = options.jsonText ?? (options.body === undefined ? undefined : JSON.stringify(options.body));

    const first = await this.#getToken();
    if (first.kind === "refused") return first;
    let token = first.value;
    let res = await this.#attempt(method, path, options.requestId, jsonBody, token);

    if (res.status === 401) {
      this.#dropToken(token);
      const second = await this.#getToken();
      if (second.kind === "refused") return second;
      token = second.value;
      res = await this.#attempt(method, path, options.requestId, jsonBody, token);
      if (res.status === 401) {
        this.#dropToken(token);
        return { kind: "refused", status: 401, code: PAYPAL_UNAUTHORIZED, issues: [PAYPAL_UNAUTHORIZED] };
      }
    }

    // A DELETE that worked answers 204 with no body at all.
    if (method === "DELETE" && res.status === 204) return { kind: "ok", body: {} };
    const body = parseJson(res.text);
    const succeeded = res.status === 200 || (method === "POST" && res.status === 201);
    if (succeeded) {
      if (!isRecord(body)) throw new PayPalUnknownOutcome(`${method} ${path}: PayPal answered ${res.status} with no usable body`);
      return { kind: "ok", body };
    }

    const issues = namedCodes(body);
    const code = issues[0];
    if (!REFUSING_STATUSES.includes(res.status) || code === undefined) {
      throw new PayPalUnknownOutcome(`${method} ${path}: PayPal answered ${res.status}`);
    }
    if (res.status === 403 && issues.includes("NOT_AUTHORIZED")) {
      // Asking again next time can only help. The stale-scope token seen in the sandbox
      // only went away once terminated, which is the builder's step in the dashboard or API.
      this.#dropToken(token);
      return { kind: "refused", status: 403, code: PAYPAL_NOT_AUTHORIZED, issues };
    }
    return { kind: "refused", status: res.status, code, issues };
  }
}
