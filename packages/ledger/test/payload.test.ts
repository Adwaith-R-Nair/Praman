import { describe, expect, it } from "vitest";
import { assertLedgerPayload } from "../src/payload.js";

describe("assertLedgerPayload", () => {
  it("accepts plain JSON-safe values", () => {
    expect(() =>
      assertLedgerPayload({
        mandate_id: "mnd_01",
        status: "captured",
        amount_paise: "48000", // string, not bigint — the required form
        qty: 2,
        note: null,
        tags: ["a", "b"],
      }),
    ).not.toThrow();
  });

  it("rejects a bigint, naming the field", () => {
    expect(() => assertLedgerPayload({ amount_paise: 48000n })).toThrow(/amount_paise: bigint/);
  });

  it("rejects a bigint nested inside an array, with the index in the path", () => {
    expect(() => assertLedgerPayload({ amounts: [1, 2n] })).toThrow(/amounts\[1\]: bigint/);
  });

  it("rejects a Date, naming the field", () => {
    expect(() => assertLedgerPayload({ ts: new Date() })).toThrow(/ts: Date must be an ISO string/);
  });

  it("rejects undefined", () => {
    expect(() => assertLedgerPayload({ x: undefined })).toThrow(/x: undefined is not serialisable/);
  });

  it("rejects a non-finite number", () => {
    expect(() => assertLedgerPayload({ x: Infinity })).toThrow(/non-finite number/);
    expect(() => assertLedgerPayload({ x: NaN })).toThrow(/non-finite number/);
  });

  it("rejects a non-integer number", () => {
    expect(() => assertLedgerPayload({ x: 1.5 })).toThrow(/non-integer number/);
  });

  it("recurses into nested objects, building a dotted path", () => {
    expect(() => assertLedgerPayload({ a: { b: { c: 5n } } })).toThrow(/a\.b\.c: bigint/);
  });
});
