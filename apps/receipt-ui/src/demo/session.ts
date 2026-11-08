import { randomBytes } from "node:crypto";
import { signMandate, type MandateDocumentV2, type SignedMandate } from "@praman/mandate";
import type { AgentVisibleDecision } from "@praman/policy";
import { CAFE, DEMO_CURRENCY, HARNESS, HARNESS_LIMITS, MAIN_LIMITS, MARKET, SESSION_TTL_MS, type BeatId } from "./config.js";

/** The demo's own signing key. Never the local MANDATE_PRIVATE_KEY (design, "Agent's calls"). */
export interface DemoSigner {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly keyId: string;
}

/** What one step of the story did, as the page shows it. Ids only, never a secret. */
export interface BeatRecord {
  readonly state: "awaiting_approval" | "awaiting_checkout" | "done" | "refused" | "failed" | "pending" | "no_proposal";
  readonly traceId: string | null;
  /** Praman's reason code, or null when the story stopped before a decision. */
  readonly reasonCode: string | null;
  /** What the agent was told: the redacted decision, never mandate limits (D-08). */
  readonly agentView: AgentVisibleDecision | null;
  readonly amountMinor: string | null;
  readonly orderId: string | null;
  readonly paymentId: string | null;
  readonly orderStatus: string | null;
  /** The rail's own code on a failure (D-32). */
  readonly failureCode: string | null;
  /** The cart the model proposed, and its rationale. Model text: shown escaped, never trusted. */
  readonly proposal: { readonly merchantId: string; readonly lineItems: readonly { readonly sku: string; readonly qty: number }[]; readonly rationale: string } | null;
  /** How the order was paid: with no buyer present, at PayPal's checkout, or on the simulated rail. */
  readonly payment: "saved_method" | "checkout" | "simulated" | null;
  /** Plain words for the visitor. Fixed text chosen by the server, plus codes and amounts. */
  readonly message: string;
  /** The PayPal checkout link, while one is waiting for the buyer. */
  readonly approveUrl: string | null;
  /** Server-side only: the step-up waiting on this visitor. Never sent to the page. */
  readonly approvalId: string | null;
  /** For the concurrency step: what twenty intents at once came to. */
  readonly harness: HarnessSummary | null;
  /** Set when the cart came from a recorded model answer, because the demo's daily model calls were used up. */
  readonly recordedModel: { readonly model: string; readonly recordedAt: string } | null;
  /** The visitor's last refund request for this step, if any. The ledger trace is the record; this is for the page. */
  readonly refund: RefundNote | null;
}

/** What became of the visitor's refund request, in the page's words. Fixed text chosen by the server. */
export interface RefundNote {
  readonly state: "refunded" | "pending" | "open" | "failed" | "mismatch";
  readonly message: string;
}

export interface HarnessSummary {
  readonly priorTraceId: string;
  readonly attempted: number;
  readonly created: number;
  /** Everything the harness mandate spent: the first purchase plus the ones paid at once. */
  readonly createdMinor: string;
  /** The first purchase alone, made before the twenty so they aren't all first-merchant step-ups. */
  readonly priorMinor: string;
  /** The ones paid out of the twenty sent at once. createdMinor is priorMinor plus this. */
  readonly atOnceMinor: string;
  readonly budgetMinor: string;
  readonly refusals: Readonly<Record<string, number>>;
  readonly traces: readonly { readonly traceId: string; readonly outcome: string }[];
  readonly modelCalls: 0;
}

export interface DemoSession {
  /** The cookie value. A secret: whoever has it is this visitor. Never rendered or logged. */
  readonly id: string;
  /** A public reference, used in intent and trace ids. Says nothing about the cookie. */
  readonly ref: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly mandate: SignedMandate;
  readonly harnessMandate: SignedMandate;
  /** The PayPal setup token this visitor was sent to approve, if any. Not a secret: it charges nothing. */
  setupTokenId: string | null;
  /** True once a payment token is stored server-side for this session. The token itself is never here. */
  connected: boolean;
  modelCalls: number;
  /**
   * Purchase intents this session has made. Each ask of a step takes the next number, so
   * every intent, and its trace, has an id of its own, even when a recorded answer used
   * no model call and the step was already in the list.
   */
  intents: number;
  /** A step is running for this session; a second click waits its turn by being refused. */
  busy: boolean;
  /** One message for the next page view. */
  notice: string | null;
  readonly beats: Map<BeatId, BeatRecord>;
}

function mandateDoc(mandateId: string, merchants: string[], limits: typeof MAIN_LIMITS | typeof HARNESS_LIMITS, now: Date, expiresAt: Date): MandateDocumentV2 {
  return {
    mandate_id: mandateId,
    version: 2,
    issuer_id: "usr_demo_visitor",
    subject_id: "agt_demo_buyer",
    scope: { merchant_ids: merchants, categories: ["food", "beverage"], currency: DEMO_CURRENCY },
    limits: {
      max_per_txn_minor: limits.max_per_txn_minor,
      max_total_minor: limits.max_total_minor,
      max_txns_per_window: limits.max_txns_per_window,
      window_seconds: limits.window_seconds,
      max_denials_per_window: limits.max_denials_per_window,
    },
    step_up: { threshold_minor: limits.threshold_minor },
    // A minute's grace before now, for clocks that disagree slightly.
    validity: { not_before: new Date(now.getTime() - 60_000).toISOString(), not_after: expiresAt.toISOString() },
    nonce: randomBytes(8).toString("hex"),
  };
}

/**
 * A new visitor: a session, a USD mandate for the story signed with the demo key, and
 * a second one for the concurrency harness, so that step can't spend the story's budget.
 */
export function createDemoSession(now: Date, signer: DemoSigner): DemoSession {
  const ref = randomBytes(6).toString("hex");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  return {
    id: randomBytes(32).toString("base64url"),
    ref,
    createdAt: now,
    expiresAt,
    mandate: signMandate(mandateDoc(`mnd_demo_${ref}`, [CAFE, MARKET], MAIN_LIMITS, now, expiresAt), signer.privateKeyPem, signer.keyId),
    harnessMandate: signMandate(mandateDoc(`mnd_demo_${ref}_h`, [HARNESS], HARNESS_LIMITS, now, expiresAt), signer.privateKeyPem, signer.keyId),
    setupTokenId: null,
    connected: false,
    modelCalls: 0,
    intents: 0,
    busy: false,
    notice: null,
    beats: new Map(),
  };
}

/** In memory, by design: a session is an hour of one visitor's clicks, and the ledger is the record. */
export class SessionStore {
  readonly #sessions = new Map<string, DemoSession>();

  constructor(private readonly signer: DemoSigner) {}

  create(now: Date): DemoSession {
    const session = createDemoSession(now, this.signer);
    this.#sessions.set(session.id, session);
    return session;
  }

  /** The visitor's session, or null for an unknown or expired cookie. */
  get(id: string | null, now: Date): DemoSession | null {
    if (id === null) return null;
    const session = this.#sessions.get(id);
    if (session === undefined || now.getTime() >= session.expiresAt.getTime()) return null;
    return session;
  }

  /** Removes a session and returns it, so its saved PayPal method can be given up. */
  end(id: string): DemoSession | null {
    const session = this.#sessions.get(id) ?? null;
    this.#sessions.delete(id);
    return session;
  }

  /** Removes every expired session and returns them. */
  purgeExpired(now: Date): DemoSession[] {
    const expired = [...this.#sessions.values()].filter((s) => now.getTime() >= s.expiresAt.getTime());
    for (const s of expired) this.#sessions.delete(s.id);
    return expired;
  }

  /** Removes every session and returns them. For shutdown. */
  endAll(): DemoSession[] {
    const all = [...this.#sessions.values()];
    this.#sessions.clear();
    return all;
  }

  get size(): number {
    return this.#sessions.size;
  }
}

/**
 * Payment tokens, kept apart from the session so nothing that renders or serialises a
 * session can reach one. Keyed by session id, released with the session. A payment
 * token is a secret (D-50): it is never logged, never on the ledger, never sent to a
 * page or the model, and only read by the executor that charges it.
 */
export class SavedMethods {
  readonly #tokens = new Map<string, { readonly tokenId: string; readonly expiresAt: number }>();

  put(sessionId: string, tokenId: string, expiresAt: Date): void {
    this.#tokens.set(sessionId, { tokenId, expiresAt: expiresAt.getTime() });
  }

  /** The token for this session, or null if it has none or it has expired. */
  get(sessionId: string, now: Date): string | null {
    const entry = this.#tokens.get(sessionId);
    if (entry === undefined || now.getTime() >= entry.expiresAt) return null;
    return entry.tokenId;
  }

  /** Removes the session's token and returns it, so it can be deleted at PayPal. */
  take(sessionId: string): string | null {
    const entry = this.#tokens.get(sessionId);
    this.#tokens.delete(sessionId);
    return entry?.tokenId ?? null;
  }

  /** Removes every token and returns them, so each can be deleted at PayPal. For shutdown. */
  takeAll(): string[] {
    const all = [...this.#tokens.values()].map((e) => e.tokenId);
    this.#tokens.clear();
    return all;
  }

  has(sessionId: string): boolean {
    return this.#tokens.has(sessionId);
  }

  toJSON(): string {
    return "[saved payment methods]";
  }
}
