import { prisma, type PrismaTx } from "@praman/db";
import { read, type LedgerEntryRecord } from "@praman/ledger";

/**
 * Runs work in a transaction Postgres itself holds read-only, so a mistake in the
 * auditor can't write to the ledger: any INSERT, UPDATE or DELETE inside it is
 * refused by the database.
 */
export function inReadOnlyTransaction<T>(work: (tx: PrismaTx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return work(tx);
  });
}

/** One trace's ledger rows, oldest first, through the ledger package's own read(). */
export function readTraceReadOnly(traceId: string): Promise<readonly LedgerEntryRecord[]> {
  return inReadOnlyTransaction((tx) => read(tx, traceId));
}
