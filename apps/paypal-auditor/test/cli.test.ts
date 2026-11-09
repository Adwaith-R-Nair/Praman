import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/**
 * Runs the real command in a child process. The PayPal and model keys are blanked,
 * and dotenv never replaces a variable that is already set, so the child can reach
 * neither PayPal nor a model whatever .env holds.
 */
function cli(args: readonly string[], env: Readonly<Record<string, string>> = {}): { readonly status: number | null; readonly out: string; readonly err: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", GEMINI_API_KEY: "", ...env },
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe("pnpm audit:paypal, the command itself", () => {
  it("exits 2, not 1, when it stops before reading anything: 1 is kept for a real mismatch", () => {
    // @praman/db throws while it loads when DATABASE_URL is unset. Left uncaught, Node
    // ends with exit code 1, which this command's callers read as "a field differs".
    const { status, out, err } = cli(["trc_cli_test"], { DATABASE_URL: "" });
    expect(err).toContain("Not audited: the audit stopped before a verdict. DATABASE_URL is not set");
    expect(err).toContain("Nothing was compared. This is neither a pass nor a fail.");
    expect(out).not.toMatch(/Overall|MATCH/);
    expect(status).toBe(2);
  }, 60_000);

  it("exits 2 on a bad command line and on a trace the ledger does not have", () => {
    const usage = cli([]);
    expect(usage.err).toContain("usage: pnpm audit:paypal <trace_id> [--narrate]");
    expect(usage.status).toBe(2);

    const unknown = cli(["trc_cli_test_no_such_trace", "--narrate"]);
    expect(unknown.out).toContain("Not audited: No ledger rows have this trace id.");
    expect(unknown.out).not.toContain("Overall");
    expect(unknown.status).toBe(2);
  }, 60_000);
});
