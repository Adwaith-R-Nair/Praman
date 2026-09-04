import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

const connectionString = process.env["DATABASE_URL"];
if (connectionString === undefined || connectionString === "") {
  throw new Error("DATABASE_URL is not set");
}

const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });
export type { Prisma } from "./generated/prisma/client.js";
export type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export * from "./catalog.js";
