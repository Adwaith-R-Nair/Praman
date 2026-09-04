import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append } from "../src/append.js";
import { deriveState } from "../src/derive.js";

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
  it("created and captured outcomes move spent_paise; failed does not", async () => {
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
          amount_paise: "5000",
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
          amount_paise: "1200",
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
          amount_paise: "9999",
          merchant_id: "MERCH_002",
        },
      }),
    );

    const state = await prisma.$transaction((tx) => deriveState(tx, MANDATE));

    expect(state.spent_paise).toBe(6200n);
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
          amount_paise: "999999",
          merchant_id: "MERCH_003",
        },
      }),
    );

    const state = await prisma.$transaction((tx) => deriveState(tx, MANDATE));
    expect(state.spent_paise).toBe(0n);
    expect(state.merchants_transacted.size).toBe(0);
  });

  it("throws on a captured outcome with a malformed amount_paise", async () => {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t1",
        ts: new Date("2026-09-04T10:00:00.000Z"),
        actor: "system",
        eventType: "outcome",
        payload: { mandate_id: MANDATE, status: "captured", amount_paise: "not-a-number" },
      }),
    );

    await expect(prisma.$transaction((tx) => deriveState(tx, MANDATE))).rejects.toThrow(
      /amount_paise is malformed/,
    );
  });
});
