import { describe, expect, it } from "vitest";
import { GENESIS_HASH, computeEntryHash, computePayloadHash } from "../src/chain.js";

describe("computePayloadHash / computeEntryHash", () => {
  it("matches a known vector — fails if the preimage format ever changes", () => {
    const payloadHash = computePayloadHash({ sku: "SKU_FOOD_001", qty: 2 });
    expect(payloadHash).toBe("22f3f3c49a35e51ba7b66cd53c2fe3b06c329b6c41749ec85e46f9a614714759");

    const entryHash = computeEntryHash({
      prevHash: GENESIS_HASH,
      seq: 1n,
      ts: new Date("2026-08-28T12:00:00.000Z"),
      actor: "system",
      eventType: "decision",
      payloadHash,
    });
    expect(entryHash).toBe("bd2b751f00ef22a4b315b24390a6f54ffdcf33153303537f3a2e116dad5fc582");
  });

  it("treats a field boundary as significant — no separator would make these collide", () => {
    const base = {
      prevHash: GENESIS_HASH,
      seq: 1n,
      ts: new Date("2026-08-28T12:00:00.000Z"),
      payloadHash: computePayloadHash({ sku: "SKU_FOOD_001", qty: 1 }),
    };
    const a = computeEntryHash({ ...base, actor: "ab", eventType: "c" });
    const b = computeEntryHash({ ...base, actor: "a", eventType: "bc" });
    expect(a).not.toBe(b);
  });

  it("avalanches — flipping one character of payloadHash changes the entry hash completely", () => {
    const base = {
      prevHash: GENESIS_HASH,
      seq: 1n,
      ts: new Date("2026-08-28T12:00:00.000Z"),
      actor: "system",
      eventType: "decision",
    };
    const payloadHash = computePayloadHash({ sku: "SKU_FOOD_001", qty: 1 });
    const flipped = (payloadHash[0] === "a" ? "b" : "a") + payloadHash.slice(1);

    const original = computeEntryHash({ ...base, payloadHash });
    const mutated = computeEntryHash({ ...base, payloadHash: flipped });

    expect(mutated).not.toBe(original);
    // A real avalanche, not a superficial change: most hex characters differ.
    const differing = [...original].filter((c, i) => c !== mutated[i]).length;
    expect(differing).toBeGreaterThan(original.length / 2);
  });

  it("GENESIS_HASH is exactly 64 zero characters", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
    expect(GENESIS_HASH).toHaveLength(64);
  });

  it("computePayloadHash depends on canonical form, not key insertion order", () => {
    const a = computePayloadHash({ sku: "SKU_FOOD_001", qty: 2 });
    const b = computePayloadHash({ qty: 2, sku: "SKU_FOOD_001" });
    expect(a).toBe(b);
  });

  it("payload hash survives a JSON round trip", () => {
    // This is what makes verification survive a JSONB round trip: Postgres
    // stores jsonb keys sorted by length then bytes, discarding insertion
    // order, and JSON.parse/stringify does the same kind of reshuffling here.
    // canonical() sorts too, so the recomputed hash still matches.
    const payload = { sku: "SKU_FOOD_001", qty: 2 };
    const roundTripped: unknown = JSON.parse(JSON.stringify(payload));
    expect(computePayloadHash(roundTripped)).toBe(computePayloadHash(payload));
  });

  const BASE = {
    prevHash: GENESIS_HASH,
    seq: 1n,
    ts: new Date("2026-08-28T12:00:00.000Z"),
    actor: "system",
    eventType: "decision",
    payloadHash: computePayloadHash({ sku: "SKU_FOOD_001", qty: 1 }),
  };

  it("rejects a malformed prevHash", () => {
    expect(() => computeEntryHash({ ...BASE, prevHash: "short" })).toThrow(TypeError);
    // digest("hex") emits lowercase, so uppercase means the value came from
    // somewhere else — worth rejecting in the money path.
    expect(() => computeEntryHash({ ...BASE, prevHash: "A".repeat(64) })).toThrow(TypeError);
  });

  it("rejects a field containing the separator", () => {
    expect(() => computeEntryHash({ ...BASE, actor: "a|b" })).toThrow(TypeError);
    expect(() => computeEntryHash({ ...BASE, eventType: "a|b" })).toThrow(TypeError);
  });

  it("rejects an invalid date", () => {
    expect(() => computeEntryHash({ ...BASE, ts: new Date("nonsense") })).toThrow(RangeError);
  });

  it("rejects a non-positive seq", () => {
    expect(() => computeEntryHash({ ...BASE, seq: 0n })).toThrow(RangeError);
    expect(() => computeEntryHash({ ...BASE, seq: -1n })).toThrow(RangeError);
  });
});
