import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { computeEntryHash, GENESIS_HASH } from "@praman/ledger";

// Runs the real console script in a bare context, with just enough of a page, a grid
// and a chart library for it to load, to check what it does when it opens.

interface FakeNode {
  id: string;
  scrolled: number;
  [key: string]: unknown;
}

let dataSrc = "/demo/console.json";
let mode = "visitor";
/** The page's hashing script, when a test loads it beside the console's. */
let chainLib: unknown = undefined;

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
    getAttribute(name: string) { return name === "data-src" ? dataSrc : name === "data-mode" ? mode : null; },
    hidden: true,
    listeners: {} as Record<string, () => void>,
    addEventListener(type: string, fn: () => void) { (node["listeners"] as Record<string, () => void>)[type] = fn; },
    scrollIntoView() { node.scrolled += 1; },
  };
  return node;
}

const fetches = { count: 0 };

interface Row { seq: string; traceId: string; [key: string]: unknown }

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
    PramanChainVerify: chainLib,
  };
  const fetch = () => {
    fetches.count += 1;
    return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(data) });
  };
  byId("console");
  const source = readFileSync(new URL("../src/console/console.client.js", import.meta.url), "utf8");
  runInNewContext(source, { document, window, fetch, BigInt, Promise });
  setTimeout(settle, 20);
  return done.then(() => ({ grid: byId("grid"), quick: byId("quick"), count: byId("count"), chainText: byId("chain-text"), chainBrowser: byId("chain-browser"), chainBrowserRun: byId("chain-browser-run"), chainBrowserText: byId("chain-browser-text"), gridOptions, selected, visible }));
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

describe("the console as the public sample", () => {
  it("says the sample has no rows rather than telling a reader to run the demo", async () => {
    mode = "sample";
    const page = await openConsole("", []);
    mode = "visitor";
    expect(page.gridOptions["localeText"]).toEqual({ noRowsToShow: "The sample's mandates have no rows on this server's ledger." });
  });

  it("says the budget is withheld, not that the server lacks the mandate", () => {
    const source = readFileSync(new URL("../src/console/console.client.js", import.meta.url), "utf8");
    expect(source).toContain('mode === "sample" ? "The signed budget is withheld from this public page, so no budget line is drawn."');
  });
});

describe("rechecking the rows in the browser", () => {
  /** Three rows hashed by the ledger's own function: 1 and 2 are neighbours, 5 follows a gap. */
  function ledgerRows(): Row[] {
    const rows: Row[] = [];
    let prev = GENESIS_HASH;
    for (const seq of [1n, 2n, 5n]) {
      const ts = new Date(Date.UTC(2026, 10, 9, 10, 0, Number(seq), 7));
      const fields = { prevHash: seq === 5n ? "c".repeat(64) : prev, seq, ts, actor: "praman", eventType: "decision", payloadHash: "ab".repeat(32) };
      const entryHash = computeEntryHash(fields);
      rows.push({ seq: seq.toString(), traceId: "trc_a", ts: ts.toISOString(), actor: fields.actor, payloadHash: fields.payloadHash, prevHash: fields.prevHash, entryHash });
      prev = entryHash;
    }
    return rows;
  }

  function withLib<T>(work: () => Promise<T>): Promise<T> {
    const sandbox: { crypto: unknown; TextEncoder: unknown; PramanChainVerify?: unknown } = { crypto: webcrypto, TextEncoder };
    runInNewContext(readFileSync(new URL("../src/pages/chain-verify.client.js", import.meta.url), "utf8"), sandbox);
    chainLib = sandbox.PramanChainVerify;
    return work().finally(() => {
      chainLib = undefined;
    });
  }

  const press = async (page: Awaited<ReturnType<typeof openConsole>>) => {
    (page.chainBrowserRun["listeners"] as Record<string, () => void>)["click"]?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
  };

  it("recomputes each row's entry hash, checks links between neighbours, and says payloads were not rehashed", async () => {
    await withLib(async () => {
      // The grid's rows arrive newest first; the check puts them back in ledger order.
      const page = await openConsole("", ledgerRows().reverse());
      expect(page.chainBrowser["hidden"]).toBe(false);
      await press(page);
      expect(page.chainBrowserText.textContent).toBe(
        "Rechecked in this browser with WebCrypto. 3 entry hashes recomputed from the rows below, all matching. 2 links between neighbouring rows hold, and 1 could not be checked because the row before is not among these rows. Payloads are not sent to this page, so each payload hash is taken as recorded.",
      );
    });
  });

  it("says where a row no longer matches its hash", async () => {
    await withLib(async () => {
      const rows = ledgerRows();
      const forged = rows.map((r) => (r.seq === "2" ? { ...r, actor: "someone_else" } : r));
      const page = await openConsole("", forged);
      await press(page);
      expect(page.chainBrowserText.textContent).toBe("This browser's check fails at seq 2. This entry's own fields changed after it was written. (ENTRY_HASH_MISMATCH)");
    });
  });

  it("stays hidden when the browser has no WebCrypto, and asks the server for nothing more", async () => {
    fetches.count = 0;
    const page = await openConsole("", ledgerRows());
    expect(page.chainBrowser["hidden"]).toBe(true);
    expect(fetches.count).toBe(1);
  });
});
