import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { VaultApi } from "./connect.js";

/**
 * The builder's one-time consent as the demo's sandbox buyer (D-85). It is the demo's own
 * connect flow, run once by hand: PayPal makes a setup token, the builder approves it in
 * a browser logged in as the sandbox buyer, and PayPal turns it into a payment token.
 *
 * That token is a secret that outlives every session, so it goes to one file outside the
 * repo, readable by its owner only, and is never printed. `pnpm house-buyer` runs this
 * against PayPal's sandbox. The file's one line becomes the DEMO_HOUSE_BUYER_TOKEN secret.
 */
export interface ConsentIo {
  /** Shown to the builder. Never given the token. */
  readonly say: (line: string) => void;
  /** Resolves once the builder says they have approved at PayPal. */
  readonly waitForApproval: () => Promise<void>;
}

export interface ConsentOptions {
  /** Where the token goes. Outside the repo, and not there already. */
  readonly outPath: string;
  readonly repoRoot: string;
  /** Where PayPal sends the browser after the approval. Nothing reads what arrives there. */
  readonly returnUrl: string;
  /** PayPal-Request-Id for the setup token. A new one per run, so each run starts a new approval. */
  readonly requestId: string;
}

export type ConsentResult = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

/** The path with every link in its existing part followed, so a link into the repo doesn't hide it. */
function real(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...rest);
}

/** Why the token can't be written to this file, or null if it can. */
export function tokenFileProblem(outPath: string, repoRoot: string): string | null {
  const target = real(outPath);
  const fromRepo = relative(real(repoRoot), target);
  if (fromRepo === "" || (!fromRepo.startsWith("..") && !isAbsolute(fromRepo))) {
    return "That file is inside the repo. The token is a secret: choose a path outside it.";
  }
  if (existsSync(target)) return "That file already exists. Move it away first, or choose another path: this never overwrites a token.";
  return null;
}

export async function consentAsHouseBuyer(vault: Pick<VaultApi, "createSetupToken" | "createPaymentToken">, opts: ConsentOptions, io: ConsentIo): Promise<ConsentResult> {
  const problem = tokenFileProblem(opts.outPath, opts.repoRoot);
  if (problem !== null) return { ok: false, reason: problem };
  const path = resolve(opts.outPath);

  const setup = await vault.createSetupToken({ requestId: opts.requestId, returnUrl: opts.returnUrl, cancelUrl: opts.returnUrl, brandName: "Praman demo" });
  if (!setup.ok) return { ok: false, reason: `PayPal refused to start the approval (${setup.code}). Nothing was saved.` };

  // The file is made first, empty and private, so a token PayPal has made always has somewhere to go.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const file = openSync(path, "wx", 0o600);
  let saved = false;
  try {
    io.say("Open this address in a private browser window, log in as the sandbox BUYER (a personal sandbox account), and agree:");
    io.say(setup.value.approveUrl);
    io.say("PayPal then sends the browser to the demo's front page. Nothing there needs doing.");
    await io.waitForApproval();

    const requestId = createHash("sha256").update(`house-payment-token|${setup.value.id}`, "utf8").digest("hex");
    let token: Awaited<ReturnType<VaultApi["createPaymentToken"]>>;
    try {
      token = await vault.createPaymentToken(setup.value.id, requestId);
    } catch (err) {
      // The error's text could come from PayPal, so only its name is repeated.
      return { ok: false, reason: `PayPal gave no usable answer (${err instanceof Error ? err.name : "unknown error"}). Nothing was saved. Run this again.` };
    }
    if (!token.ok) return { ok: false, reason: `PayPal didn't confirm the approval (${token.code}). Nothing was saved. Run this again and approve before pressing Enter.` };
    writeSync(file, token.value.id);
    saved = true;
    io.say(`Saved the payment token to ${path}. It is a secret: it was not printed, and only you can read that file.`);
    return { ok: true, path };
  } finally {
    closeSync(file);
    if (!saved) unlinkSync(path);
  }
}
