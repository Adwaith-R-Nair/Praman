import { createHash } from "node:crypto";
import type { ModelProvider } from "@praman/agent-core";
import { routeByRail, SimulatedExecutor, type Executor, type ExecutorRouter } from "@praman/exec-core";
import { SavedMethodExecutor, type SavedMethodCharger, type SavedMethodChoice, type SetupToken, type VaultResult } from "@praman/paypal-exec";
import { minorFromJSON, ZERO_MINOR } from "@praman/shared";
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

const derive = (label: string, value: string): string => createHash("sha256").update(`${label}|${value}`, "utf8").digest("hex");

/**
 * Which orders a saved PayPal method pays for, with no buyer present (D-50): an amount
 * below the signed mandate's approval threshold, when this session has a saved method.
 * At or above it, the buyer approves at PayPal's checkout too. Both inputs are the
 * server's: the amount T1 authorised from the catalog, and the mandate it signed.
 */
export function savedMethodChoice(session: DemoSession, savedMethods: SavedMethods, now: () => Date): SavedMethodChoice {
  const doc = session.mandate.document;
  const threshold = doc.version === 2 ? minorFromJSON(doc.step_up.threshold_minor) : ZERO_MINOR;
  return (req) => (req.amount_minor < threshold ? savedMethods.get(session.id, now()) : null);
}

/** This session's rails. Built per request, so the saved method it can reach is only ever its own. */
export function routeFor(session: DemoSession, deps: DemoDeps): ExecutorRouter {
  const executors: Executor[] = [new SimulatedExecutor()];
  if (deps.paypal !== null) executors.push(new SavedMethodExecutor(deps.paypal.executor, savedMethodChoice(session, deps.savedMethods, deps.now)));
  return routeByRail(executors);
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
  session.connected = true;
  session.notice = "PayPal connected. Praman holds the saved method on the server. The agent and this page never see it.";
}

async function deletePaymentToken(tokenId: string, deps: DemoDeps): Promise<void> {
  if (deps.paypal === null) return;
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
  if (tokenId === null) return;
  await deletePaymentToken(tokenId, deps);
}
