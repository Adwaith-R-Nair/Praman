import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { deriveState } from "@praman/ledger";
import { routeByRail, type CreateOrderRequest, type ExecOutcome } from "@praman/exec-core";
import { SavedMethodExecutor, type SavedMethodCharger } from "@praman/paypal-exec";
import { minor, type Minor } from "@praman/shared";
import { resolveApproval } from "../src/resolve-approval.js";
import { runIntent } from "../src/run-intent.js";
import { buildUsdMandate, intentFor, outcomesFor, PRICE, resetCheckoutFixtures, seedPriorHistory } from "./support/checkout.js";

// Plan Task 14: a purchase with no buyer present. The rail is a stand-in that answers the
// way the sandbox did on 2026-11-08 (D-49): an order paid from a saved method comes back
// COMPLETED, already captured, and a reused key answers with the first charge.

beforeEach(resetCheckoutFixtures);
afterAll(async () => {
  await prisma.$disconnect();
});

// Approvals are stamped by the database clock, so these run on real time, not T0.
const NOW = new Date();
const VAULT_ID = "VAULT-TOKEN-NEVER-ON-THE-LEDGER";

class VaultRail implements SavedMethodCharger {
  readonly rail = "paypal";
  readonly charges: { req: CreateOrderRequest; vaultId: string }[] = [];
  readonly checkouts: CreateOrderRequest[] = [];
  readonly #byKey = new Map<string, Minor>();
  #n = 0;

  #outcome(id: string, status: ExecOutcome["status"], amount: Minor): ExecOutcome {
    return { rail: "paypal", order_id: id, status, amount_minor: amount, currency: "USD", payment_id: status === "captured" ? `CAP_${id}` : null, approve_url: null, failure_code: null };
  }

  async chargeSavedMethod(req: CreateOrderRequest, vaultId: string): Promise<ExecOutcome> {
    this.charges.push({ req, vaultId });
    // PayPal answers a reused key with the first charge, whatever amount is asked now (D-49).
    const first = this.#byKey.get(req.idempotency_key) ?? req.amount_minor;
    this.#byKey.set(req.idempotency_key, first);
    return this.#outcome(`VAULT${String(++this.#n)}`, "captured", first);
  }
  async createOrder(req: CreateOrderRequest): Promise<ExecOutcome> {
    this.checkouts.push(req);
    return this.#outcome(`CHK${String(++this.#n)}`, "created", req.amount_minor);
  }
  async findOrder(): Promise<ExecOutcome | null> {
    return null;
  }
  async capture(): Promise<ExecOutcome> {
    throw new Error("not used");
  }
}

function setup(mandateId: string, choose: (req: CreateOrderRequest) => string | null = () => VAULT_ID) {
  const rail = new VaultRail();
  const { signed, publicKeyPem } = buildUsdMandate(mandateId);
  return { rail, signed, publicKeyPem, route: routeByRail([new SavedMethodExecutor(rail, choose)]) };
}

const json = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));

describe("a purchase with no buyer present", () => {
  it("charges a saved method with no buyer present only after evaluate returns ALLOW", async () => {
    const { rail, signed, publicKeyPem, route } = setup("mnd_saved_allow");

    // A new merchant: STEP_UP. Nothing is charged until a human approves.
    const stepUp = await runIntent(intentFor("mnd_saved_allow", "int_saved_1"), signed, publicKeyPem, route, NOW, "test-model");
    expect(stepUp.kind === "DECIDED" && stepUp.internal_reason_code).toBe("STEP_UP_FIRST_MERCHANT");
    expect(rail.charges).toHaveLength(0);

    // A refusal never reaches the rail either.
    const denied = await runIntent({ ...intentFor("mnd_saved_allow", "int_saved_x"), line_items: [{ sku: "NO_SUCH_SKU", qty: 1 }] }, signed, publicKeyPem, route, NOW, "test-model");
    expect(denied.kind === "DECIDED" && denied.internal_reason_code).toBe("SKU_UNKNOWN");
    expect(rail.charges).toHaveLength(0);

    // The approval re-checks the mandate (D-24), then the saved method is charged.
    const approvalId = stepUp.kind === "DECIDED" ? stepUp.approval_id : null;
    if (approvalId === null) throw new Error("expected an approval");
    const approved = await resolveApproval(approvalId, "approve", signed, publicKeyPem, route, NOW);
    expect(approved).toMatchObject({ kind: "EXECUTED", order_status: "captured", approve_url: null });
    expect(rail.charges).toHaveLength(1);

    // The merchant is now trusted, so a small purchase is ALLOW and charged at once.
    const allowed = await runIntent(intentFor("mnd_saved_allow", "int_saved_2"), signed, publicKeyPem, route, NOW, "test-model");
    expect(allowed).toMatchObject({ kind: "DECIDED", agent_visible: { kind: "ALLOW" }, order_status: "captured", approve_url: null });
    expect(rail.charges).toHaveLength(2);
    expect(rail.charges.map((c) => c.req.amount_minor)).toEqual([PRICE, PRICE]);
    expect(rail.checkouts).toHaveLength(0);
  });

  it("a saved-method charge is one ledger outcome and is captured on creation", async () => {
    await seedPriorHistory("mnd_saved_one");
    const { rail, signed, publicKeyPem, route } = setup("mnd_saved_one");

    const result = await runIntent(intentFor("mnd_saved_one", "int_saved_one"), signed, publicKeyPem, route, NOW, "test-model");
    expect(result).toMatchObject({ kind: "DECIDED", internal_reason_code: "OK", order_status: "captured" });

    const record = await prisma.idempotencyRecord.findFirstOrThrow({ where: { traceId: result.trace_id } });
    expect(record).toMatchObject({ status: "succeeded", kind: "order", rail: "paypal" });
    const outcomes = await outcomesFor(record.key);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: "captured", order_id: "VAULT1", payment_id: "CAP_VAULT1", amount_minor: PRICE.toString(), currency: "USD" });
    // The derived key reached the rail, and no capture phase was needed.
    expect(rail.charges[0]?.req.idempotency_key).toBe(record.key);
    expect(await prisma.idempotencyRecord.count({ where: { kind: "capture" } })).toBe(0);
    expect(await prisma.ledgerEntry.count({ where: { traceId: result.trace_id, eventType: "capture_decision" } })).toBe(0);

    const state = await prisma.$transaction((tx) => deriveState(tx, "mnd_saved_one"));
    expect(state.spent_minor).toBe(minor(1000n + PRICE));

    // A repeat of the same intent is answered from the record, with no second charge.
    const again = await runIntent(intentFor("mnd_saved_one", "int_saved_one"), signed, publicKeyPem, route, NOW, "test-model");
    expect(again).toMatchObject({ kind: "DECIDED", order_status: "captured" });
    expect(rail.charges).toHaveLength(1);
  });

  it("a charge PayPal answers with other money is a mismatch that holds the authorised amount", async () => {
    await seedPriorHistory("mnd_saved_mm");
    const { rail, signed, publicKeyPem, route } = setup("mnd_saved_mm");
    // As if an earlier call had used this key for $4.00 (D-49's $9.00 row).
    const key = (await import("@praman/exec-core")).idempotencyKey("mnd_saved_mm", intentFor("mnd_saved_mm", "int_saved_mm"));
    await rail.chargeSavedMethod({ amount_minor: minor(400n), currency: "USD", idempotency_key: key, receipt: "r" }, VAULT_ID);

    const result = await runIntent(intentFor("mnd_saved_mm", "int_saved_mm"), signed, publicKeyPem, route, NOW, "test-model");
    expect(result).toMatchObject({ kind: "DECIDED", order_status: "mismatch", approve_url: null });
    const [outcome] = await outcomesFor(key);
    expect(outcome).toMatchObject({ status: "mismatch", amount_minor: PRICE.toString(), rail_amount_minor: "400", failure_code: "RAIL_AMOUNT_MISMATCH" });
    const state = await prisma.$transaction((tx) => deriveState(tx, "mnd_saved_mm"));
    expect(state.spent_minor).toBe(minor(1000n + PRICE));
  });

  it("makes a checkout order when the server chose no saved method", async () => {
    await seedPriorHistory("mnd_saved_none");
    const { rail, signed, publicKeyPem, route } = setup("mnd_saved_none", () => null);
    const result = await runIntent(intentFor("mnd_saved_none", "int_saved_none"), signed, publicKeyPem, route, NOW, "test-model");
    expect(result).toMatchObject({ kind: "DECIDED", order_status: "created" });
    expect(rail.charges).toHaveLength(0);
    expect(rail.checkouts).toHaveLength(1);
  });

  it("never writes the saved method's id to the ledger, the outbox or an approval", async () => {
    const { signed, publicKeyPem, route } = setup("mnd_saved_secret");
    const stepUp = await runIntent(intentFor("mnd_saved_secret", "int_saved_s"), signed, publicKeyPem, route, NOW, "test-model");
    if (stepUp.kind !== "DECIDED" || stepUp.approval_id === null) throw new Error("expected a step-up");
    const executed = await resolveApproval(stepUp.approval_id, "approve", signed, publicKeyPem, route, NOW);

    const everything = json([await prisma.ledgerEntry.findMany(), await prisma.idempotencyRecord.findMany(), await prisma.approval.findMany(), stepUp, executed]);
    expect(everything).toContain("CAP_VAULT1");
    expect(everything).not.toContain(VAULT_ID);
  });
});
