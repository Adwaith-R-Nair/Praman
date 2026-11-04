import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The claim this project makes about PayPal is that adding a rail did not change
 * the policy engine. `.policy-freeze` names the commit where packages/policy was
 * finished, and this fails if anything in that package differs from it. It can
 * only be satisfied by not touching the package, or by moving the file, which
 * shows up in the history.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FREEZE_FILE = `${ROOT}.policy-freeze`;
const POLICY = "packages/policy";

function git(...args: readonly string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!existsSync(FREEZE_FILE)) fail(".policy-freeze is missing, so there is nothing to check against.");

const sha = readFileSync(FREEZE_FILE, "utf8").trim();
if (!/^[0-9a-f]{40}$/.test(sha)) fail(".policy-freeze must hold one full commit SHA.");

// A shallow checkout won't have the commit. That has to fail, not pass as "no diff".
try {
  git("cat-file", "-e", `${sha}^{commit}`);
} catch {
  fail(`Commit ${sha} isn't available here. In CI, checkout needs fetch-depth: 0.`);
}

const changed = new Set(
  [
    // What is committed. This is the claim.
    git("diff", "--name-only", sha, "HEAD", "--", POLICY),
    // What is in this working tree, so a local run catches an edit before it is committed.
    git("diff", "--name-only", sha, "--", POLICY),
    git("ls-files", "--others", "--exclude-standard", "--", POLICY),
  ]
    .join("\n")
    .split("\n")
    .filter((line) => line !== ""),
);

if (changed.size > 0) {
  console.error(`${POLICY} has changed since it was frozen at ${sha}:`);
  for (const file of [...changed].sort()) console.error(`  - ${file}`);
  process.exit(1);
}

console.log(`Policy freeze OK: ${POLICY} matches ${sha}.`);
