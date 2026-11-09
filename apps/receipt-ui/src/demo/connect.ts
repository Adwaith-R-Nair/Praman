import { createHash } from "node:crypto";
import type { ModelProvider } from "@praman/agent-core";
import { routeByRail, SimulatedExecutor, type ExecOutcome, type Executor, type ExecutorRouter } from "@praman/exec-core";
import { SavedMethodExecutor, type SavedMethodCharger, type SavedMethodChoice, type SetupToken, type VaultResult } from "@praman/paypal-exec";
import { minorFromJSON, ZERO_MINOR } from "@praman/shared";
import { HOUSE_COPY, leaveHouseBuyer, watchHouseCharges, type HouseBuyer } from "./house.js";
import type { DailyUsage } from "./limits.js";
import type { DemoSession, SavedMethods, SessionStore } from "./session.js";

/** The parts of PayPal's vault the demo uses. PayPalVault in production, a stand-in in tests. */
export interface VaultApi {
  createSetupToken(req: { readonly requestId: string; readonly returnUrl: string; readonly cancelUrl: string; readonly brandName: string }): Promise<VaultResult<SetupToken>>;
  createPaymentToken(setupTokenId: string, requestId: string): Promise<VaultResult<{ readonly id: string }>>;
  deletePaymentToken(paymentTokenId: string): Promise<VaultResult<null>>;
}

export interface DemoDeps {
  readonly sessions: SessionStore;
  readonly savedMethods: SavedMethods;
  /** The demo key's public half. Every session's mandates verify against it. */
  readonly publicKeyPem: string;
  /** Null when this server has no PayPal sandbox credentials. */
  readonly paypal: { readonly executor: SavedMethodCharger; readonly vault: VaultApi } | null;
  /**
   * The demo's shared sandbox buyer (D-85). Left out or null on a server with no such
   * secret, and then the choice does not exist: no route, no page text, no charge. The
   * same holds when it is here and switched off (`on` false), except that its token is
   * still known, so no path deletes that token at PayPal.
   */
  readonly house?: HouseBuyer | null;
  /** How long one model call may take before the step gives up. Defaults to MODEL_DEADLINE_MS. */
  readonly modelDeadlineMs?: number;
  /** Null when this server has no model configured. */
  readonly provider: ModelProvider | null;
  /** Today's allowance of new sessions and model calls, shared by every visitor. */
  readonly usage: DailyUsage;
  /** Where PayPal sends the visitor back to. Server config, never the request's Host header. */
  readonly baseUrl: string;
  readonly now: () => Date;
  /** Operator log. Never given a token, a cookie or an error's free text from PayPal. */
  readonly log: (line: string) => void;
}

/** The house buyer visitors may use on this server, or null: no secret, switched off, or no PayPal to charge it with. */
export function houseInUse(deps: DemoDeps): HouseBuyer | null {
  const house = deps.house ?? null;
  return house !== null && house.on && deps.paypal !== null ? house : null;
}

const derive = (label: string, value: string): string => createHash("sha256").update(`${label}|${value}`, "utf8").digest("hex");

/**
 * Which orders a saved PayPal method pays for, with no buyer present (D-50): an amount
 * below the signed mandate's approval threshold, when this session has a saved method.
 * At or above it, the buyer approves at PayPal's checkout too. Both inputs are the
 * server's: the amount T1 authorised from the catalog, and the mandate it signed.
 *
 * The saved method is the one this session connected by logging in to PayPal or, for a
 * session that chose it, the demo's shared sandbox buyer (D-85). The threshold is the
 * same for both, so the shared buyer never pays for what a buyer must be present for.
 */
export function savedMethodChoice(session: DemoSession, savedMethods: SavedMethods, now: () => Date, house: HouseBuyer | null = null): SavedMethodChoice {
  const doc = session.mandate.document;
  const threshold = doc.version === 2 ? minorFromJSON(doc.step_up.threshold_minor) : ZERO_MINOR;
  return (req) => (req.amount_minor < threshold ? (savedMethods.get(session.id, now()) ?? house?.tokenFor(session, now()) ?? null) : null);
}

/** This session's rails. Built per request, so the saved method it can reach is only ever its own. */
export function routeFor(session: DemoSession, deps: DemoDeps): ExecutorRouter {
  const executors: Executor[] = [new SimulatedExecutor()];
  if (deps.paypal !== null) {
    const house = houseInUse(deps);
    const charger = house === null ? deps.paypal.executor : watchHouseCharges(deps.paypal.executor, house, (outcome) => houseAnswered(session, house, outcome, deps));
    executors.push(new SavedMethodExecutor(charger, savedMethodChoice(session, deps.savedMethods, deps.now, house)));
  }
  return routeByRail(executors);
}

/**
 * What PayPal said about a charge to the house buyer's token. A refusal moved no money.
 * It rests the house buyer for everyone, and a session that chose the house buyer goes
 * back to the login path. A session that logged in as the same sandbox account holds
 * that token as its own: it stays connected, and its step fails as any login session's would.
 */
function houseAnswered(session: DemoSession, house: HouseBuyer, outcome: ExecOutcome, deps: DemoDeps): void {
  if (outcome.status === "captured") house.charged();
  if (outcome.status !== "failed") return;
  house.refused(deps.now());
  deps.log(`demo: PayPal refused the house buyer: ${outcome.failure_code ?? "no code"}. It is resting, and sessions use the PayPal login meanwhile.`);
  if (session.houseBuyer) leaveHouseBuyer(session, HOUSE_COPY.refused(outcome.failure_code));
}

/**
 * Puts this session on the demo's shared sandbox buyer, in place of a PayPal login. One
 * of the day's house-buyer sessions is used. Nothing is charged here: the session's
 * purchases go through Praman as they would with an account connected by login.
 */
export async function connectHouseBuyer(session: DemoSession, deps: DemoDeps): Promise<void> {
  const house = houseInUse(deps);
  if (house === null) {
    session.notice = "This server has no sandbox buyer of its own. Connect a PayPal sandbox account by logging in.";
    return;
  }
  if (session.beats.get("revoke")?.state === "done") {
    session.notice = "This session's mandate is revoked. Start a new session to connect PayPal.";
    return;
  }
  if (session.connected) {
    session.notice = "PayPal is already connected for this session.";
    return;
  }
  const now = deps.now();
  if (!house.offered(now)) {
    session.notice = HOUSE_COPY.unavailable;
    return;
  }
  if (!(await deps.usage.take("house_session", now))) {
    house.capReached(now);
    session.notice = HOUSE_COPY.usedUp;
    return;
  }
  session.houseBuyer = true;
  session.connected = true;
  session.notice = HOUSE_COPY.chosen;
}

/** Sends this visitor to PayPal to approve saving their sandbox account. Returns where to go. */
export async function startConnect(session: DemoSession, deps: DemoDeps): Promise<string | null> {
  if (deps.paypal === null) {
    session.notice = "This server has no PayPal sandbox credentials, so it can't connect an account.";
    return null;
  }
  if (session.beats.get("revoke")?.state === "done") {
    session.notice = "This session's mandate is revoked. Start a new session to connect PayPal.";
    return null;
  }
  if (session.connected) {
    session.notice = "PayPal is already connected for this session.";
    return null;
  }
  const result = await deps.paypal.vault.createSetupToken({
    requestId: derive("setup", session.ref),
    returnUrl: `${deps.baseUrl}/demo/connect/return`,
    cancelUrl: `${deps.baseUrl}/demo/connect/cancel`,
    brandName: "Praman demo",
  });
  if (!result.ok) {
    deps.log(`demo: PayPal refused a setup token: ${result.code}`);
    session.notice = `PayPal refused to start the connection (${result.code}). Nothing was saved.`;
    return null;
  }
  session.setupTokenId = result.value.id;
  return result.value.approveUrl;
}

/**
 * PayPal sent the visitor back. Praman makes a payment token from the setup token it
 * stored for this session, never from one named in the URL, and keeps it server-side.
 */
export async function finishConnect(session: DemoSession, approvalTokenId: string | null, deps: DemoDeps): Promise<void> {
  if (deps.paypal === null || session.setupTokenId === null) {
    session.notice = "There's no PayPal connection waiting for this session. Start it from step 2.";
    return;
  }
  if (approvalTokenId !== null && approvalTokenId !== session.setupTokenId) {
    session.notice = "That PayPal approval wasn't for this session, so it was ignored.";
    return;
  }
  const setupTokenId = session.setupTokenId;
  const result = await deps.paypal.vault.createPaymentToken(setupTokenId, derive("payment-token", setupTokenId));
  if (!result.ok) {
    deps.log(`demo: PayPal refused a payment token: ${result.code}`);
    session.notice = `PayPal didn't confirm the approval (${result.code}). Nothing was saved. Try connecting again.`;
    return;
  }
  // The visitor may have ended the session while PayPal answered. Nothing holds the
  // token any more, so it is deleted at PayPal now rather than left there for good.
  if (deps.sessions.get(session.id, deps.now()) !== session) {
    await deletePaymentToken(result.value.id, deps);
    return;
  }
  deps.savedMethods.put(session.id, result.value.id, session.expiresAt);
  // The visitor's own account pays from here on, even if the session was on the house buyer.
  session.houseBuyer = false;
  // A login as the house buyer's own sandbox account can be handed the house token. It is
  // held like any login token, and the page is told it won't be deleted when the session ends.
  session.holdsHouseToken = isHouseToken(result.value.id, deps);
  session.connected = true;
  session.notice = "PayPal connected. Praman holds the saved method on the server. The agent and this page never see it.";
}

/**
 * The house buyer's token is shared and long-lived (D-85). No path here or in routes.ts
 * may delete it at PayPal. This asks the house buyer whether it is switched on or off:
 * a server that knows the token guards it either way.
 */
export function isHouseToken(tokenId: string, deps: DemoDeps): boolean {
  return deps.house?.holds(tokenId) === true;
}

async function deletePaymentToken(tokenId: string, deps: DemoDeps): Promise<void> {
  if (deps.paypal === null) return;
  if (isHouseToken(tokenId, deps)) {
    // A login as the house buyer's own sandbox account can be handed the same token.
    deps.log("demo: a session held the house buyer's saved PayPal method; it is kept at PayPal, not deleted");
    return;
  }
  try {
    const result = await deps.paypal.vault.deletePaymentToken(tokenId);
    deps.log(`demo: released a saved PayPal method for an ended session: ${result.ok ? "deleted at PayPal" : result.code}`);
  } catch (err) {
    deps.log(`demo: couldn't delete a saved PayPal method at PayPal: ${err instanceof Error ? err.name : "unknown error"}. It is no longer held here.`);
  }
}

/** Gives up the session's saved PayPal method, at PayPal too. Called when a session ends or expires. */
export async function releaseSession(session: DemoSession, deps: DemoDeps): Promise<void> {
  const tokenId = deps.savedMethods.take(session.id);
  session.connected = false;
  session.houseBuyer = false;
  session.holdsHouseToken = false;
  if (tokenId === null) return;
  await deletePaymentToken(tokenId, deps);
}
