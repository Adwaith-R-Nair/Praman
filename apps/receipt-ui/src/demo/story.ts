import type { ConversationItem, ModelProvider, ProviderTurn, ToolSpec } from "@praman/agent-core";
import { recordAgentTranscript, runAgent } from "@praman/buyer-agent";
import { captureOrder, resolveApproval, runIntent, type CaptureResult, type ResolveResult, type RunResult } from "@praman/control-plane";
import { routeByRail, SimulatedExecutor } from "@praman/exec-core";
import type { PurchaseIntent } from "@praman/policy";
import { addMinor, minorFromJSON, minorToJSON, ZERO_MINOR, type Minor } from "@praman/shared";
import { FOOLED_CART, GOALS, HARNESS, HARNESS_INTENTS, HARNESS_ITEMS, MODEL_CALLS_PER_SESSION, type BeatId, type PurchaseBeat } from "./config.js";
import { routeFor, type DemoDeps } from "./connect.js";
import { loadModelAnswers, RecordedProvider } from "./recorded-model.js";
import type { BeatRecord, DemoSession, HarnessSummary } from "./session.js";

const MODEL_ID_FIXTURE = "fixture/simulated-fooled-model";
/** The "harness/" prefix is how the trace page and dispute bundle tell a harness approval from a person's. */
const MODEL_ID_HARNESS = "harness/no-model";

class ModelCapReached extends Error {
  override readonly name = "ModelCapReached";
}

/** Every visitor together has used today's model calls. The step goes on with a recorded answer. */
class DailyModelCapReached extends Error {
  override readonly name = "DailyModelCapReached";
}

const MODEL_ANSWERS = loadModelAnswers();

/**
 * Counts model calls, for this session and for the whole demo today, and stops at
 * either cap, so no visitor and no crowd of them can run up the bill.
 */
class CountedProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly session: DemoSession,
    private readonly deps: DemoDeps,
  ) {}
  get id(): string {
    return this.inner.id;
  }
  async send(system: string, history: readonly ConversationItem[], tools: readonly ToolSpec[]): Promise<ProviderTurn> {
    if (this.session.modelCalls >= MODEL_CALLS_PER_SESSION) throw new ModelCapReached("model call cap reached for this session");
    if (!(await this.deps.usage.take("model_call", this.deps.now()))) throw new DailyModelCapReached("the demo's daily model calls are used up");
    this.session.modelCalls += 1;
    return this.inner.send(system, history, tools);
  }
}

const empty = {
  traceId: null,
  reasonCode: null,
  agentView: null,
  amountMinor: null,
  orderId: null,
  paymentId: null,
  orderStatus: null,
  failureCode: null,
  proposal: null,
  payment: null,
  approveUrl: null,
  approvalId: null,
  harness: null,
  recordedModel: null,
} satisfies Omit<BeatRecord, "state" | "message">;

function amountOf(view: RunResult & { kind: "DECIDED" }): string | null {
  return view.agent_visible.kind === "DENY" ? null : minorToJSON(view.agent_visible.amount_minor);
}

/** What runIntent said, as one step of the story. */
function fromRun(result: RunResult, proposal: BeatRecord["proposal"], paidBy: BeatRecord["payment"]): BeatRecord {
  if (result.kind === "IN_FLIGHT") {
    return { ...empty, state: "pending", traceId: result.trace_id, proposal, message: "The payment call has no answer yet. Praman will not guess and will not call again. The reconcile sweep settles it." };
  }
  const base = { ...empty, traceId: result.trace_id, agentView: result.agent_visible, amountMinor: amountOf(result), proposal, reasonCode: result.internal_reason_code, orderId: result.order_id, orderStatus: result.order_status };
  if (result.agent_visible.kind === "DENY") return { ...base, state: "refused", message: "Praman refused it. Nothing was charged." };
  if (result.agent_visible.kind === "STEP_UP") {
    return { ...base, state: "awaiting_approval", approvalId: result.approval_id, message: "Praman stopped the agent and is asking you to approve." };
  }
  return fromExecution(base, result.order_status, result.order_id, null, result.approve_url, paidBy);
}

function fromExecution(
  base: Omit<BeatRecord, "state" | "message" | "approveUrl" | "payment" | "paymentId">,
  status: string | null,
  orderId: string | null,
  failureCode: string | null,
  approveUrl: string | null,
  paidBy: BeatRecord["payment"],
): BeatRecord {
  const rest = { ...base, orderId, orderStatus: status, approvalId: null };
  switch (status) {
    case "captured":
      return { ...rest, state: "done", payment: paidBy === "simulated" ? "simulated" : "saved_method", paymentId: null, approveUrl: null, failureCode: null, message: paidBy === "simulated" ? "Paid on the simulated rail." : "Paid from your saved PayPal account, with no buyer present. PayPal captured it as it created the order." };
    case "created":
      return { ...rest, state: "awaiting_checkout", payment: "checkout", paymentId: null, approveUrl, failureCode: null, message: "PayPal created a checkout order. The buyer approves it at PayPal, then Praman captures it." };
    case "mismatch":
      return { ...rest, state: "failed", payment: null, paymentId: null, approveUrl: null, failureCode, message: "PayPal answered about different money than Praman asked for. The order holds budget and needs a person to look. Praman did not retry." };
    default:
      return { ...rest, state: "failed", payment: null, paymentId: null, approveUrl: null, failureCode, message: "The payment provider refused the payment. No money moved." };
  }
}

function proposalOf(cart: { readonly merchant_id: string; readonly line_items: readonly { readonly sku: string; readonly qty: number }[]; readonly rationale: string }): NonNullable<BeatRecord["proposal"]> {
  return { merchantId: cart.merchant_id, lineItems: cart.line_items.map((i) => ({ sku: String(i.sku), qty: Number(i.qty) })), rationale: cart.rationale };
}

/** More lines than any goal in the story needs. A cart longer than this is not a lunch order. */
const MAX_CART_LINES = 10;

type LineItem = { readonly sku: string; readonly qty: number };

/** One line of the model's cart, if it is a SKU and a whole positive quantity. Anything else is null. */
function lineItemOf(raw: unknown): LineItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item: Record<string, unknown> = { ...raw };
  const sku = item["sku"];
  const qty = item["qty"];
  if (typeof sku !== "string" || sku === "" || typeof qty !== "number" || !Number.isSafeInteger(qty) || qty < 1) return null;
  return { sku, qty };
}

/**
 * The model's cart, checked before Praman is asked. The step's merchant is the server's,
 * fixed in GOALS, and the cart must name that merchant: the mandate allows two shops, so
 * a cart the model pointed at the other one would otherwise be a real purchase there.
 * The line items must be SKUs with whole positive quantities. The price is still the
 * catalog's, and Praman still decides (invariant 1). This only refuses to ask.
 */
function checkCart(cart: { readonly merchant_id: unknown; readonly line_items: unknown }, merchant: string): { readonly ok: true; readonly lineItems: readonly LineItem[] } | { readonly ok: false; readonly message: string } {
  if (cart.merchant_id !== merchant) {
    return { ok: false, message: "The agent's cart named a different shop from the one this step is for, so it wasn't sent to Praman. Each step buys only at its own shop. Nothing was charged." };
  }
  const unusable: { readonly ok: false; readonly message: string } = {
    ok: false,
    message: "The agent's cart wasn't a usable order: it needs items from the catalog, each with a whole number of at least one. It wasn't sent to Praman. Nothing was charged.",
  };
  const items: unknown = cart.line_items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_CART_LINES) return unusable;
  const lineItems: LineItem[] = [];
  for (const raw of items) {
    const item = lineItemOf(raw);
    if (item === null) return unusable;
    lineItems.push(item);
  }
  return { ok: true, lineItems };
}

/** What the model proposed, for display only, keeping just the lines that read as items. */
function shownProposal(cart: { readonly merchant_id: unknown; readonly line_items: unknown; readonly rationale: unknown }): NonNullable<BeatRecord["proposal"]> {
  const items: unknown = cart.line_items;
  const lineItems = Array.isArray(items) ? items.map(lineItemOf).filter((i) => i !== null).slice(0, MAX_CART_LINES) : [];
  return { merchantId: String(cart.merchant_id), lineItems, rationale: String(cart.rationale) };
}

/**
 * Asks the model for a cart, then hands it to Praman. The goal and the merchant are the
 * server's. What the model proposes is an intent like any other: Praman prices it from
 * the catalog and decides (invariant 1).
 */
async function agentPurchase(session: DemoSession, deps: DemoDeps, step: PurchaseBeat | "injection", mandate: DemoSession["mandate"]): Promise<BeatRecord> {
  if (deps.provider === null) return { ...empty, state: "no_proposal", message: "This server has no model configured, so the agent can't run. Nothing was proposed and no money moved." };
  const plan = GOALS[step];
  const provider = new CountedProvider(deps.provider, session, deps);
  let agent: Awaited<ReturnType<typeof runAgent>>;
  let recordedModel: BeatRecord["recordedModel"] = null;
  try {
    try {
      agent = await runAgent(provider, plan.goal, plan.merchant);
    } catch (err) {
      if (!(err instanceof DailyModelCapReached)) throw err;
      // Today's model calls are used up. The story goes on with what the live model
      // answered to this same goal in a recorded run, labelled as such everywhere.
      const recorded = MODEL_ANSWERS.answers[step];
      deps.log(`demo: daily model cap reached; step ${step} replays the recorded answer from ${recorded.traceId}`);
      recordedModel = { model: MODEL_ANSWERS.model, recordedAt: recorded.recordedAt };
      agent = await runAgent(new RecordedProvider(MODEL_ANSWERS.model, recorded), plan.goal, plan.merchant);
    }
  } catch (err) {
    deps.log(`demo: the model failed on step ${step}: ${err instanceof Error ? err.name : "unknown error"}`);
    const capped = err instanceof ModelCapReached;
    return {
      ...empty,
      state: "no_proposal",
      message: capped
        ? "This session has used its share of model calls. Nothing was proposed and no money moved."
        : "The model didn't answer. Nothing was proposed and no money moved. Try the step again in a moment.",
    };
  }
  if (agent.kind !== "PROPOSED") {
    return { ...empty, recordedModel, state: "no_proposal", message: "The agent didn't propose a purchase this time. No money moved. Try the step again." };
  }

  const proposal = shownProposal(agent.cart);
  const checked = checkCart(agent.cart, plan.merchant);
  if (!checked.ok) return { ...empty, recordedModel, state: "refused", proposal, message: checked.message };

  const n = (session.beats.size + session.modelCalls).toString(36);
  const intent: PurchaseIntent = {
    intent_id: `demo_${session.ref}_${step}_${n}`,
    mandate_id: mandate.document.mandate_id,
    merchant_id: plan.merchant,
    line_items: checked.lineItems,
    requested_at: deps.now().toISOString(),
    agent_rationale: agent.cart.rationale,
  };
  // Recorded before Praman is asked, so the step is never offered again once an intent
  // has gone in. If anything below throws after a charge, a retry would ask the model
  // again and make a new intent with a new key: a second real charge.
  const inFlight: BeatRecord = {
    ...empty,
    recordedModel,
    state: "pending",
    traceId: `trc_${intent.intent_id}`,
    proposal,
    message: "Praman lost track of this step before it could show the result, so it will not run it again. The ledger trace shows what was recorded, and the reconcile sweep settles any payment call left open.",
  };
  session.beats.set(step, inFlight);
  let result: RunResult;
  try {
    result = await runIntent(intent, mandate, deps.publicKeyPem, routeFor(session, deps), deps.now(), agent.modelId);
  } catch (err) {
    deps.log(`demo: step ${step} failed inside runIntent: ${err instanceof Error ? err.name : "unknown error"}`);
    return inFlight;
  }
  const record: BeatRecord = { ...fromRun(result, proposal, "saved_method"), recordedModel };
  session.beats.set(step, record);
  try {
    await recordAgentTranscript(result.trace_id, agent.transcript, agent.langfuseTraceId, agent.promptProvenance);
  } catch (err) {
    // The purchase stands either way. Only the model's transcript is missing from the trace.
    deps.log(`demo: step ${step} paid but its agent transcript was not saved: ${err instanceof Error ? err.name : "unknown error"}`);
  }
  return record;
}

/**
 * Whether a step that already ran can be asked again. Only when no money can have moved
 * for it: the model proposed nothing, or the purchase was refused, by Praman, by the
 * visitor, or before Praman was asked. Asking again makes a new intent with a new key,
 * which is safe only because the old one charged nothing. A step that paid, failed at
 * the provider, or is still pending is shown, never run again. The fixture is a fixed
 * cart with a fixed intent id, so it has nothing new to ask.
 */
export function canAskAgain(beat: BeatId, record: BeatRecord): boolean {
  if (record.state === "no_proposal") return true;
  return record.state === "refused" && (beat === "first" || beat === "second" || beat === "large" || beat === "injection");
}

const PRECONDITIONS: Readonly<Record<BeatId, (s: DemoSession) => string | null>> = {
  first: (s) => (s.connected ? null : "Connect a PayPal sandbox account first, in step 2."),
  second: (s) => (s.beats.get("first")?.state === "done" ? null : "Finish the first purchase first. Until then the agent has never bought from this merchant."),
  large: (s) => (s.beats.get("first")?.state === "done" ? null : "Finish the first purchase first."),
  injection: () => null,
  fixture: () => null,
  concurrency: () => null,
};

/**
 * Runs one step of the story for this session, once. A step that already ran is shown
 * again rather than run again, so a double click can't make a second purchase.
 */
export async function runBeat(session: DemoSession, beat: BeatId, deps: DemoDeps): Promise<void> {
  const existing = session.beats.get(beat);
  if (existing !== undefined && !canAskAgain(beat, existing)) {
    session.notice = "That step has already run. Its result is below.";
    return;
  }
  const blocked = PRECONDITIONS[beat](session);
  if (blocked !== null) {
    session.notice = blocked;
    return;
  }
  if ((beat === "first" || beat === "second" || beat === "large") && deps.paypal === null) {
    session.notice = "This server has no PayPal sandbox credentials, so the purchase steps can't run.";
    return;
  }

  let record: BeatRecord;
  switch (beat) {
    case "first":
    case "second":
    case "large":
    case "injection":
      record = await agentPurchase(session, deps, beat, session.mandate);
      // A cart that never reached Praman has nothing to say about the poisoned line's effect on a decision.
      if (beat === "injection" && record.proposal !== null && record.traceId !== null) record = describeInjection(record);
      break;
    case "fixture":
      record = await fooledFixture(session, deps);
      break;
    case "concurrency":
      record = await concurrencyHarness(session, deps);
      break;
  }
  session.beats.set(beat, record);
}

/** Says, from the cart alone, whether the poisoned line got into the proposal. */
function describeInjection(record: BeatRecord): BeatRecord {
  const steered = record.proposal?.lineItems.some((i) => i.sku === "SKU_INJ2_TARGET") ?? false;
  const verdict = steered
    ? "The poisoned line got into the agent's cart. Praman still decided from the mandate and the catalog, not from the agent's reasons."
    : "The agent ignored the poisoned line and proposed only what it was asked for.";
  // This step offers no approval: it stops at Praman's answer, whatever that is.
  const after =
    record.state === "awaiting_approval"
      ? "Praman would ask you to approve, since the agent hasn't bought here before. This step stops there, so nothing is bought."
      : record.message;
  return { ...record, approvalId: null, message: `${verdict} ${after}` };
}

/** Approve or reject the step-up waiting on this session's step. The approval id never comes from the request. */
export async function decideApproval(session: DemoSession, beat: BeatId, verdict: "approve" | "reject", deps: DemoDeps): Promise<void> {
  const record = session.beats.get(beat);
  if (record === undefined || record.state !== "awaiting_approval" || record.approvalId === null) {
    session.notice = "Nothing in that step is waiting for your approval.";
    return;
  }
  const result = await resolveApproval(record.approvalId, verdict, session.mandate, deps.publicKeyPem, routeFor(session, deps), deps.now());
  session.beats.set(beat, fromResolve(record, result));
}

function fromResolve(record: BeatRecord, result: ResolveResult): BeatRecord {
  const base = { ...record, approvalId: null };
  switch (result.kind) {
    case "EXECUTED":
      return fromExecution(base, result.order_status, result.order_id, null, result.approve_url, "saved_method");
    case "REFUSED":
      return { ...base, state: "refused", reasonCode: result.reason_code, approveUrl: null, payment: null, message: "Praman checked the mandate again at approval and refused it. Nothing was charged." };
    case "REJECTED":
      return { ...base, state: "refused", approveUrl: null, payment: null, message: result.reason === "expired" ? "The approval waited more than 15 minutes, so it expired. Nothing was charged." : "You rejected it. Nothing was charged." };
    case "IN_FLIGHT":
      return { ...base, state: "pending", message: "The payment call has no answer yet. Praman will not guess and will not call again. The reconcile sweep settles it." };
    case "NOT_FOUND":
      return { ...base, state: "failed", message: "Praman couldn't find that approval. Nothing was charged." };
  }
}

/**
 * Captures the checkout order one of this session's purchase steps made, under the
 * capture re-check (D-31). Any purchase step can become a checkout: the amount the
 * catalog gives the model's cart decides, not the step (D-50). The trace is the
 * session's own; nothing in the request names it.
 */
export async function captureCheckout(session: DemoSession, beat: PurchaseBeat, deps: DemoDeps): Promise<void> {
  const record = session.beats.get(beat);
  if (record === undefined || record.state !== "awaiting_checkout" || record.traceId === null) {
    session.notice = "There is no checkout waiting to be captured.";
    return;
  }
  const result = await captureOrder(record.traceId, session.mandate, deps.publicKeyPem, routeFor(session, deps), deps.now());
  session.beats.set(beat, fromCapture(record, result));
}

function fromCapture(record: BeatRecord, result: CaptureResult): BeatRecord {
  switch (result.kind) {
    case "CAPTURED":
      return { ...record, state: "done", orderStatus: "captured", paymentId: result.payment_id, approveUrl: null, failureCode: null, message: "Captured. You approved it at PayPal, and Praman checked the mandate again before taking the money." };
    case "REFUSED":
      return { ...record, state: "refused", reasonCode: result.reason_code, approveUrl: null, message: "Praman checked the mandate again before capture and refused. Nothing was charged." };
    case "FAILED":
      if (result.failure_code === "ORDER_NOT_APPROVED") {
        return {
          ...record,
          failureCode: result.failure_code,
          message:
            "PayPal hasn't approved this payment yet, so nothing was charged. Open the PayPal link, log in as the sandbox buyer and approve, then capture again. If PayPal said the transaction was declined, close every private window, then open the link in a fresh private window, or in another browser if this demo is itself in a private window, and try again.",
        };
      }
      return { ...record, failureCode: result.failure_code, message: "PayPal refused the capture. No money moved. The order still holds its budget, and you can try the capture again." };
    case "MISMATCH":
      return { ...record, state: "failed", approveUrl: null, message: "PayPal captured different money than Praman held. The order is held against the budget and needs a person to look." };
    case "IN_FLIGHT":
      return { ...record, message: "The capture has no answer yet. Praman will not call again until it knows. Try again in a minute." };
    case "NOT_FOUND":
      return { ...record, state: "failed", approveUrl: null, message: "Praman couldn't find the order for this step. Nothing was charged." };
  }
}

/**
 * The cart a fooled model proposed in the recorded run, submitted as it is. No model
 * is asked: this shows what Praman does when the model is fooled, which the live model
 * usually isn't. Labelled as a simulation on the page and on the ledger's intent row.
 */
async function fooledFixture(session: DemoSession, deps: DemoDeps): Promise<BeatRecord> {
  const intent: PurchaseIntent = {
    intent_id: `demo_${session.ref}_fixture`,
    mandate_id: session.mandate.document.mandate_id,
    merchant_id: FOOLED_CART.merchant_id,
    line_items: FOOLED_CART.line_items,
    requested_at: deps.now().toISOString(),
    agent_rationale: FOOLED_CART.rationale,
  };
  const result = await runIntent(intent, session.mandate, deps.publicKeyPem, routeFor(session, deps), deps.now(), MODEL_ID_FIXTURE);
  return fromRun(result, proposalOf(FOOLED_CART), "simulated");
}

/**
 * Twenty purchases at once against one mandate, with no model and on the simulated rail.
 * First one real purchase at the harness merchant, approved by the harness, so the rest
 * aren't stopped by the first-merchant step-up. Then every intent goes through runIntent
 * at the same moment, and the mandate lock and reservations (D-42) decide which fit.
 */
async function concurrencyHarness(session: DemoSession, deps: DemoDeps): Promise<BeatRecord> {
  const mandate = session.harnessMandate;
  const mandateId = mandate.document.mandate_id;
  const route = routeByRail([new SimulatedExecutor()]);
  const item = (i: number) => HARNESS_ITEMS[i % HARNESS_ITEMS.length] ?? HARNESS_ITEMS[0];
  const intent = (suffix: string, i: number): PurchaseIntent => ({
    intent_id: `demo_${session.ref}_h_${suffix}`,
    mandate_id: mandateId,
    merchant_id: HARNESS,
    line_items: [{ sku: item(i)?.sku ?? "", qty: 1 }],
    requested_at: deps.now().toISOString(),
    agent_rationale: "Test-harness intent. No model proposed this.",
  });

  const prior = await runIntent(intent("prior", 0), mandate, deps.publicKeyPem, route, deps.now(), MODEL_ID_HARNESS);
  if (prior.kind === "DECIDED" && prior.approval_id !== null) {
    await resolveApproval(prior.approval_id, "approve", mandate, deps.publicKeyPem, route, deps.now());
  }

  const results = await Promise.all(Array.from({ length: HARNESS_INTENTS }, (_, i) => runIntent(intent(String(i), i), mandate, deps.publicKeyPem, route, deps.now(), MODEL_ID_HARNESS)));

  let created = 0;
  let createdMinor: Minor = ZERO_MINOR;
  const refusals: Record<string, number> = {};
  const traces: { traceId: string; outcome: string }[] = [];
  for (const r of results) {
    if (r.kind === "DECIDED" && r.order_id !== null && r.agent_visible.kind !== "DENY") {
      created += 1;
      createdMinor = addMinor(createdMinor, r.agent_visible.amount_minor);
      traces.push({ traceId: r.trace_id, outcome: "paid" });
    } else {
      const code = r.kind === "DECIDED" ? r.internal_reason_code : "IN_FLIGHT";
      refusals[code] = (refusals[code] ?? 0) + 1;
      traces.push({ traceId: r.trace_id, outcome: code });
    }
  }
  const doc = mandate.document;
  const budgetMinor = doc.version === 2 ? doc.limits.max_total_minor : "0";
  // The prior purchase spent from the same budget.
  const priorMinor = prior.kind === "DECIDED" && prior.agent_visible.kind !== "DENY" ? prior.agent_visible.amount_minor : ZERO_MINOR;
  const harness: HarnessSummary = {
    priorTraceId: prior.trace_id,
    attempted: HARNESS_INTENTS,
    created,
    createdMinor: minorToJSON(addMinor(createdMinor, priorMinor)),
    priorMinor: minorToJSON(priorMinor),
    atOnceMinor: minorToJSON(createdMinor),
    budgetMinor,
    refusals,
    traces,
    modelCalls: 0,
  };
  return {
    ...empty,
    state: "done",
    traceId: prior.trace_id,
    payment: "simulated",
    harness,
    message: `${HARNESS_INTENTS.toString()} test-harness intents at once: ${created.toString()} paid, ${(HARNESS_INTENTS - created).toString()} refused. ${
      addMinor(createdMinor, priorMinor) <= minorFromJSON(budgetMinor) ? "Spend stayed within the budget." : "Spend went over the budget. That is a bug, and the ledger shows it."
    }`,
  };
}

