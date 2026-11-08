import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Runs the real console script in a bare context, with just enough of a page, a grid
// and a chart library for it to load, to check what it does when it opens.

interface FakeNode {
  id: string;
  scrolled: number;
  [key: string]: unknown;
}

let dataSrc = "/demo/console.json";

function fakeNode(id: string): FakeNode {
  const children: unknown[] = [];
  const node: FakeNode = {
    id,
    scrolled: 0,
    value: "",
    textContent: "",
    className: "",
    clientWidth: 800,
    get firstChild() { return children[0] ?? null; },
    appendChild(c: unknown) { children.push(c); return c; },
    removeChild(c: unknown) { children.splice(children.indexOf(c), 1); return c; },
    setAttribute() {},
    getAttribute(name: string) { return name === "data-src" ? dataSrc : name === "data-mode" ? "visitor" : null; },
    addEventListener() {},
    scrollIntoView() { node.scrolled += 1; },
  };
  return node;
}

const fetches = { count: 0 };

interface Row { seq: string; traceId: string }

function openConsole(hash: string, rows: Row[]) {
  const nodes = new Map<string, FakeNode>();
  const byId = (id: string) => {
    const found = nodes.get(id) ?? fakeNode(id);
    nodes.set(id, found);
    return found;
  };
  const selected: string[] = [];
  let gridOptions: Record<string, unknown> = {};
  const visible: number[] = [];
  let quick = "";
  const displayed = () => rows.filter((r) => quick === "" || r.traceId === quick);
  const gridApi = {
    setGridOption(key: string, value: string) { if (key === "quickFilterText") quick = value; },
    setFilterModel() {},
    getDisplayedRowCount: () => displayed().length,
    forEachNode(fn: () => void) { rows.forEach(() => fn()); },
    getDisplayedRowAtIndex(i: number) {
      const row = displayed()[i];
      return row ? { data: row, setSelected(on: boolean) { if (on) selected.push(row.seq); } } : undefined;
    },
    ensureIndexVisible(i: number) { visible.push(i); },
    getSelectedRows: () => [],
  };
  const data = {
    chain: { ok: true, checked: rows.length, head: "abc" },
    rows: rows.map((r) => ({ ...r, hashVerdict: "intact", eventType: "decision" })),
    truncated: false,
    spend: [],
    decisions: [],
    rails: [],
  };
  let settle: (v?: unknown) => void = () => {};
  const done = new Promise((resolve) => { settle = resolve; });
  const document = {
    getElementById: byId,
    createElement: (tag: string) => fakeNode(tag),
    currentScript: { nonce: "n" },
  };
  const window = {
    location: { hash },
    agGrid: { themeQuartz: { withParams: () => ({}) }, createGrid: (_el: unknown, options: Record<string, unknown>) => { gridOptions = options; return gridApi; } },
    agCharts: { AgCharts: { create: () => ({}) } },
  };
  const fetch = () => {
    fetches.count += 1;
    return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(data) });
  };
  byId("console");
  const source = readFileSync(new URL("../src/console/console.client.js", import.meta.url), "utf8");
  runInNewContext(source, { document, window, fetch, BigInt, Promise });
  setTimeout(settle, 20);
  return done.then(() => ({ grid: byId("grid"), quick: byId("quick"), count: byId("count"), chainText: byId("chain-text"), gridOptions, selected, visible }));
}

const ROWS: Row[] = [
  { seq: "3", traceId: "trc_b" },
  { seq: "2", traceId: "trc_revoke" },
  { seq: "1", traceId: "trc_a" },
];

describe("the console opened from a trace link", () => {
  it("filters to the trace, scrolls the grid into view and selects its first row", async () => {
    const page = await openConsole("#trace=trc_revoke", ROWS);
    expect(page.quick.value).toBe("trc_revoke");
    expect(page.count.textContent).toBe("1 of 3 rows");
    expect(page.grid.scrolled).toBe(1);
    expect(page.selected).toEqual(["2"]);
    expect(page.visible).toEqual([0]);
  });

  it("opened without a trace, it leaves the page at the top and selects nothing", async () => {
    const page = await openConsole("", ROWS);
    expect(page.grid.scrolled).toBe(0);
    expect(page.selected).toEqual([]);
  });

  it("a trace that matches no row selects nothing and does not throw", async () => {
    const page = await openConsole("#trace=trc_none", ROWS);
    expect(page.count.textContent).toBe("0 of 3 rows");
    expect(page.selected).toEqual([]);
  });
});

describe("the spend chart's time axis", () => {
  it("names UTC and formats in it, like the grid", () => {
    const source = readFileSync(new URL("../src/console/console.client.js", import.meta.url), "utf8");
    expect(source).toContain('title: { text: "Time (UTC)"');
    expect(source).toContain("new Date(p.value).toISOString().slice(11, 16)");
  });
});

describe("the console with no session", () => {
  it("asks the server for nothing and says what to do", async () => {
    dataSrc = "";
    fetches.count = 0;
    const page = await openConsole("", []);
    dataSrc = "/demo/console.json";
    expect(fetches.count).toBe(0);
    expect(page.chainText.textContent).toContain("Start one at /demo");
  });
});

describe("the console with nothing in it yet", () => {
  it("says what to do instead of the grid's own message, and doesn't count zero rows", async () => {
    const page = await openConsole("", []);
    expect(page.gridOptions["localeText"]).toEqual({ noRowsToShow: "No rows yet. Run a step of the demo and its rows appear here." });
    expect(page.chainText.textContent).toContain("There are no rows below yet.");
    expect(page.chainText.textContent).not.toContain("Of the 0 rows");
  });
});
