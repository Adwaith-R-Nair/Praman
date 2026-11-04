import { describe, expect, it } from "vitest";
import {
  minor,
  addMinor,
  subMinor,
  mulMinor,
  formatMoney,
  isCurrency,
  currencyFromDb,
  CURRENCIES,
  minorFromJSON,
  minorFromDb,
  minorFromRazorpay,
} from "../src/money.js";

describe("Currency", () => {
  it("supports exactly INR and USD", () => {
    expect(CURRENCIES).toEqual(["INR", "USD"]);
  });

  it.each(["INR", "USD"])("recognises %s", (value) => {
    expect(isCurrency(value)).toBe(true);
  });

  it.each(["JPY", "inr", "usd", "", " INR", null, undefined, 840])("refuses %s", (value) => {
    expect(isCurrency(value)).toBe(false);
  });

  it("reads a database value only if it is a supported currency", () => {
    expect(currencyFromDb("USD")).toBe("USD");
    expect(() => currencyFromDb("JPY")).toThrow(TypeError);
  });
});

describe("formatMoney", () => {
  it("renders 50000n INR as ₹500.00 and 1250n USD as $12.50", () => {
    expect(formatMoney(minor(50000n), "INR")).toBe("₹500.00");
    expect(formatMoney(minor(1250n), "USD")).toBe("$12.50");
  });

  it("keeps two decimal places for small amounts", () => {
    expect(formatMoney(minor(5n), "USD")).toBe("$0.05");
    expect(formatMoney(minor(0n), "INR")).toBe("₹0.00");
  });

  it("is exact above the range a float can hold", () => {
    expect(formatMoney(minor(9007199254740993n), "USD")).toBe("$90071992547409.93");
  });

  it("rejects a forged negative Minor at the display boundary", () => {
    // @ts-expect-error - deliberately bypassing minor() to simulate a forged value
    expect(() => formatMoney(-100n, "USD")).toThrow(RangeError);
  });
});

describe("Minor", () => {
  it("rejects negative construction", () => {
    expect(() => minor(-1n)).toThrow(RangeError);
  });

  it("rejects subtraction below zero", () => {
    expect(() => subMinor(minor(100n), minor(200n))).toThrow(RangeError);
  });

  it("multiplies by an integer quantity", () => {
    expect(mulMinor(minor(24000n), 2)).toBe(48000n);
  });

  it("rejects fractional quantity", () => {
    expect(() => mulMinor(minor(100n), 1.5)).toThrow(RangeError);
  });

  it("survives values above Number.MAX_SAFE_INTEGER", () => {
    const big = minor(9007199254740993n);
    expect(minorFromJSON(big.toString())).toBe(big);
  });

  it("adds without precision loss", () => {
    expect(addMinor(minor(10n), minor(20n))).toBe(30n);
  });

  it("rejects json values BigInt would silently accept", () => {
    expect(() => minorFromJSON("")).toThrow();
    expect(() => minorFromJSON("0x10")).toThrow();
    expect(() => minorFromJSON(" 42 ")).toThrow();
    expect(() => minorFromJSON("480.00")).toThrow();
  });
});

describe("minorFromDb", () => {
  it("hydrates a database bigint", () => {
    expect(minorFromDb(48000n)).toBe(48000n);
  });

  it("rejects a negative value via minor()'s own guard", () => {
    expect(() => minorFromDb(-1n)).toThrow(RangeError);
  });
});

describe("minorFromRazorpay", () => {
  it("hydrates a Razorpay JSON number", () => {
    expect(minorFromRazorpay(48000)).toBe(48000n);
  });

  it("rejects a fractional amount", () => {
    expect(() => minorFromRazorpay(48000.5)).toThrow(RangeError);
  });

  it("rejects a value past Number.MAX_SAFE_INTEGER", () => {
    expect(() => minorFromRazorpay(2 ** 53)).toThrow(RangeError);
  });

  it("rejects a negative amount", () => {
    expect(() => minorFromRazorpay(-100)).toThrow(RangeError);
  });

  it("rejects a non-number", () => {
    expect(() => minorFromRazorpay("48000")).toThrow(TypeError);
    expect(() => minorFromRazorpay(null)).toThrow(TypeError);
    expect(() => minorFromRazorpay(undefined)).toThrow(TypeError);
  });
});