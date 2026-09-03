/**
 * Ledger payloads must be JSON-safe. Prisma serialises them to jsonb with
 * JSON.stringify, which throws on bigint — so an amount must arrive as a
 * decimal string (paiseToJSON), not as a Paise. Same convention as D-09.
 *
 * Checked rather than documented: a payload that hashes cleanly and then
 * fails on insert would leave the chain lock held and the error confusing.
 */
export function assertLedgerPayload(value: unknown, path = "payload"): void {
  if (value === null) return;

  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${path}: non-finite number`);
      if (!Number.isInteger(value)) throw new TypeError(`${path}: non-integer number`);
      return;
    case "bigint":
      throw new TypeError(`${path}: bigint is not JSON-safe — use paiseToJSON()`);
    case "undefined":
      throw new TypeError(`${path}: undefined is not serialisable`);
    case "object":
      break;
    default:
      throw new TypeError(`${path}: ${typeof value} is not serialisable`);
  }

  if (Array.isArray(value)) {
    value.forEach((v, i) => assertLedgerPayload(v, `${path}[${i}]`));
    return;
  }
  if (value instanceof Date) throw new TypeError(`${path}: Date must be an ISO string`);

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertLedgerPayload(v, `${path}.${k}`);
  }
}
