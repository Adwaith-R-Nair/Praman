import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Two README sentences about how the eval was run were checked against git
// history by a reviewer and found false. Pin the corrected claims.

function readme(): string {
  return readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
}

describe("README eval methodology claims", () => {
  it("doesn't say the split predates every corpus case, since 32 cases came first", () => {
    const text = readme();
    expect(text).not.toContain("before any corpus case was added or fixed");
    expect(text).toContain("`090734b`");
  });

  it("doesn't say only planted faults have failed cases, since the corpus found a real crash", () => {
    const text = readme();
    expect(text).not.toContain("only when a fault was put in on purpose");
    expect(text).toContain("`c971f34`");
  });
});
