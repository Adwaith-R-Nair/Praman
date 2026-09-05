import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append } from "../src/append.js";
import { read } from "../src/read.js";

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record RESTART IDENTITY`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("read", () => {
  it("returns only this trace's entries, in seq order", async () => {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "trace_a",
        ts: new Date("2026-09-04T12:00:00.000Z"),
        actor: "agent",
        eventType: "intent",
        payload: { sku: "SKU_FOOD_001", qty: 1 },
      }),
    );
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "trace_b",
        ts: new Date("2026-09-04T12:00:01.000Z"),
        actor: "agent",
        eventType: "intent",
        payload: { sku: "SKU_FOOD_002", qty: 1 },
      }),
    );
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "trace_a",
        ts: new Date("2026-09-04T12:00:02.000Z"),
        actor: "praman",
        eventType: "decision",
        payload: { kind: "ALLOW" },
      }),
    );

    const entries = await prisma.$transaction((tx) => read(tx, "trace_a"));

    expect(entries).toHaveLength(2);
    expect(entries[0]?.eventType).toBe("intent");
    expect(entries[0]?.seq).toBe(1n);
    expect(entries[1]?.eventType).toBe("decision");
    expect(entries[1]?.seq).toBe(3n);
  });

  it("returns an empty array for an unknown trace", async () => {
    const entries = await prisma.$transaction((tx) => read(tx, "trace_does_not_exist"));
    expect(entries).toEqual([]);
  });
});
