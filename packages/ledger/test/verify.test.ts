import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append } from "../src/append.js";
import { maybeCheckpoint } from "../src/checkpoint.js";
import { computeEntryHash, computePayloadHash } from "../src/chain.js";
import { verifyChain } from "../src/verify.js";

// Integration tests against TEST_DATABASE_URL (see vitest.config.ts), never
// the real one. TRUNCATE bypasses row-level triggers entirely — the
// immutability triggers only fire on UPDATE/DELETE, which is exactly why
// beforeEach can reset state this way. Real tampering tests below disable the
// trigger explicitly instead, on purpose.
beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record RESTART IDENTITY`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function buildChain(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: `t${i}`,
        ts: new Date(Date.UTC(2026, 8, 4, 10, 0, i)),
        actor: "system",
        eventType: "intent",
        payload: { i },
      }),
    );
  }
}

describe("verifyChain", () => {
  it("verifyChain still passes on rows written before the migration", async () => {
    // The ledger hash covers stored payload bytes, so an old row must keep its
    // old field name forever. This hash was computed by the code at 04e9ed1,
    // before the rename. If anything normalises amount_paise on the way to or
    // from storage, either this hash or the chain check below breaks.
    const before = {
      mandate_id: "mnd_frozen_v1",
      status: "created",
      order_id: "order_old",
      payment_id: null,
      amount_paise: "48000",
      merchant_id: "MERCH_001",
      idempotency_key: "idem_old",
    };
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t_old",
        ts: new Date("2026-09-04T10:00:00.000Z"),
        actor: "system",
        eventType: "outcome",
        payload: before,
      }),
    );
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "t_new",
        ts: new Date("2026-09-04T10:00:01.000Z"),
        actor: "system",
        eventType: "outcome",
        payload: { mandate_id: "mnd_frozen_v1", status: "created", amount_minor: "100" },
      }),
    );

    const row = await prisma.ledgerEntry.findFirstOrThrow({ where: { traceId: "t_old" } });
    expect(row.payloadHash).toBe("aa6b4cf6923efef540ce5332567ecca7dad323deabd070592d24253c93a51292");
    expect(row.payload).toEqual(before);

    const result = await prisma.$transaction((tx) => verifyChain(tx));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.checked).toBe(2);
  });

  it("verifies a clean chain of 20 entries", async () => {
    await buildChain(20);
    const result = await prisma.$transaction((tx) => verifyChain(tx));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.checked).toBe(20);

    const last = await prisma.ledgerEntry.findFirstOrThrow({ orderBy: { seq: "desc" } });
    expect(result.head).toBe(last.entryHash);
  });

  it("validates a checkpoint's merkle root at 100 entries", async () => {
    await buildChain(100);
    await prisma.$transaction((tx) => maybeCheckpoint(tx, new Date("2026-09-04T11:00:00.000Z")));

    const result = await prisma.$transaction((tx) => verifyChain(tx));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.checked).toBe(101); // 100 entries + the checkpoint itself
  });

  it("detects a tampered payload at the exact seq", async () => {
    await buildChain(20);

    await prisma.$executeRaw`ALTER TABLE ledger_entry DISABLE TRIGGER ledger_no_update`;
    await prisma.$executeRaw`UPDATE ledger_entry SET payload = '{"i": 999}'::jsonb WHERE seq = 10`;
    await prisma.$executeRaw`ALTER TABLE ledger_entry ENABLE TRIGGER ledger_no_update`;

    const result = await prisma.$transaction((tx) => verifyChain(tx));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.brokenAt).toBe(10n);
    expect(result.reason).toBe("PAYLOAD_HASH_MISMATCH");
  });

  it("detects a tampered actor as an entry-hash mismatch", async () => {
    await buildChain(20);

    await prisma.$executeRaw`ALTER TABLE ledger_entry DISABLE TRIGGER ledger_no_update`;
    await prisma.$executeRaw`UPDATE ledger_entry SET actor = 'attacker' WHERE seq = 10`;
    await prisma.$executeRaw`ALTER TABLE ledger_entry ENABLE TRIGGER ledger_no_update`;

    const result = await prisma.$transaction((tx) => verifyChain(tx));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.brokenAt).toBe(10n);
    expect(result.reason).toBe("ENTRY_HASH_MISMATCH");
  });

  it("detects a deleted row as a sequence gap", async () => {
    await buildChain(20);

    await prisma.$executeRaw`ALTER TABLE ledger_entry DISABLE TRIGGER ledger_no_delete`;
    await prisma.$executeRaw`DELETE FROM ledger_entry WHERE seq = 10`;
    await prisma.$executeRaw`ALTER TABLE ledger_entry ENABLE TRIGGER ledger_no_delete`;

    const result = await prisma.$transaction((tx) => verifyChain(tx));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("SEQ_GAP");
    expect(result.brokenAt).toBe(11n); // the next surviving row, not the missing one
  });

  it("detects a corrupted checkpoint root", async () => {
    await buildChain(100);
    await prisma.$transaction((tx) => maybeCheckpoint(tx, new Date("2026-09-04T11:00:00.000Z")));

    const ckpt = await prisma.ledgerEntry.findFirstOrThrow({ where: { eventType: "checkpoint" } });
    const badPayload = { ...(ckpt.payload as Record<string, unknown>), merkle_root: "f".repeat(64) };

    // A real forgery would also re-sign the checkpoint's own hashes to look
    // valid up to the merkle check — otherwise it's caught earlier, at
    // PAYLOAD_HASH_MISMATCH, which proves nothing about the merkle check itself.
    const newPayloadHash = computePayloadHash(badPayload);
    const newEntryHash = computeEntryHash({
      prevHash: ckpt.prevHash,
      seq: ckpt.seq,
      ts: ckpt.ts,
      actor: ckpt.actor,
      eventType: ckpt.eventType,
      payloadHash: newPayloadHash,
    });

    await prisma.$executeRaw`ALTER TABLE ledger_entry DISABLE TRIGGER ledger_no_update`;
    await prisma.ledgerEntry.update({
      where: { seq: ckpt.seq },
      data: { payload: badPayload as object, payloadHash: newPayloadHash, entryHash: newEntryHash },
    });
    await prisma.$executeRaw`ALTER TABLE ledger_entry ENABLE TRIGGER ledger_no_update`;

    const result = await prisma.$transaction((tx) => verifyChain(tx));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.brokenAt).toBe(ckpt.seq);
    expect(result.reason).toBe("MERKLE_MISMATCH");
  });
});
