import { describe, expect, it } from "vitest";
import { canonical } from "../src/canonical.js";

describe("canonical", () => {
  it("is independent of key insertion order", () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
  });

  it("sorts nested keys too", () => {
    expect(canonical({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
  });

  it("preserves array order", () => {
    expect(canonical([3, 1, 2])).toBe("[3,1,2]");
  });

  it("serialises bigints as strings", () => {
    expect(canonical({ amount: 48000n })).toBe('{"amount":"48000"}');
  });

  it("drops undefined properties", () => {
    expect(canonical({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects non-finite and fractional numbers", () => {
    expect(() => canonical({ a: NaN })).toThrow();
    expect(() => canonical({ a: 1.5 })).toThrow();
  });

  it("escapes strings that could break the structure", () => {
    expect(canonical({ 'a"b': 'c"d' })).toBe('{"a\\"b":"c\\"d"}');
  });
});