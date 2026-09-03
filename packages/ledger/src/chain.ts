import { createHash } from "node:crypto";
import { canonical } from "@praman/shared";

/**
 * The `prevHash` of the first entry in a chain. Not a real hash of anything —
 * a fixed sentinel so the genesis entry's hash computation has a defined
 * input instead of a special-cased branch.
 */
export const GENESIS_HASH = "0".repeat(64);

const HEX64 = /^[0-9a-f]{64}$/;

/** sha256(canonical(payload)), hex, lowercase. */
export function computePayloadHash(payload: unknown): string {
  return createHash("sha256").update(canonical(payload), "utf8").digest("hex");
}

/**
 * sha256(prevHash | seq | ts.toISOString() | actor | eventType | payloadHash),
 * hex, lowercase. The literal `|` between every field exists so that no two
 * distinct sets of field values can concatenate to the same preimage — see
 * the "separator ambiguity" test. This construction is only safe because
 * every field here is fixed-format (a hex hash, a decimal integer, an ISO
 * timestamp) or drawn from a controlled identifier set; a free-form field
 * would need length-prefixing instead, since a literal `|` inside it would
 * shift the field boundaries the same way omitting the separator entirely would.
 */
export function computeEntryHash(fields: {
  prevHash: string;
  seq: bigint;
  ts: Date;
  actor: string;
  eventType: string;
  payloadHash: string;
}): string {
  // The pipe-delimited construction above is only unambiguous while no field
  // can contain a pipe. Every field here is fixed-format (lowercase hex,
  // decimal integer, ISO-8601) or drawn from a controlled identifier set —
  // but that's a precondition, so it's checked here rather than assumed.
  if (!HEX64.test(fields.prevHash)) {
    throw new TypeError("prevHash is not a 64-char lowercase hex digest");
  }
  if (!HEX64.test(fields.payloadHash)) {
    throw new TypeError("payloadHash is not a 64-char lowercase hex digest");
  }
  if (fields.seq < 1n) {
    throw new RangeError(`seq must be positive: ${fields.seq}`);
  }
  if (Number.isNaN(fields.ts.getTime())) {
    throw new RangeError("ts is an invalid Date");
  }
  if (fields.actor.includes("|")) {
    throw new TypeError("actor must not contain the field separator");
  }
  if (fields.eventType.includes("|")) {
    throw new TypeError("eventType must not contain the field separator");
  }

  const preimage = [
    fields.prevHash,
    fields.seq.toString(),
    fields.ts.toISOString(),
    fields.actor,
    fields.eventType,
    fields.payloadHash,
  ].join("|");
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}
