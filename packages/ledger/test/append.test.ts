import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append } from "../src/append.js";
import { GENESIS_HASH } from "../src/chain.js";

// Integration tests against the real database (docker: praman-db). TRUNCATE
// bypasses row-level triggers entirely — that's a genuine gap in the
// immutability story, not exploited here. See BUILD_LOG.
beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry RESTART IDENTITY`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("append", () => {
  it("genesis entry gets seq 1 and a prev_hash of 64 zeros", async () => {
    const result = await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "trace_1",
        ts: new Date("2026-09-04T12:00:00.000Z"),
        actor: "system",
        eventType: "intent",
        payload: { sku: "SKU_FOOD_001", qty: 1 },
      }),
    );

    expect(result.seq).toBe(1n);
    expect(result.prevHash).toBe(GENESIS_HASH);

    const row = await prisma.ledgerEntry.findUniqueOrThrow({ where: { seq: 1n } });
    expect(row.prevHash).toBe(GENESIS_HASH);
    expect(row.entryHash).toBe(result.entryHash);
  });

  it("second entry's prev_hash equals the first entry's entry_hash", async () => {
    const first = await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "trace_1",
        ts: new Date("2026-09-04T12:00:00.000Z"),
        actor: "system",
        eventType: "intent",
        payload: { sku: "SKU_FOOD_001", qty: 1 },
      }),
    );
    const second = await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "trace_1",
        ts: new Date("2026-09-04T12:00:01.000Z"),
        actor: "system",
        eventType: "decision",
        payload: { kind: "ALLOW" },
      }),
    );

    expect(second.seq).toBe(2n);
    expect(second.prevHash).toBe(first.entryHash);

    const row = await prisma.ledgerEntry.findUniqueOrThrow({ where: { seq: 2n } });
    expect(row.prevHash).toBe(first.entryHash);
  });
});
