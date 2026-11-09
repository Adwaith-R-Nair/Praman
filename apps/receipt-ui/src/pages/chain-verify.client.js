// Recomputes ledger hashes in the browser, with WebCrypto, from rows the page already
// holds. It asks the server for nothing: there is no fetch in this file. The formula is
// the ledger's own (packages/ledger/src/chain.ts):
//
//   payload_hash = sha256(canonical JSON of the payload), hex
//   entry_hash   = sha256(prev_hash | seq | ts | actor | event_type | payload_hash), hex
//
// with a literal "|" between fields, the whole string encoded as UTF-8. Every field is
// used as the text the server sent: seq as its decimal digits and ts as its ISO string,
// so nothing is parsed into a number or a date and printed back differently.
//
// A row is { seq, ts, actor, eventType, payloadHash, prevHash, entryHash, payloadText,
// withheld }. payloadText is the payload's canonical JSON, or null when the page doesn't
// hold the whole payload. withheld names payload fields the public copy leaves out
// (D-84); with any withheld the payload can't be rehashed, and this says so instead of
// reporting a result.
(function (root) {
  "use strict";

  var GENESIS_HASH = new Array(65).join("0");
  var HEX64 = /^[0-9a-f]{64}$/;
  var SEQ = /^[1-9][0-9]*$/;
  // What Date.prototype.toISOString() gives for any year from 0000 to 9999.
  var ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

  // The server's own break reasons (verifyChain), in the trace page's words.
  var BREAK_PLAIN = {
    PREV_MISMATCH: "This entry doesn't link to the one that comes before it.",
    PAYLOAD_HASH_MISMATCH: "This entry's contents changed after it was written.",
    ENTRY_HASH_MISMATCH: "This entry's own fields changed after it was written.",
  };

  function toHex(buffer) {
    var bytes = new Uint8Array(buffer);
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return out;
  }

  function sha256Hex(text) {
    return root.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(toHex);
  }

  // The string computeEntryHash() hashes, or null when a field isn't in the fixed form
  // the server insists on before hashing. A row like that can't match anything.
  function entryPreimage(row) {
    if (!row || typeof row.prevHash !== "string" || !HEX64.test(row.prevHash)) return null;
    if (typeof row.payloadHash !== "string" || !HEX64.test(row.payloadHash)) return null;
    if (typeof row.seq !== "string" || !SEQ.test(row.seq)) return null;
    if (typeof row.ts !== "string" || !ISO.test(row.ts)) return null;
    if (typeof row.actor !== "string" || row.actor.indexOf("|") !== -1) return null;
    if (typeof row.eventType !== "string" || row.eventType.indexOf("|") !== -1) return null;
    return [row.prevHash, row.seq, row.ts, row.actor, row.eventType, row.payloadHash].join("|");
  }

  // True when b is the seq right after a. Compared as integers of any size, never as floats.
  function follows(a, b) {
    return SEQ.test(a) && SEQ.test(b) && BigInt(b) === BigInt(a) + BigInt(1);
  }

  // Checks every row and reports the first that fails, in the order verifyChain() checks:
  // the link to the row before, then the payload, then the row's own fields.
  // A link is checked only between rows whose seqs are neighbours. The ledger is one
  // chain shared by every trace, so a page showing one trace may not hold the row before.
  function verifyRows(rows) {
    return Promise.all(
      rows.map(function (row) {
        var preimage = entryPreimage(row);
        return Promise.all([
          preimage === null ? Promise.resolve(null) : sha256Hex(preimage),
          typeof row.payloadText === "string" ? sha256Hex(row.payloadText) : Promise.resolve(null),
        ]);
      }),
    ).then(function (hashes) {
      var counts = { entries: 0, payloadsRehashed: 0, payloadsWithheld: 0, payloadsNotHeld: 0, links: 0, linksNotChecked: 0 };
      var brokenAt = null;
      var reason = null;
      var results = rows.map(function (row, i) {
        var recomputedEntryHash = hashes[i][0];
        var recomputedPayloadHash = hashes[i][1];
        var prev = i > 0 ? rows[i - 1] : null;

        var link = "unchecked";
        if (row.seq === "1") link = row.prevHash === GENESIS_HASH ? "match" : "mismatch";
        else if (prev !== null && follows(prev.seq, row.seq)) link = row.prevHash === prev.entryHash ? "match" : "mismatch";

        var payload;
        if (recomputedPayloadHash !== null) payload = recomputedPayloadHash === row.payloadHash ? "match" : "mismatch";
        else payload = row.withheld && row.withheld.length > 0 ? "withheld" : "not_held";

        var entry = recomputedEntryHash !== null && recomputedEntryHash === row.entryHash ? "match" : "mismatch";

        counts.entries += 1;
        if (link === "unchecked") counts.linksNotChecked += 1;
        else counts.links += 1;
        if (payload === "withheld") counts.payloadsWithheld += 1;
        else if (payload === "not_held") counts.payloadsNotHeld += 1;
        else counts.payloadsRehashed += 1;

        var failed = link === "mismatch" ? "PREV_MISMATCH" : payload === "mismatch" ? "PAYLOAD_HASH_MISMATCH" : entry === "mismatch" ? "ENTRY_HASH_MISMATCH" : null;
        if (failed !== null && brokenAt === null) {
          brokenAt = row.seq;
          reason = failed;
        }
        return { seq: row.seq, link: link, payload: payload, entry: entry, recomputedEntryHash: recomputedEntryHash, recomputedPayloadHash: recomputedPayloadHash, failed: failed };
      });
      return { ok: brokenAt === null, brokenAt: brokenAt, reason: reason, reasonPlain: reason === null ? null : BREAK_PLAIN[reason], rows: results, counts: counts };
    });
  }

  function copyRow(row) {
    return {
      seq: row.seq,
      ts: row.ts,
      actor: row.actor,
      eventType: row.eventType,
      payloadHash: row.payloadHash,
      prevHash: row.prevHash,
      entryHash: row.entryHash,
      payloadText: row.payloadText,
      withheld: row.withheld ? row.withheld.slice() : [],
    };
  }

  // The next digit character, 9 wrapping to 0. A character swap, not arithmetic.
  function otherDigit(d) {
    return "1234567890".charAt("0123456789".indexOf(d));
  }

  // A copy of the rows with one digit changed in one row, and what was changed. The rows
  // passed in are left as they were. It prefers an amount in a payload this page holds
  // in full, since that is the change a forger would want; with none, it changes the
  // last digit of the first row's time. Returns null when there is nothing to change.
  function tamperOneDigit(rows) {
    var copies = rows.map(copyRow);
    for (var i = 0; i < copies.length; i++) {
      var text = copies[i].payloadText;
      if (typeof text !== "string") continue;
      var match = /"amount_minor":"([0-9]+)"/.exec(text);
      if (!match) continue;
      var before = match[1];
      var after = before.slice(0, -1) + otherDigit(before.charAt(before.length - 1));
      copies[i].payloadText = text.slice(0, match.index) + '"amount_minor":"' + after + '"' + text.slice(match.index + match[0].length);
      return { rows: copies, seq: copies[i].seq, field: "amount_minor", before: before, after: after };
    }
    for (var j = 0; j < copies.length; j++) {
      var ts = copies[j].ts;
      if (typeof ts !== "string" || !ISO.test(ts)) continue;
      var changed = ts.slice(0, -2) + otherDigit(ts.charAt(ts.length - 2)) + "Z";
      copies[j].ts = changed;
      return { rows: copies, seq: copies[j].seq, field: "ts", before: ts, after: changed };
    }
    return null;
  }

  root.PramanChainVerify = {
    GENESIS_HASH: GENESIS_HASH,
    BREAK_PLAIN: BREAK_PLAIN,
    available: function () {
      return !!(root.crypto && root.crypto.subtle && typeof TextEncoder === "function" && typeof BigInt === "function");
    },
    sha256Hex: sha256Hex,
    entryPreimage: entryPreimage,
    verifyRows: verifyRows,
    tamperOneDigit: tamperOneDigit,
  };
})(typeof window !== "undefined" ? window : globalThis);
