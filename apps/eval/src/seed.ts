import { append } from "@praman/ledger";
import { generateKeypair, signMandate, type MandateDocument, type SignedMandate } from "@praman/mandate";
import { idempotencyKey } from "@praman/exec-core";
import { isCurrency, type Currency } from "@praman/shared";
import type { PurchaseIntent } from "@praman/policy";
import { prisma } from "./db.js";
import { loadCatalogFixture, loadMandateFixture, railFor, type CatalogFixture } from "./fixtures.js";
import type { Layer1Case, Layer2Case, SeedEvent } from "./types.js";

/**
 * The same fixture in another currency, for a mirrored run. Only called on a
 * case mirrorPlan() cleared, so the mandate is v2 and has one currency.
 */
function relabelMandate(doc: MandateDocument, currency: Currency): MandateDocument {
  if (doc.version === 1) throw new Error(`${doc.mandate_id}: a v1 mandate can only be in INR, so it can't be mirrored`);
  return { ...doc, scope: { ...doc.scope, currency } };
}

function relabelCatalog(cat: CatalogFixture, currency: Currency): CatalogFixture {
  return { ...cat, items: cat.items.map((i) => ({ ...i, currency })) };
}

/** Truncates everything a case could have touched. Called before every case. */
export async function resetTestDb(): Promise<void> {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record, catalog_item, merchant RESTART IDENTITY`;
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

async function seedEvents(mandateId: string, currency: string, defaultMerchantId: string, c: Layer1Case, now: Date): Promise<void> {
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
        const key =
          ev.order_key ??
          (ev.duplicate_of_this_intent === true ? computeDuplicateKey(mandateId, c, ev) : `seed_${mandateId}_${i.toString()}`);
        return append(tx, {
          traceId,
          ts,
          actor: "praman",
          eventType: "outcome",
          payload: {
            mandate_id: mandateId,
            status,
            // Rows sharing an order_key are one order at different stages, so
            // they name one order id. deriveState counts two ids as two orders.
            order_id: `order_SEED_${ev.order_key ?? i.toString()}`,
            payment_id: status === "captured" ? `pay_SEED_${i.toString()}` : null,
            amount_minor: ev.amount_minor ?? "0",
            currency,
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
          ...(kind === "DENY" ? { detail: "seed" } : { amount_minor: ev.amount_minor ?? "0", currency }),
        },
      });
    });
  }
}

export interface SeededCase {
  readonly signed: SignedMandate;
  readonly publicKeyPem: string;
  readonly now: Date;
  /** The primary catalog fixture's merchant_id — Layer 2 needs it to call runAgent. */
  readonly merchantId: string;
  /** Null when the fixture's mandate is deliberately in a currency we don't support. */
  readonly currency: Currency | null;
  /** The rail the primary merchant was configured on. Null when its currency is one no rail takes. */
  readonly rail: "razorpay" | "paypal" | null;
}

/** The rail a fixture merchant is configured on. Nothing here picks the executor: that is always the simulated one. */
function merchantRail(currency: string): "razorpay" | "paypal" | "simulated" {
  return isCurrency(currency) ? railFor(currency) : "simulated";
}

/**
 * Resets the DB, seeds the case's catalog and prior ledger history, signs its
 * mandate fixture fresh. With `mirrorTo`, every currency in the case becomes
 * that one, so the same case runs at a merchant on the other rail.
 */
export async function seedCase(c: Layer1Case | Layer2Case, mirrorTo?: Currency): Promise<SeededCase> {
  await resetTestDb();

  const now = new Date();
  const fixture = loadMandateFixture(c.mandate);
  const doc = mirrorTo === undefined ? fixture : relabelMandate(fixture, mirrorTo);
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const signed = signMandate(doc, privateKeyPem, "eval_k1");

  const relabel = (cat: CatalogFixture): CatalogFixture => (mirrorTo === undefined ? cat : relabelCatalog(cat, mirrorTo));
  const catalog = relabel(loadCatalogFixture(c.catalog));
  const catalogsToSeed = [catalog, ...(c.layer === 1 ? (c.extra_catalogs ?? []) : []).map((name) => relabel(loadCatalogFixture(name)))];
  for (const cat of catalogsToSeed) {
    // The merchant is configured on the rail its currency belongs to, as it
    // would be in production. The runner still routes every rail to the
    // simulated executor, so evals never reach a real gateway.
    const currency = cat.items[0]?.currency ?? "INR";
    await prisma.merchant.create({
      data: { merchantId: cat.merchant_id, rail: merchantRail(currency), currency },
    });
    await prisma.catalogItem.createMany({
      data: cat.items.map((i) => ({
        merchantId: cat.merchant_id,
        sku: i.sku,
        title: i.title,
        description: i.description,
        category: i.category,
        priceMinor: BigInt(i.price_minor),
        currency: i.currency,
        stockQty: i.stock_qty,
      })),
    });
  }

  if (c.layer === 1) {
    await seedEvents(doc.mandate_id, doc.scope.currency, catalog.merchant_id, c, now);
  }

  const currency = isCurrency(doc.scope.currency) ? doc.scope.currency : null;
  const primaryCurrency = catalog.items[0]?.currency ?? "INR";
  const rail = isCurrency(primaryCurrency) ? railFor(primaryCurrency) : null;

  // Simulates a forged mandate: return a public key that does not match the
  // one actually used to sign, so verifyMandate fails at the source.
  if (c.layer === 1 && c.tamper === "wrong_key") {
    const wrongKeypair = generateKeypair();
    return { signed, publicKeyPem: wrongKeypair.publicKeyPem, now, merchantId: catalog.merchant_id, currency, rail };
  }

  return { signed, publicKeyPem, now, merchantId: catalog.merchant_id, currency, rail };
}
