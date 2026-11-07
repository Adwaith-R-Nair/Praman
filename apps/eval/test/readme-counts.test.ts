import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The README states how many decision records exist. That number was typed
// by hand and went stale twice (24, then 47 when there were 48), so pin it to
// the headings actually in docs/DECISIONS.md.

function readRepoFile(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");
}

describe("README decision record count", () => {
  it("matches the number of D- headings in docs/DECISIONS.md", () => {
    const decisions = readRepoFile("docs/DECISIONS.md");
    const headings = decisions.match(/^#+ D-\d+\b/gm) ?? [];
    const readme = readRepoFile("README.md");
    const stated = /^(\d+) records in \[`docs\/DECISIONS\.md`\]/m.exec(readme);
    expect(stated).not.toBeNull();
    expect(Number(stated?.[1])).toBe(headings.length);
  });
});
