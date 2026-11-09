import type { ExecOutcome } from "@praman/exec-core";
import type { SavedMethodCharger } from "@praman/paypal-exec";
import { escapeHtml } from "../html.js";
import type { PurchaseBeat } from "./config.js";
import { utcDay } from "./limits.js";
import type { DemoSession } from "./session.js";

/**
 * The demo's own sandbox buyer (D-85): one PayPal sandbox account whose owner, the
 * builder, approved saving it once. A visitor who would rather not log in to PayPal can
 * have their session's small purchases charged to it, under their own signed mandate.
 *
 * It is a second source of the saved payment method the PayPal executor is already
 * given, and nothing else. Praman prices and decides every purchase exactly as before,
 * and a purchase at or above the mandate's approval threshold still goes to PayPal's
 * checkout, where a buyer has to be present.
 *
 * Its payment token is a secret like any other (D-50), and it is shared: it comes from
 * the server's environment and outlives every session. So it is held in this object and
 * nowhere else, it is never deleted at PayPal, and nothing here prints it.
 */
export class HouseBuyer {
  readonly #tokenId: string;
  /** Refusals from PayPal in a row. Each one doubles the rest. */
  #refusals = 0;
  #restUntil = 0;
  /** The UTC day whose sessions are known to be used up. */
  #fullDay: string | null = null;

  constructor(tokenId: string) {
    this.#tokenId = tokenId;
  }

  /** False while PayPal's last answer about this buyer was a refusal and its rest isn't over. */
  usable(now: Date): boolean {
    return now.getTime() >= this.#restUntil;
  }

  /** Whether a new session may be shown the choice: usable, and today's sessions not known to be used up. */
  offered(now: Date): boolean {
    return this.usable(now) && this.#fullDay !== utcDay(now);
  }

  /**
   * The token, for a session that chose this buyer, while the session lasts and PayPal
   * hasn't refused it. Read only by the choice the PayPal executor is given.
   */
  tokenFor(session: DemoSession, now: Date): string | null {
    return session.houseBuyer && this.usable(now) && now.getTime() < session.expiresAt.getTime() ? this.#tokenId : null;
  }

  /** Whether this is the house buyer's token. Asked before any token is deleted at PayPal. */
  holds(tokenId: string): boolean {
    return tokenId === this.#tokenId;
  }

  /** PayPal refused a charge to it. Nobody is offered it, or charged to it, until the rest is over. */
  refused(now: Date): void {
    const rest = Math.min(HOUSE_REST_MS * 2 ** Math.min(this.#refusals, 10), HOUSE_REST_MAX_MS);
    this.#refusals += 1;
    this.#restUntil = now.getTime() + rest;
  }

  /** PayPal captured a charge to it. */
  charged(): void {
    this.#refusals = 0;
  }

  /** Today's sessions are used up. The choice isn't shown again until the next UTC day. */
  capReached(now: Date): void {
    this.#fullDay = utcDay(now);
  }

  toJSON(): string {
    return "[house buyer]";
  }

  toString(): string {
    return "[house buyer]";
  }
}

/** How long the house buyer rests after PayPal refuses it once. Twice as long after each refusal in a row. */
export const HOUSE_REST_MS = 30 * 60 * 1000;
const HOUSE_REST_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * The PayPal rail, watched for what PayPal says about charges to the house buyer. It
 * changes nothing about a call or its answer: every request and outcome passes through
 * as it is. A refusal is an answer of "failed". No answer at all is not one, and the
 * record stays pending for the reconcile sweep, as with any other charge.
 */
export function watchHouseCharges(inner: SavedMethodCharger, house: HouseBuyer, onOutcome: (outcome: ExecOutcome) => void): SavedMethodCharger {
  const refund = inner.refund;
  return {
    rail: inner.rail,
    createOrder: (req) => inner.createOrder(req),
    findOrder: (lookup) => inner.findOrder(lookup),
    capture: (req) => inner.capture(req),
    ...(refund === undefined ? {} : { refund: (req) => refund.call(inner, req) }),
    chargeSavedMethod: async (req, vaultId) => {
      const outcome = await inner.chargeSavedMethod(req, vaultId);
      if (house.holds(vaultId)) onOutcome(outcome);
      return outcome;
    },
  };
}

/** Takes a session off the house buyer. It can still connect an account by logging in to PayPal. */
export function leaveHouseBuyer(session: DemoSession, notice: string): void {
  session.houseBuyer = false;
  session.connected = false;
  session.notice = notice;
}

export const HOUSE_PATH = "/demo/connect/house";

export const HOUSE_COPY = {
  button: "Use the demo's sandbox buyer",
  why: "Skips the PayPal login: purchases below your mandate's approval line are charged to a PayPal sandbox account this demo keeps for visitors, with sandbox money only.",
  connected:
    "Connected to the demo's sandbox buyer, a PayPal sandbox account this demo keeps for visitors. Praman holds its saved method on the server. The agent and this page never see it. It stays saved at PayPal when your session ends.",
  ending: "The demo's sandbox buyer stays saved at PayPal for other visitors.",
  paid: "Paid from the demo's sandbox buyer account, with no buyer present. PayPal captured it as it created the order.",
  chosen: "You're using the demo's sandbox buyer. Praman holds its saved PayPal method on the server. The agent and this page never see it.",
  unavailable: "The demo's sandbox buyer isn't available right now. Connect a PayPal sandbox account by logging in instead.",
  usedUp: "Today's sessions on the demo's sandbox buyer are used up. Connect a PayPal sandbox account by logging in instead.",
  gone: "The demo's sandbox buyer isn't available right now. Nothing was asked and nothing was charged. Connect a PayPal sandbox account by logging in, in step 2, then press the button again.",
  refused: (code: string | null) =>
    `PayPal refused the demo's sandbox buyer${code === null ? "" : ` (${code})`}. Nothing was charged. That step won't run again in this session. To go on, start a new session and connect a PayPal sandbox account by logging in.`,
} as const;

/**
 * The choice as the connect step shows it: one button and one sentence. Empty when this
 * server has no house buyer, or isn't offering it now, so the page then says nothing of it.
 */
export function houseChoiceHtml(offered: boolean): string {
  if (!offered) return "";
  return `<form method="post" action="${HOUSE_PATH}" class="act"><button type="submit" class="btn btn-quiet">${escapeHtml(HOUSE_COPY.button)}</button></form><p>${escapeHtml(HOUSE_COPY.why)}</p>`;
}

/** A step the house buyer paid for says whose account paid, in place of "your saved PayPal account". */
export function houseWording(session: DemoSession, beat: PurchaseBeat): void {
  const record = session.beats.get(beat);
  if (!session.houseBuyer || record === undefined || record.state !== "done" || record.payment !== "saved_method") return;
  session.beats.set(beat, { ...record, message: HOUSE_COPY.paid });
}
