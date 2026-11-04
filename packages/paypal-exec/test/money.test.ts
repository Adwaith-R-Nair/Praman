import { describe, expect, it } from "vitest";
import { minor } from "@praman/shared";
import { fromPayPalValue, toPayPalValue } from "../src/money.js";

describe("toPayPalValue", () => {
  it("formats 1250n as 12.50 and 5n as 0.05 and 100n as 1.00", () => {
    expect(toPayPalValue(minor(1250n))).toBe("12.50");
    expect(toPayPalValue(minor(5n))).toBe("0.05");
    expect(toPayPalValue(minor(100n))).toBe("1.00");
    expect(toPayPalValue(minor(0n))).toBe("0.00");
  });

  it("keeps every digit above 2^53, where a float would round", () => {
    expect(toPayPalValue(minor(900719925474099301n))).toBe("9007199254740993.01");
  });
});

describe("fromPayPalValue", () => {
  it("reads the two-decimal form PayPal answers with", () => {
    expect(fromPayPalValue("12.50")).toBe(1250n);
    expect(fromPayPalValue("0.05")).toBe(5n);
    expect(fromPayPalValue("1.00")).toBe(100n);
    expect(fromPayPalValue("9007199254740993.01")).toBe(900719925474099301n);
  });

  it.each(["12.5", "12.500", "-1.00", "1e3", " 1.00", "", "1,000.00", "01.00", "1.00\n", ".50", "1.", "١.٠٠"])("rejects %s", (value) => {
    expect(() => fromPayPalValue(value)).toThrow(TypeError);
  });

  it("rejects non-string amounts from PayPal", () => {
    for (const value of [1250, 12.5, null, undefined, true, 1250n, { value: "12.50" }, ["12.50"]]) {
      expect(() => fromPayPalValue(value)).toThrow(TypeError);
    }
  });
});

describe("round trip", () => {
  it("round-trips across a property sweep of bigint values", () => {
    // Every cents value in the first few dollars, then a fixed-seed walk through much larger ones.
    for (let v = 0n; v < 2000n; v += 1n) {
      expect(fromPayPalValue(toPayPalValue(minor(v)))).toBe(v);
    }
    let v = 1n;
    for (let i = 0; i < 2000; i += 1) {
      v = (v * 6364136223846793005n + 1442695040888963407n) % (1n << 80n);
      expect(fromPayPalValue(toPayPalValue(minor(v)))).toBe(v);
    }
  });
});
