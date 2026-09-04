import { describe, expect, it } from "vitest";
import { merkleRoot } from "../src/merkle.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

describe("merkleRoot", () => {
  it("single leaf — root is sha256(0x00 || leaf)", () => {
    // Pinned. If this changes, the domain-separation prefix changed.
    expect(merkleRoot([A])).toBe("020d9203c5d9653dc417be1cb97f2152bdb9929e9b0fb8c4baca3f16ec08d28a");
  });

  it("two leaves — root is sha256(0x01 || left || right)", () => {
    expect(merkleRoot([A, B])).toBe("52fad40890354579bd06a13124bce6de5f5e49eae3f068a9eead452abfe8f7ba");
  });

  it("odd count — the final leaf is duplicated to pair with itself", () => {
    expect(merkleRoot([A, B, C])).toBe("7ae57ff5af707af947e9ae72f226322c141e84864d3faaf0ecac6d0fb8542891");
  });

  it("leaf order changes the root", () => {
    expect(merkleRoot([A, B])).not.toBe(merkleRoot([B, A]));
  });

  it("rejects an empty range", () => {
    expect(() => merkleRoot([])).toThrow(RangeError);
  });

  it("returns a 64-char lowercase hex digest for a larger, non-power-of-two set", () => {
    const leaves = Array.from({ length: 7 }, (_, i) => i.toString().repeat(64).slice(0, 64));
    const root = merkleRoot(leaves);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
  });
});
