import { recordAgentTranscript, runAgent } from "@praman/buyer-agent";
import { runIntent, type RunResult } from "@praman/control-plane";
import { prisma } from "@praman/db";
import type { CaptureRequest, CreateOrderRequest, ExecOutcome, Executor, ExecutorRouter } from "@praman/exec-core";
import type { PurchaseIntent } from "@praman/policy";
import { minor, type Minor, type Rail } from "@praman/shared";
import { toolCallsOf } from "../pages/tool-calls.js";
import { ERRANDS, SHOP, type ErrandId } from "./config.js";
import type { DemoDeps } from "./connect.js";
import type { DemoSession, ErrandRecord } from "./session.js";
import { checkCart, CountedProvider, DailyModelCapReached, ModelCapReached } from "./story.js";

/** One product in the shop's snapshot, as the page shows it. The title is untrusted text. */
export interface ShopItem {
  readonly sku: string;
  readonly title: string;
  readonly category: string;
  readonly priceMinor: Minor;
}

/** The shop's pinned snapshot: what the page shows beside a cart, and when its prices were fixed. */
export interface ShopCatalog {
  readonly items: ReadonlyMap<string, ShopItem>;
  readonly pinnedFrom: Date;
  readonly pinnedTo: Date;
}

/**
 * The shop's Channel3 snapshot, or null when this database has none: no DEMO_SHOP
 * merchant in USD, or no item with a Channel3 source and a pinned price. Null is the
 * off switch. Nothing here calls Channel3; the rows are whatever `pnpm catalog:channel3`
 * last wrote.
 */
export async function loadShopCatalog(db: typeof prisma = prisma): Promise<ShopCatalog | null> {
  const merchant = await db.merchant.findUnique({ where: { merchantId: SHOP } });
  if (merchant === null || merchant.currency !== "USD") return null;
  const rows = await db.catalogItem.findMany({ where: { merchantId: SHOP, source: "channel3", currency: "USD", priceFetchedAt: { not: null } }, orderBy: { sku: "asc" } });
  const items = new Map<string, ShopItem>();
  let from: Date | null = null;
  let to: Date | null = null;
  for (const r of rows) {
    if (r.priceFetchedAt === null) continue;
    items.set(r.sku, { sku: r.sku, title: r.title, category: r.category, priceMinor: minor(r.priceMinor) });
    if (from === null || r.priceFetchedAt < from) from = r.priceFetchedAt;
    if (to === null || r.priceFetchedAt > to) to = r.priceFetchedAt;
  }
  if (from === null || to === null) return null;
  return { items, pinnedFrom: from, pinnedTo: to };
}

/**
 * The snapshot, read at most once a minute, since the /demo page asks on every view
 * whether to link to the shop. A failed read counts as no shop for that minute.
 */
export function shopReader(log: (line: string) => void, ttlMs = 60_000, load: () => Promise<ShopCatalog | null> = () => loadShopCatalog()): (now: Date) => Promise<ShopCatalog | null> {
  let cached: { readonly at: number; readonly value: ShopCatalog | null } | null = null;
  return async (now) => {
    if (cached !== null && now.getTime() - cached.at < ttlMs) return cached.value;
    let value: ShopCatalog | null;
    try {
      value = await load();
    } catch (err) {
      log(`demo: the shop's catalog could not be read: ${err instanceof Error ? err.name : "unknown error"}`);
      value = null;
    }
    cached = { at: now.getTime(), value };
    return value;
  };
}

const NOT_SENT = "NOT_SENT_DECIDE_ONLY";

/**
 * The shop's only executor, on every rail: it sends nothing anywhere. The shop stops at
 * Praman's decision (D-93), and under the shop's mandate an in-scope cart is always a
 * first-merchant step-up that nobody here approves, so this is never asked to pay. If it
 * ever were, it answers that the order failed, so the ledger says no money moved, and
 * no PayPal call is made. It is here so that the gate in front of a step-up finds an
 * executor for the merchant's rail, as it would for a real purchase.
 */
export class DecideOnlyExecutor implements Executor {
  constructor(readonly rail: Rail) {}

  #failed(orderId: string, amount: Minor, currency: CreateOrderRequest["currency"]): ExecOutcome {
    return { rail: this.rail, order_id: orderId, status: "failed", amount_minor: amount, currency, payment_id: null, approve_url: null, failure_code: NOT_SENT };
  }

  createOrder(req: CreateOrderRequest): Promise<ExecOutcome> {
    return Promise.resolve(this.#failed(`not_sent_${req.receipt}`, req.amount_minor, req.currency));
  }

  findOrder(): Promise<ExecOutcome | null> {
    return Promise.resolve(null);
  }

  capture(req: CaptureRequest): Promise<ExecOutcome> {
    return Promise.resolve(this.#failed(req.order_id, req.amount_minor, req.currency));
  }
}

export const decideOnlyRoute: ExecutorRouter = (rail) => new DecideOnlyExecutor(rail);

const empty = { traceId: null, reasonCode: null, agentView: null, lineItems: [], toolCalls: [] } satisfies Omit<ErrandRecord, "state" | "message">;

/** Whether an errand can be asked again: only when nothing went on the ledger for it. */
export function canRunErrandAgain(record: ErrandRecord): boolean {
  return record.state === "no_proposal" || record.state === "not_sent";
}

function decidedMessage(result: RunResult): string {
  if (result.kind === "IN_FLIGHT") return "Praman has no answer recorded for this yet. Nothing was sent to PayPal.";
  switch (result.agent_visible.kind) {
    case "DENY":
      return "Praman refused it. Nothing was bought.";
    case "STEP_UP":
      return "Praman would ask a person to approve this before any money moved. The shop stops here: decided, not bought. Nothing was sent to PayPal.";
    case "ALLOW":
      return "Praman allowed it. The shop stops here: decided, not bought. Nothing was sent to PayPal.";
  }
}

/**
 * Runs one errand for this session: the errand's fixed goal goes to the live model, the
 * cart it proposes goes to Praman under the session's shop mandate, and the decision
 * lands on the ledger. Nothing is ever paid (D-93). The goal and the merchant are the
 * server's; the request names only which errand. The price is the catalog's, and Praman
 * decides (invariant 1).
 */
export async function runErrand(session: DemoSession, id: ErrandId, deps: DemoDeps): Promise<void> {
  const existing = session.errands.get(id);
  if (existing !== undefined && !canRunErrandAgain(existing)) {
    session.notice = "That errand has already run. Its result is below.";
    return;
  }
  if (deps.provider === null) {
    session.notice = "This server has no model configured, so the agent can't run here.";
    return;
  }
  session.errands.set(id, await errand(session, id, deps, deps.provider));
}

async function errand(session: DemoSession, id: ErrandId, deps: DemoDeps, model: NonNullable<DemoDeps["provider"]>): Promise<ErrandRecord> {
  const provider = new CountedProvider(model, session, deps);
  let agent: Awaited<ReturnType<typeof runAgent>>;
  try {
    agent = await runAgent(provider, ERRANDS[id].goal, SHOP);
  } catch (err) {
    deps.log(`demo: the model failed on shop errand ${id}: ${err instanceof Error ? err.name : "unknown error"}`);
    const message =
      err instanceof DailyModelCapReached
        ? "Today's model calls for this demo are used up, so the agent can't shop until tomorrow (UTC). Nothing was proposed and nothing went on the ledger."
        : err instanceof ModelCapReached
          ? "This session has used its share of model calls. Nothing was proposed and nothing went on the ledger."
          : "The model didn't answer. Nothing was proposed and nothing went on the ledger. Try the errand again in a moment.";
    return { ...empty, state: "no_proposal", message };
  }
  const toolCalls = toolCallsOf([{ eventType: "agent_transcript", payload: { transcript: agent.transcript } }]);
  if (agent.kind !== "PROPOSED") {
    return { ...empty, toolCalls, state: "no_proposal", message: "The agent didn't propose a purchase this time. Nothing went on the ledger. Try the errand again." };
  }

  const checked = checkCart(agent.cart, SHOP);
  if (!checked.ok) return { ...empty, toolCalls, state: "not_sent", message: checked.message };

  session.intents += 1;
  const intent: PurchaseIntent = {
    intent_id: `demo_${session.ref}_shop_${id}_${session.intents.toString(36)}`,
    mandate_id: session.shopMandate.document.mandate_id,
    merchant_id: SHOP,
    line_items: checked.lineItems,
    requested_at: deps.now().toISOString(),
    agent_rationale: agent.cart.rationale,
  };
  // Recorded first, so a throw below leaves an errand that is shown, never asked again.
  const pending: ErrandRecord = {
    ...empty,
    state: "pending",
    traceId: `trc_${intent.intent_id}`,
    lineItems: checked.lineItems,
    toolCalls,
    message: "Praman lost track of this errand before it could show the result. The ledger trace shows what was recorded. Nothing was sent to PayPal.",
  };
  session.errands.set(id, pending);
  let result: RunResult;
  try {
    result = await runIntent(intent, session.shopMandate, deps.publicKeyPem, decideOnlyRoute, deps.now(), agent.modelId);
  } catch (err) {
    deps.log(`demo: shop errand ${id} failed inside runIntent: ${err instanceof Error ? err.name : "unknown error"}`);
    return pending;
  }
  const record: ErrandRecord = {
    ...pending,
    state: result.kind === "IN_FLIGHT" ? "pending" : "decided",
    traceId: result.trace_id,
    reasonCode: result.kind === "DECIDED" ? result.internal_reason_code : null,
    agentView: result.kind === "DECIDED" ? result.agent_visible : null,
    message: decidedMessage(result),
  };
  session.errands.set(id, record);
  try {
    await recordAgentTranscript(result.trace_id, agent.transcript, agent.langfuseTraceId, agent.promptProvenance);
  } catch (err) {
    deps.log(`demo: shop errand ${id} was decided but its agent transcript was not saved: ${err instanceof Error ? err.name : "unknown error"}`);
  }
  return record;
}
