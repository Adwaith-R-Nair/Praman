import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append, type EventType } from "../src/append.js";
import { amountIfPresent, deriveState, readAmount, readCurrency } from "../src/derive.js";

// Runs against TEST_DATABASE_URL (see vitest.config.ts), never the real one.
beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record RESTART IDENTITY`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const MANDATE = "mnd_derive_test";
const OTHER_MANDATE = "mnd_other";

describe("deriveState", () => {
  it("created and captured outcomes move spent_minor; failed does not", async () => {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t1",
        ts: new Date("2026-09-04T10:00:00.000Z"),
        actor: "system",
        eventType: "decision",
        payload: { mandate_id: MANDATE, kind: "ALLOW" },
      }),
    );
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t1",
        ts: new Date("2026-09-04T10:00:01.000Z"),
        actor: "system",
        eventType: "api_call",
        payload: { mandate_id: MANDATE, provider: "razorpay" },
      }),
    );
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t1",
        ts: new Date("2026-09-04T10:00:02.000Z"),
        actor: "system",
        eventType: "outcome",
        payload: {
          mandate_id: MANDATE,
          status: "captured",
          amount_minor: "5000",
          merchant_id: "MERCH_001",
          idempotency_key: "idem_1",
        },
      }),
    );
    // LiveExecutor returns "created" immediately — capture happens later via
    // reconciliation. This must still commit spend and register the
    // merchant, or every purchase at a merchant steps up forever (D-17).
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t3",
        ts: new Date("2026-09-04T10:00:02.500Z"),
        actor: "system",
        eventType: "outcome",
        payload: {
          mandate_id: MANDATE,
          status: "created",
          amount_minor: "1200",
          merchant_id: "MERCH_003",
          idempotency_key: "idem_3",
        },
      }),
    );
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t2",
        ts: new Date("2026-09-04T10:00:03.000Z"),
        actor: "system",
        eventType: "outcome",
        payload: {
          mandate_id: MANDATE,
          status: "failed",
          amount_minor: "9999",
          merchant_id: "MERCH_002",
        },
      }),
    );

    const state = await prisma.$transaction((tx) => deriveState(tx, MANDATE));

    expect(state.spent_minor).toBe(6200n);
    expect(state.txn_timestamps).toHaveLength(2);
    expect([...state.merchants_transacted].sort()).toEqual(["MERCH_001", "MERCH_003"]);
    expect([...state.seen_idempotency_keys].sort()).toEqual(["idem_1", "idem_3"]);
  });

  it("a mandate_revoked entry sets revoked", async () => {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t1",
        ts: new Date("2026-09-04T10:00:00.000Z"),
        actor: "system",
        eventType: "mandate_revoked",
        payload: { mandate_id: MANDATE, reason: "user requested" },
      }),
    );

    const state = await prisma.$transaction((tx) => deriveState(tx, MANDATE));
    expect(state.revoked).toBe(true);
  });

  it("denied_attempts collects DENY decisions, not ALLOW or STEP_UP", async () => {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t1",
        ts: new Date("2026-09-04T10:00:00.000Z"),
        actor: "system",
        eventType: "decision",
        payload: { mandate_id: MANDATE, kind: "ALLOW" },
      }),
    );
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t2",
        ts: new Date("2026-09-04T10:00:01.000Z"),
        actor: "system",
        eventType: "decision",
        payload: { mandate_id: MANDATE, kind: "STEP_UP" },
      }),
    );
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t3",
        ts: new Date("2026-09-04T10:00:02.000Z"),
        actor: "system",
        eventType: "decision",
        payload: { mandate_id: MANDATE, kind: "DENY" },
      }),
    );

    const state = await prisma.$transaction((tx) => deriveState(tx, MANDATE));
    expect(state.denied_attempts).toEqual([new Date("2026-09-04T10:00:02.000Z")]);
  });

  it("denied_attempts excludes MANDATE_SIGNATURE_INVALID — an unverified caller never proved ownership of this mandate", async () => {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t4",
        ts: new Date("2026-09-04T10:00:03.000Z"),
        actor: "system",
        eventType: "decision",
        payload: { mandate_id: MANDATE, kind: "DENY", reason_code: "MANDATE_SIGNATURE_INVALID" },
      }),
    );
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t5",
        ts: new Date("2026-09-04T10:00:04.000Z"),
        actor: "system",
        eventType: "decision",
        payload: { mandate_id: MANDATE, kind: "DENY", reason_code: "MANDATE_EXPIRED" },
      }),
    );

    const state = await prisma.$transaction((tx) => deriveState(tx, MANDATE));
    expect(state.denied_attempts).toEqual([new Date("2026-09-04T10:00:04.000Z")]);
  });

  it("entries for a different mandate do not contribute to this mandate's state", async () => {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t1",
        ts: new Date("2026-09-04T10:00:00.000Z"),
        actor: "system",
        eventType: "outcome",
        payload: {
          mandate_id: OTHER_MANDATE,
          status: "captured",
          amount_minor: "999999",
          merchant_id: "MERCH_003",
        },
      }),
    );

    const state = await prisma.$transaction((tx) => deriveState(tx, MANDATE));
    expect(state.spent_minor).toBe(0n);
    expect(state.merchants_transacted.size).toBe(0);
  });

  it("throws on a captured outcome with a malformed amount_minor", async () => {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t1",
        ts: new Date("2026-09-04T10:00:00.000Z"),
        actor: "system",
        eventType: "outcome",
        payload: { mandate_id: MANDATE, status: "captured", amount_minor: "not-a-number" },
      }),
    );

    await expect(prisma.$transaction((tx) => deriveState(tx, MANDATE))).rejects.toThrow(
      /amount_minor is malformed/,
    );
  });

  async function appendOutcome(traceId: string, fields: Record<string, unknown>): Promise<void> {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId,
        ts: new Date("2026-09-04T10:00:00.000Z"),
        actor: "system",
        eventType: "outcome",
        payload: { mandate_id: MANDATE, status: "captured", ...fields },
      }),
    );
  }

  it("derives spend from old amount_paise and new amount_minor outcomes", async () => {
    await appendOutcome("t_old", { amount_paise: "5000" });
    await appendOutcome("t_new", { amount_minor: "700" });

    const state = await prisma.$transaction((tx) => deriveState(tx, MANDATE));
    expect(state.spent_minor).toBe(5700n);
    expect(state.txn_timestamps).toHaveLength(2);
  });

  it("rejects an outcome with neither amount field", async () => {
    await appendOutcome("t1", {});
    await expect(prisma.$transaction((tx) => deriveState(tx, MANDATE))).rejects.toThrow(
      /ledger seq 1: outcome has no amount/,
    );
  });

  it("rejects an outcome whose two amount fields disagree", async () => {
    await appendOutcome("t1", { amount_paise: "5000", amount_minor: "1" });
    await expect(prisma.$transaction((tx) => deriveState(tx, MANDATE))).rejects.toThrow(/amounts disagree/);
  });

  it("throws on a malformed old amount_paise too", async () => {
    await appendOutcome("t1", { amount_paise: "not-a-number" });
    await expect(prisma.$transaction((tx) => deriveState(tx, MANDATE))).rejects.toThrow(
      /amount_paise is malformed/,
    );
  });
});

describe("deriveState folding outcomes by order", () => {
  const TS = new Date("2026-09-04T10:00:00.000Z");

  /** A field passed as undefined is left out of the row, the way an old row simply doesn't have it. */
  async function outcome(status: string, key: string | null, fields: Record<string, unknown> = {}, ts: Date = TS): Promise<void> {
    const payload = {
      mandate_id: MANDATE,
      status,
      amount_minor: "5000",
      merchant_id: "MERCH_001",
      ...(key === null ? {} : { idempotency_key: key }),
      ...fields,
    };
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t1",
        ts,
        actor: "system",
        eventType: "outcome",
        payload: Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)),
      }),
    );
  }

  const state = () => prisma.$transaction((tx) => deriveState(tx, MANDATE));

  it("counts created then captured with one key once", async () => {
    await outcome("created", "k1");
    await outcome("captured", "k1", {}, new Date("2026-09-04T10:05:00.000Z"));

    const s = await state();
    expect(s.spent_minor).toBe(5000n);
    // The time the budget was first committed, not the time it settled.
    expect(s.txn_timestamps).toEqual([TS]);
    expect([...s.merchants_transacted]).toEqual(["MERCH_001"]);
    expect([...s.seen_idempotency_keys]).toEqual(["k1"]);
    expect(s.released_keys.size).toBe(0);
  });

  it("counts a repeated outcome on one key once, so a reconciler racing T2 can't double spend", async () => {
    await outcome("created", "k1");
    await outcome("created", "k1", { reconciled: true });

    const s = await state();
    expect(s.spent_minor).toBe(5000n);
    expect(s.txn_timestamps).toHaveLength(1);
  });

  it("counts different keys separately", async () => {
    await outcome("created", "k1");
    await outcome("captured", "k2", { amount_minor: "700" });

    const s = await state();
    expect(s.spent_minor).toBe(5700n);
    expect(s.txn_timestamps).toHaveLength(2);
  });

  it("keeps the higher amount if one key's outcomes disagree, so a mismatch never frees budget", async () => {
    await outcome("created", "k1", { amount_minor: "5000" });
    await outcome("captured", "k1", { amount_minor: "6000" });
    await outcome("created", "k2", { amount_minor: "300" });
    await outcome("captured", "k2", { amount_minor: "200" });

    expect((await state()).spent_minor).toBe(6300n);
  });

  it("still refuses a malformed amount on the second outcome of a key", async () => {
    await outcome("created", "k1");
    await outcome("captured", "k1", { amount_minor: "not-a-number" });

    await expect(state()).rejects.toThrow(/amount_minor is malformed/);
  });

  it("old outcomes with no idempotency key still count individually", async () => {
    await outcome("captured", null, { amount_minor: undefined, amount_paise: "5000" });
    await outcome("captured", null, { amount_minor: undefined, amount_paise: "5000" });
    await outcome("created", null, { amount_minor: "700" });

    const s = await state();
    expect(s.spent_minor).toBe(10700n);
    expect(s.txn_timestamps).toHaveLength(3);
    expect(s.seen_idempotency_keys.size).toBe(0);
  });

  it("a mismatch holds budget and velocity and keeps its key seen, but earns the merchant no trust", async () => {
    await outcome("mismatch", "k1", { rail_status: "created", rail_currency: "USD", rail_amount_minor: "5000" });

    const s = await state();
    expect(s.spent_minor).toBe(5000n);
    expect(s.txn_timestamps).toEqual([TS]);
    expect([...s.seen_idempotency_keys]).toEqual(["k1"]);
    expect(s.merchants_transacted.size).toBe(0);
  });

  it("a mismatch counts the higher of the authorised amount and the rail's, in the same currency", async () => {
    await outcome("mismatch", "low", { currency: "INR", rail_currency: "INR", rail_amount_minor: "1" });
    await outcome("mismatch", "high", { currency: "INR", rail_currency: "INR", rail_amount_minor: "9000" });

    expect((await state()).spent_minor).toBe(14000n);
  });

  it("a mismatch ignores the rail's amount in another currency, since the two can't be compared", async () => {
    await outcome("mismatch", "k1", { currency: "INR", rail_currency: "USD", rail_amount_minor: "9000" });

    expect((await state()).spent_minor).toBe(5000n);
  });

  it("refuses a malformed rail amount on a mismatch", async () => {
    await outcome("mismatch", "k1", { currency: "INR", rail_currency: "INR", rail_amount_minor: "12.50" });

    await expect(state()).rejects.toThrow(/malformed/);
  });

  it("a release can't free a mismatch, because what the rail holds is unknown", async () => {
    await outcome("mismatch", "k1", { rail_status: "created", rail_currency: "USD", rail_amount_minor: "5000" });
    await outcome("released", "k1", { amount_minor: undefined });

    const s = await state();
    expect(s.spent_minor).toBe(5000n);
    expect(s.merchants_transacted.size).toBe(0);
  });

  it("released frees budget but keeps the velocity timestamp", async () => {
    await outcome("created", "k1");
    await outcome("released", "k1", {}, new Date("2026-09-04T10:10:00.000Z"));

    const s = await state();
    expect(s.spent_minor).toBe(0n);
    expect(s.txn_timestamps).toEqual([TS]);
    expect([...s.released_keys]).toEqual(["k1"]);
  });

  it("a released order does not count as a merchant transacted", async () => {
    await outcome("created", "k1");
    await outcome("released", "k1");

    expect((await state()).merchants_transacted.size).toBe(0);
  });

  it("a merchant stays transacted through another order that wasn't released", async () => {
    await outcome("created", "k1");
    await outcome("released", "k1");
    await outcome("created", "k2", { amount_minor: "700" });

    const s = await state();
    expect(s.spent_minor).toBe(700n);
    expect([...s.merchants_transacted]).toEqual(["MERCH_001"]);
  });

  it("a released key stays seen, so the same intent can't be run again", async () => {
    await outcome("created", "k1");
    await outcome("released", "k1");

    expect([...(await state()).seen_idempotency_keys]).toEqual(["k1"]);
  });

  it("applies a release whichever order the rows arrive in", async () => {
    await outcome("released", "k1");
    await outcome("created", "k1");

    const s = await state();
    expect(s.spent_minor).toBe(0n);
    expect(s.txn_timestamps).toHaveLength(1);
    expect(s.merchants_transacted.size).toBe(0);
  });

  it.each([
    ["captured then released", ["captured", "released"]],
    ["released then captured", ["released", "captured"]],
  ])("money that moved is never freed: %s", async (_name, statuses) => {
    for (const status of statuses) await outcome(status, "k1");

    const s = await state();
    expect(s.spent_minor).toBe(5000n);
    expect([...s.merchants_transacted]).toEqual(["MERCH_001"]);
    // Still recorded, so evaluateCapture refuses a further capture on it.
    expect([...s.released_keys]).toEqual(["k1"]);
  });

  it("a release with no key frees nothing, because it can't name an order", async () => {
    await outcome("created", "k1");
    await outcome("released", null);

    const s = await state();
    expect(s.spent_minor).toBe(5000n);
    expect(s.released_keys.size).toBe(0);
    expect(s.txn_timestamps).toHaveLength(1);
  });

  it("a release never reads an amount, so one without an amount is fine", async () => {
    await outcome("created", "k1");
    await outcome("released", "k1", { amount_minor: undefined });

    expect((await state()).spent_minor).toBe(0n);
  });

  it("a failed outcome after created leaves the hold in place", async () => {
    await outcome("created", "k1");
    await outcome("failed", "k1");

    const s = await state();
    expect(s.spent_minor).toBe(5000n);
    expect(s.txn_timestamps).toHaveLength(1);
  });

  describe("one key, more than one order id (D-34)", () => {
    const LATER = new Date("2026-09-04T10:05:00.000Z");

    it("counts two real orders on one key separately, because the rail doesn't enforce the receipt", async () => {
      await outcome("created", "k1", { order_id: "order_A" });
      await outcome("created", "k1", { order_id: "order_B", amount_minor: "700" }, LATER);

      const s = await state();
      expect(s.spent_minor).toBe(5700n);
      expect(s.txn_timestamps).toEqual([TS, LATER]);
      expect([...s.seen_idempotency_keys]).toEqual(["k1"]);
    });

    it("counts a reconciler racing T2 once, when both name the same order", async () => {
      await outcome("created", "k1", { order_id: "order_A" });
      await outcome("created", "k1", { order_id: "order_A", reconciled: true }, LATER);

      const s = await state();
      expect(s.spent_minor).toBe(5000n);
      expect(s.txn_timestamps).toEqual([TS]);
    });

    it("counts created then captured on the same order once, and each order only once", async () => {
      await outcome("created", "k1", { order_id: "order_A" });
      await outcome("created", "k1", { order_id: "order_B" });
      await outcome("captured", "k1", { order_id: "order_A" });
      await outcome("captured", "k1", { order_id: "order_B" });

      const s = await state();
      expect(s.spent_minor).toBe(10000n);
      expect(s.txn_timestamps).toHaveLength(2);
    });

    it.each([
      ["no order id first", [{}, { order_id: "order_A" }]],
      ["no order id last", [{ order_id: "order_A" }, {}]],
    ])("a row with no order id belongs to the key's one order: %s", async (_name, rows) => {
      for (const fields of rows) await outcome("created", "k1", fields);

      const s = await state();
      expect(s.spent_minor).toBe(5000n);
      expect(s.txn_timestamps).toHaveLength(1);
    });

    it("a row with no order id on a key with two orders adds no third order", async () => {
      await outcome("created", "k1", { order_id: "order_A" });
      await outcome("created", "k1", { order_id: "order_B" });
      await outcome("created", "k1");

      const s = await state();
      expect(s.spent_minor).toBe(10000n);
      expect(s.txn_timestamps).toHaveLength(2);
    });

    it("a release naming one order frees only that order", async () => {
      await outcome("created", "k1", { order_id: "order_A" });
      await outcome("created", "k1", { order_id: "order_B", amount_minor: "700" });
      await outcome("released", "k1", { order_id: "order_A", amount_minor: undefined });

      const s = await state();
      expect(s.spent_minor).toBe(700n);
      expect(s.txn_timestamps).toHaveLength(2);
      expect([...s.merchants_transacted]).toEqual(["MERCH_001"]);
    });

    it("a release naming no order frees nothing when the key has two, because it can't say which", async () => {
      await outcome("created", "k1", { order_id: "order_A" });
      await outcome("created", "k1", { order_id: "order_B", amount_minor: "700" });
      await outcome("released", "k1", { amount_minor: undefined });

      const s = await state();
      expect(s.spent_minor).toBe(5700n);
      expect(s.txn_timestamps).toHaveLength(2);
      expect([...s.released_keys]).toEqual(["k1"]);
    });

    it("a release naming no order still frees the key's one order", async () => {
      await outcome("created", "k1", { order_id: "order_A" });
      await outcome("released", "k1", { amount_minor: undefined });

      expect((await state()).spent_minor).toBe(0n);
    });

    it("one order's capture doesn't stop the other's release, nor free itself", async () => {
      await outcome("created", "k1", { order_id: "order_A" });
      await outcome("created", "k1", { order_id: "order_B", amount_minor: "700" });
      await outcome("captured", "k1", { order_id: "order_A" });
      await outcome("released", "k1", { order_id: "order_A", amount_minor: undefined });
      await outcome("released", "k1", { order_id: "order_B", amount_minor: undefined });

      expect((await state()).spent_minor).toBe(5000n);
    });

    it("a failed row with another order id is no order at all", async () => {
      await outcome("created", "k1", { order_id: "order_A" });
      await outcome("failed", "k1", { order_id: "order_B" });

      const s = await state();
      expect(s.spent_minor).toBe(5000n);
      expect(s.txn_timestamps).toHaveLength(1);
    });

    it("a mismatch on one order earns no trust, but doesn't take back another's", async () => {
      await outcome("mismatch", "k1", { order_id: "order_A", rail_currency: "USD", rail_amount_minor: "5000" });
      await outcome("created", "k1", { order_id: "order_B", merchant_id: "MERCH_002" });

      const s = await state();
      expect(s.spent_minor).toBe(10000n);
      expect([...s.merchants_transacted]).toEqual(["MERCH_002"]);
    });

    it("rows with no key stay their own order, even with one order id", async () => {
      await outcome("captured", null, { order_id: "order_A" });
      await outcome("captured", null, { order_id: "order_A" });

      expect((await state()).spent_minor).toBe(10000n);
    });
  });

  it("a capture_decision denial is not a denied attempt", async () => {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t1",
        ts: TS,
        actor: "system",
        eventType: "capture_decision",
        payload: { mandate_id: MANDATE, kind: "DENY", reason_code: "ORDER_RELEASED", detail: "released" },
      }),
    );

    const s = await state();
    expect(s.denied_attempts).toEqual([]);
    expect(s.spent_minor).toBe(0n);
  });

  it("a settlement event moves nothing on its own", async () => {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t1",
        ts: TS,
        actor: "system",
        eventType: "settlement",
        payload: { mandate_id: MANDATE, status: "captured", amount_minor: "5000", idempotency_key: "k1" },
      }),
    );

    const s = await state();
    expect(s.spent_minor).toBe(0n);
    expect(s.txn_timestamps).toEqual([]);
  });
});

describe("deriveState reserving attempted calls (Task 8)", () => {
  const TS = new Date("2026-09-04T10:00:00.000Z");
  const LATER = new Date("2026-09-04T10:00:05.000Z");

  async function row(eventType: EventType, traceId: string, payload: Record<string, unknown>, ts: Date = TS): Promise<void> {
    // A field passed as undefined is left out, the way an old row simply doesn't have it.
    const kept = Object.fromEntries(Object.entries({ mandate_id: MANDATE, ...payload }).filter(([, value]) => value !== undefined));
    await prisma.$transaction((tx) => append(tx, { traceId, ts, actor: "praman", eventType, payload: kept }));
  }

  /** An order create T1 recorded, in today's shape. */
  const attempt = (key: string, traceId = "t1", amount = "5000", ts: Date = TS) =>
    row("api_call", traceId, {
      merchant_id: "MERCH_001",
      rail: "simulated",
      operation: "orders.create",
      idempotency_key: key,
      receipt: `rcpt_${key}`,
      amount_minor: amount,
      currency: "INR",
      status: "attempted",
    }, ts);

  const outcome = (status: string, key: string | null, traceId = "t1", fields: Record<string, unknown> = {}, ts: Date = LATER) =>
    row("outcome", traceId, {
      status,
      amount_minor: "5000",
      merchant_id: "MERCH_001",
      ...(key === null ? {} : { idempotency_key: key }),
      ...fields,
    }, ts);

  const state = () => prisma.$transaction((tx) => deriveState(tx, MANDATE));

  it("an attempted call with no outcome reserves budget and velocity", async () => {
    await attempt("k1");

    const s = await state();
    expect(s.spent_minor).toBe(5000n);
    expect(s.txn_timestamps).toEqual([TS]);
  });

  it("an attempted call does not count as a merchant transacted", async () => {
    await attempt("k1");

    expect((await state()).merchants_transacted.size).toBe(0);
  });

  it("a failed outcome releases the reservation", async () => {
    await attempt("k1");
    await outcome("failed", "k1");

    const s = await state();
    expect(s.spent_minor).toBe(0n);
    expect(s.txn_timestamps).toEqual([]);
  });

  it("a reconciled not-found releases the reservation too", async () => {
    await attempt("k1");
    await outcome("failed", "k1", "t1", { order_id: null, reconciled: true });

    expect((await state()).spent_minor).toBe(0n);
  });

  it("an outcome takes over from its reservation, so the order counts once", async () => {
    await attempt("k1");
    await outcome("created", "k1");

    const s = await state();
    expect(s.spent_minor).toBe(5000n);
    // The order's own time from here on, as before reservations existed.
    expect(s.txn_timestamps).toEqual([LATER]);
    expect([...s.merchants_transacted]).toEqual(["MERCH_001"]);
  });

  it("old api_call events with no key pair by trace_id", async () => {
    // The shape T1 wrote before rails: provider, receipt and amount_paise, no key.
    const old = (traceId: string) =>
      row("api_call", traceId, { provider: "razorpay", operation: "orders.create", receipt: `rcpt_${traceId}`, amount_paise: "700", status: "attempted" });
    await old("t_settled");
    await outcome("created", "k_settled", "t_settled", { amount_minor: undefined, amount_paise: "700" });
    await old("t_open");

    const s = await state();
    // 700 for the settled order, and 700 held for the attempt that never got an outcome.
    expect(s.spent_minor).toBe(1400n);
    expect(s.txn_timestamps).toHaveLength(2);
  });

  it("a keyed attempt pairs by key, not by a trace another attempt shares", async () => {
    // A trace comes from the intent id, so two carts under one intent id share it.
    await attempt("k1", "t_shared");
    await attempt("k2", "t_shared", "700");
    await outcome("failed", "k1", "t_shared");

    expect((await state()).spent_minor).toBe(700n);
  });

  it("a capture's attempted call reserves nothing, because its order already holds the budget", async () => {
    await attempt("k1");
    await outcome("created", "k1", "t1", { order_id: "order_A" });
    await row("api_call", "t1", {
      merchant_id: "MERCH_001",
      rail: "paypal",
      operation: "orders.capture",
      idempotency_key: "k1",
      order_id: "order_A",
      capture_key: "cap_k1",
      amount_minor: "5000",
      currency: "USD",
      status: "attempted",
    });

    const s = await state();
    expect(s.spent_minor).toBe(5000n);
    expect(s.txn_timestamps).toHaveLength(1);
  });

  it("refuses an open attempt with a malformed amount, as it does an outcome", async () => {
    await attempt("k1", "t1", "12.50");

    await expect(state()).rejects.toThrow(/malformed/);
  });

  it("an attempt for another mandate reserves nothing here", async () => {
    await prisma.$transaction((tx) =>
      append(tx, { traceId: "t9", ts: TS, actor: "praman", eventType: "api_call", payload: { mandate_id: OTHER_MANDATE, operation: "orders.create", idempotency_key: "k9", amount_minor: "5000", status: "attempted" } }),
    );

    expect((await state()).spent_minor).toBe(0n);
  });
});

describe("readAmount", () => {
  it("reads either shape", () => {
    expect(readAmount({ amount_paise: "5000" }, 1n)).toBe("5000");
    expect(readAmount({ amount_minor: "5000" }, 1n)).toBe("5000");
  });

  it("accepts both fields when they agree", () => {
    expect(readAmount({ amount_paise: "5000", amount_minor: "5000" }, 1n)).toBe("5000");
  });

  it.each([
    ["a number", { amount_minor: 5000 }],
    ["a negative", { amount_minor: "-5000" }],
    ["a decimal", { amount_paise: "50.00" }],
    ["null", { amount_minor: null }],
  ])("rejects %s", (_name, payload) => {
    expect(() => readAmount(payload, 7n)).toThrow(/ledger seq 7: outcome amount_(minor|paise) is malformed/);
  });
});

describe("amountIfPresent", () => {
  it("reads either shape, new first", () => {
    expect(amountIfPresent({ amount_paise: "5000" })).toBe("5000");
    expect(amountIfPresent({ amount_minor: "700" })).toBe("700");
  });

  it("returns null when there is no amount, as on a DENY decision", () => {
    expect(amountIfPresent({ kind: "DENY", reason_code: "SKU_UNKNOWN" })).toBeNull();
  });
});

describe("readCurrency", () => {
  it("reads the currency a new entry recorded", () => {
    expect(readCurrency({ amount_minor: "1250", currency: "USD" })).toBe("USD");
    expect(readCurrency({ amount_minor: "50000", currency: "INR" })).toBe("INR");
  });

  it("treats an entry with no currency as INR, because nothing else existed then", () => {
    expect(readCurrency({ amount_paise: "50000" })).toBe("INR");
    expect(readCurrency({ amount_minor: "50000" })).toBe("INR");
  });

  it("refuses a currency it doesn't know rather than showing it as money", () => {
    expect(() => readCurrency({ amount_minor: "50000", currency: "JPY" })).toThrow(TypeError);
  });
});
