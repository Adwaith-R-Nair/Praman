declare const PaiseBrand: unique symbol;

/** An integer amount in paise. Construct only via `paise()`. */
export type Paise = bigint & { readonly [PaiseBrand]: true };

/** The only way to create a Paise. Rejects negatives at the boundary. */
export function paise(value: bigint): Paise {
  if (value < 0n) throw new RangeError(`Paise cannot be negative: ${value}`);
  return value as Paise;
}

export const ZERO_PAISE = paise(0n);

export function addPaise(a: Paise, b: Paise): Paise {
  return paise(a + b);
}

/** Throws if the result would be negative — an overdrawn budget is a bug, not a value. */
export function subPaise(a: Paise, b: Paise): Paise {
  return paise(a - b);
}

export function mulPaise(unit: Paise, qty: number): Paise {
  if (!Number.isInteger(qty) || qty < 0) {
    throw new RangeError(`Quantity must be a non-negative integer: ${qty}`);
  }
  return paise(unit * BigInt(qty));
}

/**
 * Display only. Never parse this back.
 * Rejects negative values: the brand is erased at compile time, so a value
 * that reached this function via a cast rather than `paise()` would
 * otherwise render as a plausible-looking, silently wrong amount.
 */
export function formatINR(value: Paise): string {
  if (value < 0n) throw new RangeError(`Negative Paise reached formatINR: ${value}`);
  const rupees = value / 100n;
  const fraction = value % 100n;
  return `₹${rupees.toString()}.${fraction.toString().padStart(2, "0")}`;
}

/** JSON has no bigint, and JSON.parse corrupts integers above 2^53. Amounts cross the wire as strings. */
export function paiseToJSON(value: Paise): string {
  return value.toString();
}

export function paiseFromJSON(value: string): Paise {
  if (!/^\d+$/.test(value)) throw new TypeError(`Not a paise string: ${value}`);
  return paise(BigInt(value));
}

/** Postgres BIGINT → Paise. The ONLY place a database value becomes money. */
export function paiseFromDb(value: bigint): Paise {
  if (typeof value !== "bigint") throw new TypeError(`Expected bigint from db, got ${typeof value}`);
  return paise(value);
}

/**
 * Razorpay JSON number → Paise. Razorpay sends amounts as JSON numbers in
 * paise, so this is the one place a float can enter the money path.
 */
export function paiseFromRazorpay(value: unknown): Paise {
  if (typeof value !== "number") throw new TypeError(`Razorpay amount is not a number: ${typeof value}`);
  if (!Number.isSafeInteger(value)) throw new RangeError(`Razorpay amount is not a safe integer: ${value}`);
  if (value < 0) throw new RangeError(`Razorpay amount is negative: ${value}`);
  return paise(BigInt(value));
}