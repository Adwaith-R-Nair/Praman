import { describe, expect, it } from "vitest";
import { paise, addPaise, subPaise, mulPaise, formatINR, paiseFromJSON } from "../src/money.js";

describe("Paise", () => {
  it("rejects negative construction", () => {
    expect(() => paise(-1n)).toThrow(RangeError);
  });

  it("rejects subtraction below zero", () => {
    expect(() => subPaise(paise(100n), paise(200n))).toThrow(RangeError);
  });

  it("multiplies by an integer quantity", () => {
    expect(mulPaise(paise(24000n), 2)).toBe(48000n);
  });

  it("rejects fractional quantity", () => {
    expect(() => mulPaise(paise(100n), 1.5)).toThrow(RangeError);
  });

  it("formats with two decimal places", () => {
    expect(formatINR(paise(48000n))).toBe("₹480.00");
    expect(formatINR(paise(5n))).toBe("₹0.05");
  });

  it("rejects a forged negative Paise at the display boundary", () => {
    // The brand is erased at compile time, so a value that skipped paise()'s
    // guard is indistinguishable from a real Paise at runtime. @ts-expect-error
    // (not `as Paise`, which lint:casts would rightly flag outside money.ts)
    // stands in for that escape, to prove formatINR does not trust it silently.
    // @ts-expect-error - deliberately bypassing paise() to simulate a forged value
    expect(() => formatINR(-100n)).toThrow(RangeError);
  });

  it("survives values above Number.MAX_SAFE_INTEGER", () => {
    const big = paise(9007199254740993n);
    expect(paiseFromJSON(big.toString())).toBe(big);
  });

  it("adds without precision loss", () => {
    expect(addPaise(paise(10n), paise(20n))).toBe(30n);
  });

  it("rejects json values BigInt would silently accept", () => {
    expect(() => paiseFromJSON("")).toThrow();
    expect(() => paiseFromJSON("0x10")).toThrow();
    expect(() => paiseFromJSON(" 42 ")).toThrow();
    expect(() => paiseFromJSON("480.00")).toThrow();
  });
});