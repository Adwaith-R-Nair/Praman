import { minor, type Minor } from "@praman/shared";

/**
 * PayPal carries money as decimal strings, and only ever as strings here: no
 * float exists at any point in either direction. Both supported currencies have
 * two decimal places (see CURRENCIES in @praman/shared).
 */
const VALUE = /^(0|[1-9][0-9]*)\.[0-9]{2}$/;

export function toPayPalValue(value: Minor): string {
  if (value < 0n) throw new RangeError("A negative amount reached toPayPalValue");
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

/**
 * Inbound boundary. PayPal normalises 12.5 to 12.50 in what it returns (D-26),
 * so anything other than exactly two decimals isn't something it should be
 * saying. A throw means the outcome is unknown and the record stays pending.
 * The value isn't repeated in the error, because it is PayPal's text.
 */
export function fromPayPalValue(value: unknown): Minor {
  if (typeof value !== "string") throw new TypeError(`PayPal amount is not a string: ${typeof value}`);
  if (!VALUE.test(value)) throw new TypeError("PayPal amount is not in the form 0.00");
  return minor(BigInt(value.replace(".", "")));
}
