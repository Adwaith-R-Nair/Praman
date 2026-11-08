import { randomBytes } from "node:crypto";

/**
 * Goes on a ledger row that the public dispute bundle reads with a field withheld:
 * refusal text that can name a limit, or a step-up reason. The row's hash covers the
 * salt, so the public hash can't be used to confirm a guessed value. Evidence only:
 * nothing decides anything from it, and it is not an idempotency key.
 */
export function redactionSalt(): { readonly redaction_salt: string } {
  return { redaction_salt: randomBytes(16).toString("hex") };
}
