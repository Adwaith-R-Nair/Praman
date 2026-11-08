// The console page's script. It fetches the ledger rows this visitor may see, as JSON
// from this server, and draws them with AG Grid Community and AG Charts Community,
// both served from this server. Every value from the ledger goes into the page as
// text: no cell, tooltip or panel here is built from an HTML string. Money is never
// added up here; amounts arrive formatted by the server, and the minor-unit numbers
// are used only to sort and to place points on a chart.
(function () {
  "use strict";

  var root = document.getElementById("console");
  if (!root || !window.agGrid || !window.agCharts) return;
  var script = document.currentScript;
  // AG Grid and AG Charts put their styles in <style> elements. The page's policy lets
  // one apply only if it carries this response's nonce, which they are given here.
  var nonce = (script && script.nonce) || "";
  var source = root.getAttribute("data-src") || "";

  var INK = { ink: "#172420", muted: "#4b5b55", hairline: "#c7d0c9", seal: "#24496b", allow: "#2e6b4c", stepUp: "#8a5f22", deny: "#9e3b2e", paper: "#f6f8f6", neutral: "#7a8a84", returned: "#6b8796" };
  var RAIL_NAMES = { paypal: "PayPal", razorpay: "Razorpay", simulated: "Simulated" };
  var STATUS_COLOURS = { captured: INK.allow, created: INK.seal, released: INK.neutral, refunded: INK.returned, failed: INK.deny, mismatch: INK.stepUp };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function shortHash(h) {
    return h ? h.slice(0, 12) + "…" : "";
  }

  // Minor units to a display string, from the digits alone: no division, no float.
  function minorLabel(minorNumber, currency) {
    var digits = String(Math.max(0, Math.round(minorNumber)));
    while (digits.length < 3) digits = "0" + digits;
    var symbol = currency === "INR" ? "₹" : "$";
    return symbol + digits.slice(0, -2) + "." + digits.slice(-2);
  }

  function compareMinor(a, b) {
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    var x = BigInt(a);
    var y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  // ── Chain banner and totals ──────────────────────────────────────

  function renderChain(chain, rows) {
    var box = document.getElementById("chain");
    var stamp = document.getElementById("chain-stamp");
    var text = document.getElementById("chain-text");
    var intact = rows.filter(function (r) { return r.hashVerdict === "intact"; }).length;
    var own = rows.length === 0 ? " There are no rows below yet." : " Of the " + rows.length + " rows below, " + intact + " pass their own check.";
    if (chain.ok) {
      box.setAttribute("data-state", "ok");
      stamp.textContent = "Chain verified";
      text.textContent = "All " + chain.checked + " rows of the ledger were rehashed from the first one, and every link holds. Head " + shortHash(chain.head) + "." + own;
    } else {
      box.setAttribute("data-state", "broken");
      stamp.textContent = "Chain broken";
      text.textContent = "The walk from the first row stopped at seq " + chain.brokenAtSeq + ": " + (chain.breakReasonPlain || chain.breakReason) + " Rows from there on can't be trusted." + own;
    }
  }

  function renderTiles(data) {
    var tiles = document.getElementById("tiles");
    clear(tiles);
    var traces = {};
    var decisions = 0;
    var refused = 0;
    data.rows.forEach(function (r) {
      traces[r.traceId] = true;
      if (r.eventType === "decision" || r.eventType === "capture_decision") {
        decisions += 1;
        if (r.decision === "DENY") refused += 1;
      }
    });
    var items = [
      [String(data.rows.length), data.truncated ? "rows, the newest only" : "ledger rows"],
      [String(Object.keys(traces).length), "traces"],
      [String(decisions), "decisions"],
      [String(refused), "refused"],
    ];
    data.spend.forEach(function (s) {
      items.push([s.spentNowLabel, (s.budgetLabel ? "of " + s.budgetLabel + " " : "") + "spent or held, " + s.mandateId + (s.revoked ? ", revoked" : "")]);
    });
    items.forEach(function (item) {
      var tile = el("div", "tile");
      tile.appendChild(el("span", "tile-n", item[0]));
      tile.appendChild(el("span", "tile-label", item[1]));
      tiles.appendChild(tile);
    });
  }

  // ── Grid ─────────────────────────────────────────────────────────

  var gridApi = null;

  function traceLink(params) {
    if (!params.data) return null;
    var a = document.createElement("a");
    a.href = "/r/" + encodeURIComponent(params.data.traceId);
    a.textContent = "open";
    a.setAttribute("aria-label", "Open trace " + params.data.traceId);
    return a;
  }

  var columnDefs = [
    { headerName: "Seq", field: "seq", width: 84, pinned: "left", filter: "agNumberColumnFilter", valueGetter: function (p) { return p.data ? Number(p.data.seq) : null; }, sort: "desc" },
    { headerName: "Time (UTC)", field: "ts", width: 172, filter: "agTextColumnFilter", valueFormatter: function (p) { return p.value ? p.value.replace("T", " ").slice(0, 19) : ""; } },
    { headerName: "Event", field: "eventPlain", width: 220, tooltipField: "eventType", filter: "agTextColumnFilter" },
    { headerName: "Mandate", field: "mandateId", width: 200, valueFormatter: function (p) { return p.data && p.data.mandateClaimed ? p.value + " (claimed, unverified)" : p.value || ""; } },
    { headerName: "Merchant", field: "merchantId", width: 140 },
    {
      headerName: "Amount",
      field: "amountMinor",
      width: 112,
      type: "rightAligned",
      comparator: compareMinor,
      valueFormatter: function (p) { return p.data && p.data.amount ? p.data.amount : ""; },
      filterValueGetter: function (p) { return p.data && p.data.amount ? p.data.amount : ""; },
      getQuickFilterText: function (p) { return p.data && p.data.amount ? p.data.amount : ""; },
    },
    { headerName: "Cur.", field: "currency", width: 76 },
    {
      headerName: "Decision",
      field: "decision",
      width: 116,
      cellClassRules: {
        "cell-allow": function (p) { return p.value === "ALLOW" || p.value === "APPROVED"; },
        "cell-step-up": function (p) { return p.value === "STEP_UP"; },
        "cell-deny": function (p) { return p.value === "DENY" || p.value === "REJECTED" || p.value === "REVOKED"; },
      },
    },
    { headerName: "Status", field: "status", width: 110 },
    { headerName: "Reason code", field: "reasonCode", width: 220, tooltipField: "reasonPlain", cellClass: "cell-code" },
    { headerName: "In plain words", field: "reasonPlain", width: 300, flex: 1, minWidth: 220 },
    { headerName: "Rail", field: "rail", width: 100, valueFormatter: function (p) { return p.value ? RAIL_NAMES[p.value] || p.value : ""; } },
    { headerName: "Order id", field: "orderId", width: 170, cellClass: "cell-code" },
    { headerName: "Capture id", field: "captureId", width: 170, cellClass: "cell-code" },
    { headerName: "Refund id", field: "refundId", width: 170, cellClass: "cell-code" },
    {
      headerName: "Hash check",
      field: "hashVerdict",
      width: 128,
      pinned: "right",
      valueGetter: function (p) { return p.data ? (p.data.chainVerified ? p.data.hashVerdict : p.data.hashVerdict + ", after break") : null; },
      cellClassRules: {
        "cell-allow": function (p) { return p.data && p.data.hashVerdict === "intact" && p.data.chainVerified; },
        "cell-deny": function (p) { return p.data && (p.data.hashVerdict !== "intact" || !p.data.chainVerified); },
      },
    },
    { headerName: "Trace", field: "traceId", width: 88, pinned: "right", cellRenderer: traceLink, sortable: false, getQuickFilterText: function (p) { return p.value || ""; } },
  ];

  function hashLine(dl, label, stored, recomputed, ok) {
    dl.appendChild(el("dt", null, label));
    var dd = el("dd");
    dd.appendChild(el("span", ok === true ? "pass" : ok === false ? "fail" : "unknown", ok === true ? "matches" : ok === false ? "does not match" : "not checked"));
    dd.appendChild(el("code", "hash", "stored " + stored));
    if (recomputed !== null && recomputed !== undefined) dd.appendChild(el("code", "hash", "recomputed " + recomputed));
    dl.appendChild(dd);
  }

  function showDetail(row) {
    var box = document.getElementById("detail");
    clear(box);
    if (!row) {
      box.appendChild(el("p", "detail-empty", "Select a row to see its hash check."));
      return;
    }
    var head = el("div", "detail-head");
    head.appendChild(el("h3", null, "Seq " + row.seq + ": " + row.eventPlain));
    var link = document.createElement("a");
    link.href = "/r/" + encodeURIComponent(row.traceId);
    link.textContent = "Open trace " + row.traceId;
    head.appendChild(link);
    box.appendChild(head);
    box.appendChild(el("p", "detail-note", "Recomputed on the server from the row as stored, with the same hash functions the ledger writes with. The link check compares this row's prev hash with the entry hash of the row before it."));
    var dl = el("dl", "hashes");
    hashLine(dl, "Payload hash", row.payloadHash, row.check.recomputedPayloadHash, row.check.payloadIntact);
    hashLine(dl, "Entry hash", row.entryHash, row.check.recomputedEntryHash, row.check.fieldsIntact);
    hashLine(dl, "Link to seq " + (Number(row.seq) - 1), row.prevHash, null, row.check.linked);
    dl.appendChild(el("dt", null, "Chain walk"));
    var walk = el("dd");
    walk.appendChild(el("span", row.chainVerified ? "pass" : "fail", row.chainVerified ? "confirmed" : "not confirmed"));
    walk.appendChild(el("span", "walk-note", row.chainVerified ? "Reached by the walk from the first row." : "After the break: the walk from the first row did not reach this row intact."));
    dl.appendChild(walk);
    box.appendChild(dl);
  }

  function updateCount() {
    if (!gridApi) return;
    var shown = gridApi.getDisplayedRowCount();
    var total = 0;
    gridApi.forEachNode(function () { total += 1; });
    document.getElementById("count").textContent = shown === total ? total + " rows" : shown + " of " + total + " rows";
  }

  function makeGrid(rows) {
    if (window.agGrid.ModuleRegistry && window.agGrid.AllCommunityModule) window.agGrid.ModuleRegistry.registerModules([window.agGrid.AllCommunityModule]);
    var theme = window.agGrid.themeQuartz.withParams({
      fontFamily: '"IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace',
      headerFontFamily: '"PT Serif", Georgia, serif',
      fontSize: 12.5,
      headerFontSize: 13,
      backgroundColor: INK.paper,
      foregroundColor: INK.ink,
      headerBackgroundColor: "#e4eae6",
      headerTextColor: INK.ink,
      borderColor: INK.hairline,
      accentColor: INK.seal,
      oddRowBackgroundColor: "#f0f3f1",
      rowHoverColor: "#e6ece8",
      selectedRowBackgroundColor: "#dfe7ef",
      spacing: 6,
      wrapperBorderRadius: 0,
    });
    var options = {
      theme: theme,
      styleNonce: nonce,
      rowData: rows,
      columnDefs: columnDefs,
      defaultColDef: { sortable: true, resizable: true, filter: "agTextColumnFilter", tooltipShowDelay: 300 },
      getRowId: function (p) { return p.data.seq; },
      rowSelection: { mode: "singleRow", checkboxes: false, enableClickSelection: true },
      enableCellTextSelection: true,
      ensureDomOrder: true,
      tooltipShowDelay: 300,
      animateRows: false,
      // The grid's own empty message is "No Rows To Show". Say what to do instead.
      localeText: {
        noRowsToShow: root.getAttribute("data-mode") === "visitor" ? "No rows yet. Run a step of the demo and its rows appear here." : "No ledger rows yet.",
      },
      onSelectionChanged: function (e) {
        var picked = e.api.getSelectedRows();
        showDetail(picked[0] || null);
      },
      onModelUpdated: updateCount,
    };
    gridApi = window.agGrid.createGrid(document.getElementById("grid"), options);
  }

  function filterTo(column, value) {
    if (!gridApi) return;
    var model = {};
    model[column] = { filterType: "text", type: "equals", filter: value };
    gridApi.setFilterModel(model);
    document.getElementById("grid").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ── Charts ───────────────────────────────────────────────────────

  var spendChart = null;

  function chartBase(containerId) {
    return {
      container: document.getElementById(containerId),
      styleNonce: nonce,
      background: { fill: INK.paper },
      padding: { top: 12, right: 16, bottom: 8, left: 8 },
      theme: {
        params: { fontFamily: '"IBM Plex Mono", Menlo, monospace', fontSize: 11, foregroundColor: INK.ink, backgroundColor: INK.paper },
      },
    };
  }

  function emptyNote(containerId, message) {
    var box = document.getElementById(containerId);
    clear(box);
    box.appendChild(el("p", "chart-empty", message));
  }

  function drawSpend(series) {
    var select = document.getElementById("spend-mandate");
    var note = document.getElementById("spend-note");
    if (!series) {
      emptyNote("chart-spend", "No money has been held or spent under these mandates yet.");
      return;
    }
    var data = series.points.map(function (p) {
      return { time: new Date(p.ts), held: Number(p.heldMinor), label: p.label, seq: p.seq };
    });
    if (data.length === 0) {
      emptyNote("chart-spend", "Nothing spent or held under " + series.mandateId + " yet.");
      return;
    }
    var budget = series.budgetMinor === null ? null : Number(series.budgetMinor);
    note.textContent = series.budgetLabel
      ? "Spent or held under " + series.mandateId + ", row by row, against its signed budget of " + series.budgetLabel + ". Now " + series.spentNowLabel + ", the number Praman's policy reads." + (series.revoked ? " This mandate is revoked." : "")
      : "Spent or held under " + series.mandateId + ", row by row. Now " + series.spentNowLabel + ". This server doesn't hold the signed mandate, so no budget line is drawn." + (series.revoked ? " This mandate is revoked." : "");
    var maxHeld = data.reduce(function (m, d) { return d.held > m ? d.held : m; }, 0);
    var options = chartBase("chart-spend");
    options.data = data;
    options.series = [
      {
        type: "line",
        xKey: "time",
        yKey: "held",
        yName: "Spent or held",
        interpolation: { type: "step", position: "end" },
        stroke: INK.seal,
        strokeWidth: 2,
        marker: { enabled: true, size: 7, fill: INK.seal, stroke: INK.paper },
        tooltip: {
          renderer: function (p) {
            return { heading: p.datum.time.toISOString().replace("T", " ").slice(0, 19) + " UTC", title: "After seq " + p.datum.seq, data: [{ label: "Spent or held", value: p.datum.label }] };
          },
        },
      },
    ];
    options.axes = {
      x: { type: "time", position: "bottom", label: { color: INK.muted } },
      y: {
        type: "number",
        position: "left",
        min: 0,
        max: budget !== null ? Math.max(budget, maxHeld) * 1.1 : undefined,
        label: { color: INK.muted, formatter: function (p) { return minorLabel(p.value, series.currency); } },
        crossLines: budget === null ? [] : [{ type: "line", value: budget, stroke: INK.deny, strokeWidth: 1.5, lineDash: [6, 4], label: { text: "Budget " + series.budgetLabel, position: "top-right", color: INK.deny } }],
      },
    };
    options.legend = { enabled: false };
    if (spendChart) spendChart.destroy();
    clear(document.getElementById("chart-spend"));
    spendChart = window.agCharts.AgCharts.create(options);
    select.value = series.mandateId;
  }

  function drawReasons(decisions) {
    if (decisions.length === 0) {
      emptyNote("chart-reasons", "No decisions yet.");
      return;
    }
    var options = chartBase("chart-reasons");
    options.data = decisions.map(function (d) { return { code: d.reasonCode, plain: d.reasonPlain || d.reasonCode, allow: d.allow, stepUp: d.stepUp, deny: d.deny }; });
    function bar(key, name, colour) {
      return {
        type: "bar",
        direction: "horizontal",
        xKey: "code",
        yKey: key,
        yName: name,
        stacked: true,
        fill: colour,
        tooltip: { renderer: function (p) { return { heading: p.datum.code, title: name, data: [{ label: "Rows", value: String(p.datum[key]) }, { label: "Means", value: p.datum.plain }] }; } },
      };
    }
    options.series = [bar("allow", "Allowed", INK.allow), bar("stepUp", "Asked a person", INK.stepUp), bar("deny", "Refused", INK.deny)];
    // Long codes wrap at a fixed width rather than being cut off on a phone.
    var narrow = document.getElementById("chart-reasons").clientWidth < 520;
    options.axes = {
      x: { type: "category", position: "left", thickness: narrow ? 120 : 230, label: { color: INK.ink, wrapping: "hyphenate" } },
      y: { type: "number", position: "bottom", label: { color: INK.muted } },
    };
    options.legend = { position: "bottom" };
    options.height = Math.max(220, (narrow ? 46 : 34) * decisions.length + 90);
    options.listeners = { seriesNodeClick: function (e) { filterTo("reasonCode", e.datum.code); } };
    window.agCharts.AgCharts.create(options);
  }

  function drawRails(rails) {
    if (rails.length === 0) {
      emptyNote("chart-rails", "No orders yet.");
      return;
    }
    var statuses = [];
    rails.forEach(function (r) {
      Object.keys(r.statuses).forEach(function (s) { if (statuses.indexOf(s) === -1) statuses.push(s); });
    });
    var options = chartBase("chart-rails");
    options.data = rails.map(function (r) {
      var d = { rail: RAIL_NAMES[r.rail] || r.rail, key: r.rail };
      statuses.forEach(function (s) { d[s] = r.statuses[s] || 0; });
      return d;
    });
    options.series = statuses.map(function (s) {
      return {
        type: "bar",
        xKey: "rail",
        yKey: s,
        yName: s,
        stacked: true,
        fill: STATUS_COLOURS[s] || INK.neutral,
        tooltip: { renderer: function (p) { return { heading: p.datum.rail, title: s, data: [{ label: "Orders", value: String(p.datum[s]) }] }; } },
      };
    });
    options.axes = { x: { type: "category", position: "bottom", label: { color: INK.ink } }, y: { type: "number", position: "left", label: { color: INK.muted } } };
    options.legend = { position: "bottom" };
    options.listeners = { seriesNodeClick: function (e) { filterTo("rail", e.datum.key); } };
    window.agCharts.AgCharts.create(options);
  }

  function setupSpend(spend) {
    var select = document.getElementById("spend-mandate");
    clear(select);
    spend.forEach(function (s) {
      var option = document.createElement("option");
      option.value = s.mandateId;
      option.textContent = s.mandateId + (s.budgetLabel ? ", budget " + s.budgetLabel : "");
      select.appendChild(option);
    });
    select.disabled = spend.length < 2;
    select.addEventListener("change", function () {
      drawSpend(spend.filter(function (s) { return s.mandateId === select.value; })[0] || null);
    });
    // The first mandate listed (a visitor's story mandate) if it has spent anything, else the busiest.
    var first = spend.filter(function (s) { return s.points.length > 1; })[0] || spend.slice().sort(function (a, b) { return b.points.length - a.points.length; })[0] || null;
    drawSpend(first);
  }

  // ── Wiring ───────────────────────────────────────────────────────

  function render(data) {
    renderChain(data.chain, data.rows);
    renderTiles(data);
    makeGrid(data.rows);
    setupSpend(data.spend);
    drawReasons(data.decisions);
    drawRails(data.rails);

    var quick = document.getElementById("quick");
    quick.addEventListener("input", function () { gridApi.setGridOption("quickFilterText", quick.value); });
    document.getElementById("reset").addEventListener("click", function () {
      quick.value = "";
      gridApi.setGridOption("quickFilterText", "");
      gridApi.setFilterModel(null);
    });
    // A trace page links here as #trace=<id>, to open the console at that trace's rows.
    var match = /^#trace=(.+)$/.exec(window.location.hash);
    if (match) {
      quick.value = decodeURIComponent(match[1]);
      gridApi.setGridOption("quickFilterText", quick.value);
      // Take the reader to those rows and open the first one's hash check, so the link
      // lands on the trace rather than on the charts at the top of the page.
      var firstRow = gridApi.getDisplayedRowAtIndex(0);
      if (firstRow) {
        firstRow.setSelected(true);
        gridApi.ensureIndexVisible(0);
      }
      document.getElementById("grid").scrollIntoView({ block: "start" });
    }
    updateCount();
  }

  function fail(message) {
    var box = document.getElementById("chain");
    box.setAttribute("data-state", "broken");
    document.getElementById("chain-stamp").textContent = "Not loaded";
    document.getElementById("chain-text").textContent = message;
  }

  // With no session the server leaves data-src empty, so there is nothing to ask for.
  if (source === "") {
    fail("Your demo session has ended or hasn't started. Start one at /demo, then come back.");
    return;
  }

  fetch(source, { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(function (res) {
      if (res.status === 401) throw new Error("Your demo session has ended or hasn't started. Start one at /demo, then come back.");
      if (res.status === 429) throw new Error("Too many console loads in the last minute. Wait a minute and reload.");
      if (!res.ok) throw new Error("The server couldn't load the ledger just now. Reload in a moment.");
      return res.json();
    })
    .then(render)
    .catch(function (err) {
      fail(err && err.message ? err.message : "The ledger couldn't be loaded.");
    });
})();
