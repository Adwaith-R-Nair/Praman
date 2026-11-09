import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  /** PayPal gave no answer about the payment token. True to ask again with the same request, false to stop. */
  readonly askAgain: () => Promise<boolean>;
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
  // Outside means the way there starts by going up: ".." itself or "../…". A file named "..x" in the repo is inside.
  const outside = fromRepo === ".." || fromRepo.startsWith(`..${sep}`) || isAbsolute(fromRepo);
  if (!outside) {
    return "That file is inside the repo. The token is a secret: choose a path outside it.";
  }
  if (existsSync(target)) return "That file already exists. Move it away first, or choose another path: this never overwrites a token.";
  return null;
}

/** An error's name or system code. Never its message, which could carry text from PayPal. */
const errorName = (err: unknown): string => (err instanceof Error ? (("code" in err && typeof err.code === "string" ? err.code : null) ?? err.name) : "unknown error");

/** Said when a try for the payment token got no answer and no later try gave a token. */
const MAYBE_MADE =
  "PayPal may have made a payment token that was not written here. If it did, that token stays saved at PayPal for this app, unused, until it is deleted with the vault API. To get a token you can use, run this again and approve again.";

export async function consentAsHouseBuyer(vault: Pick<VaultApi, "createSetupToken" | "createPaymentToken">, opts: ConsentOptions, io: ConsentIo): Promise<ConsentResult> {
  const problem = tokenFileProblem(opts.outPath, opts.repoRoot);
  if (problem !== null) return { ok: false, reason: problem };
  const path = resolve(opts.outPath);

  // The file is made first, empty and private, before PayPal is asked for anything. So a
  // file that can't be made costs no approval, and a token PayPal makes always has somewhere to go.
  let file: number;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    file = openSync(path, "wx", 0o600);
  } catch (err) {
    return { ok: false, reason: `The file ${path} couldn't be created (${errorName(err)}). PayPal was not asked for anything.` };
  }
  let saved = false;
  try {
    let setup: Awaited<ReturnType<VaultApi["createSetupToken"]>>;
    try {
      setup = await vault.createSetupToken({ requestId: opts.requestId, returnUrl: opts.returnUrl, cancelUrl: opts.returnUrl, brandName: "Praman demo" });
    } catch (err) {
      return { ok: false, reason: `PayPal gave no answer when asked to start the approval (${errorName(err)}). Nothing was approved or saved. Run this again.` };
    }
    if (!setup.ok) return { ok: false, reason: `PayPal refused to start the approval (${setup.code}). Nothing was saved.` };

    io.say("Open this address in a private browser window, log in as the sandbox BUYER (a personal sandbox account), and agree:");
    io.say(setup.value.approveUrl);
    io.say(`PayPal then sends the browser to ${opts.returnUrl}. Nothing there needs doing. If nothing is running at that address the browser shows an error page, and that is fine: the approval is already given.`);
    await io.waitForApproval();

    // One request id for every try, so a try that follows a lost answer asks PayPal about the same request.
    const requestId = createHash("sha256").update(`house-payment-token|${setup.value.id}`, "utf8").digest("hex");
    let unanswered = false;
    for (;;) {
      let token: Awaited<ReturnType<VaultApi["createPaymentToken"]>>;
      try {
        token = await vault.createPaymentToken(setup.value.id, requestId);
      } catch (err) {
        unanswered = true;
        io.say(`PayPal gave no answer about the payment token (${errorName(err)}).`);
        if (await io.askAgain()) continue;
        return { ok: false, reason: `PayPal gave no answer about the payment token, so no token was written. ${MAYBE_MADE}` };
      }
      if (!token.ok) {
        return unanswered
          ? { ok: false, reason: `PayPal answered ${token.code} after an earlier try got no answer, so no token was written. ${MAYBE_MADE}` }
          : { ok: false, reason: `PayPal didn't confirm the approval (${token.code}). Nothing was saved. Run this again and approve before pressing Enter.` };
      }
      writeSync(file, token.value.id);
      saved = true;
      io.say(`Saved the payment token to ${path}. It is a secret: it was not printed, and only you can read that file.`);
      return { ok: true, path };
    }
  } finally {
    closeSync(file);
    if (!saved) unlinkSync(path);
  }
}
