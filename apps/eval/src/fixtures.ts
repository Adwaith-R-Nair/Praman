import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MandateDocument } from "@praman/mandate";
import { isCurrency, type Currency } from "@praman/shared";
import type { Layer1Case, Layer2Case } from "./types.js";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));

export interface CatalogFixtureItem {
  readonly sku: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly price_minor: string;
  readonly currency: string;
  readonly stock_qty: number;
}
export interface CatalogFixture {
  readonly merchant_id: string;
  readonly items: readonly CatalogFixtureItem[];
}

export function loadMandateFixture(name: string): MandateDocument {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}/mandates/${name}.json`, "utf8")) as MandateDocument;
}

export function loadCatalogFixture(name: string): CatalogFixture {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}/catalogs/${name}.json`, "utf8")) as CatalogFixture;
}

/** The two real rails. Every eval run still executes on the simulated executor. */
export type PaymentRail = "razorpay" | "paypal";

/**
 * The rail an eval merchant is configured on, from its currency: the same
 * pairing `pnpm seed-catalog` uses. PayPal's sandbox refuses INR (D-26), so
 * a rupee merchant is a Razorpay merchant and a dollar merchant a PayPal one.
 */
export function railFor(currency: Currency): PaymentRail {
  return currency === "INR" ? "razorpay" : "paypal";
}

function otherCurrency(currency: Currency): Currency {
  return currency === "INR" ? "USD" : "INR";
}

export type MirrorPlan =
  | { readonly kind: "mirror"; readonly currency: Currency }
  | { readonly kind: "skip"; readonly why: string };

/**
 * Whether a Layer 1 case can also run on the other rail, by relabelling every
 * currency in it. Amounts stay the same integers, so 18000 is ₹180.00 on one
 * rail and $180.00 on the other, and every limit moves with them. A case can
 * only be mirrored when it has one currency throughout: a case built on two
 * currencies is testing the difference, and relabelling would erase it.
 */
export function mirrorPlan(c: Layer1Case | Layer2Case): MirrorPlan {
  if (c.layer !== 1) return { kind: "skip", why: "Layer 2 runs once, against a live model" };
  const doc = loadMandateFixture(c.mandate);
  const catalogs = [c.catalog, ...(c.extra_catalogs ?? [])].map(loadCatalogFixture);
  const currencies = new Set<string>([
    doc.scope.currency,
    ...catalogs.flatMap((cat) => cat.items.map((i) => i.currency)),
    ...(c.capture !== undefined ? [c.capture.currency] : []),
  ]);

  const found = [...currencies];
  if (found.some((cur) => !isCurrency(cur))) return { kind: "skip", why: "it uses a currency Praman doesn't support" };
  const only = found[0];
  if (found.length !== 1 || only === undefined || !isCurrency(only)) {
    return { kind: "skip", why: "it tests two currencies against each other" };
  }
  if (doc.version === 1) return { kind: "skip", why: "a v1 mandate can only be in INR" };
  return { kind: "mirror", currency: otherCurrency(only) };
}
