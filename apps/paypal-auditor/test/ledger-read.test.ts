import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append } from "@praman/ledger";
import { runAudit } from "../src/audit.js";
import { inReadOnlyTransaction, readTraceReadOnly } from "../src/ledger-read.js";
import { fakePayPal, intent, ok, outcome, paidOrder, TRACE } from "./fixtures.js";

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record RESTART IDENTITY`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seed(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const [i, entry] of [intent, outcome("created"), outcome("captured")].entries()) {
      await append(tx, { traceId: TRACE, ts: new Date(Date.UTC(2026, 10, 9, 10, 0, i)), actor: "praman", eventType: entry.eventType, payload: entry.payload });
    }
  });
}

const snapshot = () => prisma.ledgerEntry.findMany({ orderBy: { seq: "asc" } });

describe("the auditor's ledger access", () => {
  it("reads a trace's rows through read(), in order", async () => {
    await seed();
    const rows = await readTraceReadOnly(TRACE);
    expect(rows.map((row) => row.eventType)).toEqual(["intent", "outcome", "outcome"]);
    expect(await readTraceReadOnly("trc_nope")).toEqual([]);
  });

  it("runs in a transaction the database refuses to write in", async () => {
    await seed();
    const before = await snapshot();
    const write = inReadOnlyTransaction((tx) => append(tx, { traceId: TRACE, ts: new Date(), actor: "auditor", eventType: "outcome", payload: { note: "must not land" } }));
    await expect(write).rejects.toThrow(/read-only transaction/);
    await expect(inReadOnlyTransaction((tx) => tx.$executeRaw`DELETE FROM idempotency_record`)).rejects.toThrow(/read-only transaction/);
    expect(await snapshot()).toEqual(before);
  });

  it("audits rows written by append() and leaves the ledger exactly as it was", async () => {
    await seed();
    const before = await snapshot();
    const result = await runAudit({ readTrace: readTraceReadOnly, paypal: () => fakePayPal({ order: ok(paidOrder()) }) }, TRACE, null);
    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain("Overall: MATCH. 6 of 6 fields agree.");
    const differing = await runAudit({ readTrace: readTraceReadOnly, paypal: () => fakePayPal({ order: ok(paidOrder({ value: "32.01" })) }) }, TRACE, null);
    expect(differing.exitCode).toBe(1);
    expect(await snapshot()).toEqual(before);
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });
});
