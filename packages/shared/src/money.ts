declare const MinorBrand: unique symbol;

/** An integer amount in the minor unit of its currency. Construct only via `minor()`. */
export type Minor = bigint & { readonly [MinorBrand]: true };

/** The only way to create a Minor. Rejects negatives at the boundary. */
export function minor(value: bigint): Minor {
  if (value < 0n) throw new RangeError(`Minor cannot be negative: ${value}`);
  return value as Minor;
}

export const ZERO_MINOR = minor(0n);

export function addMinor(a: Minor, b: Minor): Minor {
  return minor(a + b);
}

/** Throws if the result would be negative — an overdrawn budget is a bug, not a value. */
export function subMinor(a: Minor, b: Minor): Minor {
  return minor(a - b);
}

export function mulMinor(unit: Minor, qty: number): Minor {
  if (!Number.isInteger(qty) || qty < 0) {
    throw new RangeError(`Quantity must be a non-negative integer: ${qty}`);
  }
  return minor(unit * BigInt(qty));
}

/**
 * Display only. Never parse this back.
 * Rejects negative values: the brand is erased at compile time, so a value
 * that reached this function via a cast rather than `minor()` would
 * otherwise render as a plausible-looking, silently wrong amount.
 */
export function formatINR(value: Minor): string {
  if (value < 0n) throw new RangeError(`Negative Minor reached formatINR: ${value}`);
  const rupees = value / 100n;
  const fraction = value % 100n;
  return `₹${rupees.toString()}.${fraction.toString().padStart(2, "0")}`;
}

/** JSON has no bigint, and JSON.parse corrupts integers above 2^53. Amounts cross the wire as strings. */
export function minorToJSON(value: Minor): string {
  return value.toString();
}

export function minorFromJSON(value: string): Minor {
  if (!/^\d+$/.test(value)) throw new TypeError(`Not a minor-unit string: ${value}`);
  return minor(BigInt(value));
}

/** Postgres BIGINT → Minor. The ONLY place a database value becomes money. */
export function minorFromDb(value: bigint): Minor {
  if (typeof value !== "bigint") throw new TypeError(`Expected bigint from db, got ${typeof value}`);
  return minor(value);
}

/**
 * Razorpay JSON number → Minor. Razorpay sends amounts as JSON numbers in
 * minor units, so this is the one place a float can enter the money path.
 */
export function minorFromRazorpay(value: unknown): Minor {
  if (typeof value !== "number") throw new TypeError(`Razorpay amount is not a number: ${typeof value}`);
  if (!Number.isSafeInteger(value)) throw new RangeError(`Razorpay amount is not a safe integer: ${value}`);
  if (value < 0) throw new RangeError(`Razorpay amount is negative: ${value}`);
  return minor(BigInt(value));
}