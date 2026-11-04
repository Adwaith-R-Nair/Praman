import { describe, expect, it } from "vitest";
import {
  minor,
  addMinor,
  subMinor,
  mulMinor,
  formatINR,
  minorFromJSON,
  minorFromDb,
  minorFromRazorpay,
} from "../src/money.js";

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

  it("formats with two decimal places", () => {
    expect(formatINR(minor(48000n))).toBe("₹480.00");
    expect(formatINR(minor(5n))).toBe("₹0.05");
  });

  it("rejects a forged negative Minor at the display boundary", () => {
    // The brand is erased at compile time, so a value that skipped minor()'s
    // guard is indistinguishable from a real Minor at runtime. @ts-expect-error
    // (not `as Minor`, which lint:casts would rightly flag outside money.ts)
    // stands in for that escape, to prove formatINR does not trust it silently.
    // @ts-expect-error - deliberately bypassing minor() to simulate a forged value
    expect(() => formatINR(-100n)).toThrow(RangeError);
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