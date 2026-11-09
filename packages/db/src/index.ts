import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

const connectionString = process.env["DATABASE_URL"];
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL is not set");
}

const adapter = new PrismaPg({ connectionString });

/**
 * How long a transaction may wait, in milliseconds. Prisma's defaults are 2 seconds to
 * get a connection and start, and 5 seconds to finish. Every money transaction first
 * takes its mandate's advisory lock, so intents for one mandate queue behind each other,
 * and on a hosted database each query in the queue is a network round trip. With the
 * defaults, an intent near the back of a busy queue was thrown out before it was
 * decided: no ledger row, and a server error for the caller (D-91). Waiting longer is
 * safe, because no rail call is ever made inside a transaction (D-22), so the time is
 * spent queueing for the lock and never holding it across a payment.
 */
export const TRANSACTION_MAX_WAIT_MS = 15_000;
export const TRANSACTION_TIMEOUT_MS = 30_000;

export const prisma = new PrismaClient({ adapter, transactionOptions: { maxWait: TRANSACTION_MAX_WAIT_MS, timeout: TRANSACTION_TIMEOUT_MS } });
export type { Prisma } from "./generated/prisma/client.js";
export type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export * from "./catalog.js";
