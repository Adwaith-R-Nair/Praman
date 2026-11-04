import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append } from "../src/append.js";
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
