/**
 * Deterministic JSON. Same logical value → identical bytes, always.
 * Used for signature preimages and idempotency keys, so any change
 * here invalidates every existing signature and key.
 */
export function canonical(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return `"${value.toString()}"`;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Non-finite number");
      if (!Number.isInteger(value)) throw new TypeError("Non-integer number");
      return value.toString();
    case "string":
      return JSON.stringify(value);
    case "undefined":
      throw new TypeError("undefined is not serialisable");
    case "object":
      break;
    default:
      throw new TypeError(`Not serialisable: ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}