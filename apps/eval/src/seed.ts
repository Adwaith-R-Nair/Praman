import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { append } from "@praman/ledger";
import { generateKeypair, signMandate, type MandateDocument, type SignedMandate } from "@praman/mandate";
import { idempotencyKey } from "@praman/razorpay-exec";
import type { PurchaseIntent } from "@praman/policy";
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

function computeDuplicateKey(mandateId: string, c: Layer1Case, ev: SeedEvent): string {
  const lineItems = ev.duplicate_line_items_override ?? c.intent.line_items;
  const asIfIntent: PurchaseIntent = {
    intent_id: `int_${c.case_id}`,
    mandate_id: mandateId,
    merchant_id: c.intent.merchant_id,
    line_items: lineItems,
    requested_at: new Date().toISOString(),
    agent_rationale: "duplicate-seed",
  };
  return idempotencyKey(mandateId, asIfIntent);
}

async function seedEvents(mandateId: string, defaultMerchantId: string, c: Layer1Case, now: Date): Promise<void> {
  for (const [i, ev] of c.seed.entries()) {
    const ts = new Date(now.getTime() - ev.minutes_ago * 60_000);
    const merchantId = ev.merchant_id ?? defaultMerchantId;
    const traceId = `trc_seed_${mandateId}_${i.toString()}`;

    await prisma.$transaction((tx) => {
      if (ev.event === "revoked") {
        return append(tx, {
          traceId,
          ts,
          actor: "praman",
          eventType: "mandate_revoked",
          payload: { mandate_id: mandateId, reason: "eval seed" },
        });
      }
      if (ev.event === "outcome") {
        const status = ev.status ?? "captured";
        const key = ev.duplicate_of_this_intent === true ? computeDuplicateKey(mandateId, c, ev) : `seed_${mandateId}_${i.toString()}`;
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
            idempotency_key: key,
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
  const catalogsToSeed = [catalog, ...(c.layer === 1 ? (c.extra_catalogs ?? []) : []).map(loadCatalogFixture)];
  for (const cat of catalogsToSeed) {
    await prisma.catalogItem.createMany({
      data: cat.items.map((i) => ({
        merchantId: cat.merchant_id,
        sku: i.sku,
        title: i.title,
        description: i.description,
        category: i.category,
        pricePaise: BigInt(i.price_paise),
        stockQty: i.stock_qty,
      })),
    });
  }

  if (c.layer === 1) {
    await seedEvents(doc.mandate_id, catalog.merchant_id, c, now);
  }

  // Simulates a forged mandate: return a public key that does not match the
  // one actually used to sign, so verifyMandate fails at the source.
  if (c.layer === 1 && c.tamper === "wrong_key") {
    const wrongKeypair = generateKeypair();
    return { signed, publicKeyPem: wrongKeypair.publicKeyPem, now };
  }

  return { signed, publicKeyPem, now };
}
