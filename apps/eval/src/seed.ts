import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { append } from "@praman/ledger";
import { generateKeypair, signMandate, type MandateDocument, type SignedMandate } from "@praman/mandate";
import { prisma } from "./db.js";
import type { Layer1Case, Layer2Case, SeedEvent } from "./types.js";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));

interface CatalogFixtureItem {
  readonly sku: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly price_paise: string;
  readonly stock_qty: number;
}
interface CatalogFixture {
  readonly merchant_id: string;
  readonly items: readonly CatalogFixtureItem[];
}

function loadMandateFixture(name: string): MandateDocument {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}/mandates/${name}.json`, "utf8")) as MandateDocument;
}

function loadCatalogFixture(name: string): CatalogFixture {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}/catalogs/${name}.json`, "utf8")) as CatalogFixture;
}

/** Truncates everything a case could have touched. Called before every case. */
export async function resetTestDb(): Promise<void> {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record, catalog_item RESTART IDENTITY`;
}

async function seedEvents(mandateId: string, defaultMerchantId: string, events: readonly SeedEvent[], now: Date): Promise<void> {
  for (const [i, ev] of events.entries()) {
    const ts = new Date(now.getTime() - ev.minutes_ago * 60_000);
    const merchantId = ev.merchant_id ?? defaultMerchantId;
    const traceId = `trc_seed_${mandateId}_${i.toString()}`;

    await prisma.$transaction((tx) => {
      if (ev.event === "outcome") {
        const status = ev.status ?? "captured";
        return append(tx, {
          traceId,
          ts,
          actor: "praman",
          eventType: "outcome",
          payload: {
            mandate_id: mandateId,
            status,
            order_id: `order_SEED_${i.toString()}`,
            payment_id: status === "captured" ? `pay_SEED_${i.toString()}` : null,
            amount_paise: ev.amount_paise ?? "0",
            merchant_id: merchantId,
            idempotency_key: `seed_${mandateId}_${i.toString()}`,
          },
        });
      }
      const kind = ev.kind ?? "DENY";
      return append(tx, {
        traceId,
        ts,
        actor: "praman",
        eventType: "decision",
        payload: {
          mandate_id: mandateId,
          kind,
          reason_code: ev.reason_code ?? (kind === "DENY" ? "AMOUNT_INVALID" : "OK"),
          ...(kind === "DENY" ? { detail: "seed" } : { amount_paise: ev.amount_paise ?? "0" }),
        },
      });
    });
  }
}

export interface SeededCase {
  readonly signed: SignedMandate;
  readonly publicKeyPem: string;
  readonly now: Date;
}

/** Resets the DB, seeds the case's catalog and prior ledger history, signs its mandate fixture fresh. */
export async function seedCase(c: Layer1Case | Layer2Case): Promise<SeededCase> {
  await resetTestDb();

  const now = new Date();
  const doc = loadMandateFixture(c.mandate);
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const signed = signMandate(doc, privateKeyPem, "eval_k1");

  const catalog = loadCatalogFixture(c.catalog);
  await prisma.catalogItem.createMany({
    data: catalog.items.map((i) => ({
      merchantId: catalog.merchant_id,
      sku: i.sku,
      title: i.title,
      description: i.description,
      category: i.category,
      pricePaise: BigInt(i.price_paise),
      stockQty: i.stock_qty,
    })),
  });

  if (c.layer === 1) {
    await seedEvents(doc.mandate_id, catalog.merchant_id, c.seed, now);
  }

  return { signed, publicKeyPem, now };
}
