import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// dotenv must load before any dynamic import reaches @praman/db, as in scripts/approve.ts.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

/**
 * pnpm audit:paypal <trace_id> [--narrate]
 *
 * Checks one ledger trace against PayPal's own record of its order, read through
 * PayPal's Agent Toolkit with read tools only. Writes nothing anywhere.
 *
 * Exit code 0: every compared field agrees. 1: at least one differs. 2: nothing was
 * compared (a bad command line, no such trace, no PayPal order on it, or the ledger
 * or PayPal could not be read), which is neither a pass nor a fail.
 */
const TRACE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const NARRATION_MODEL = "gemini-3.1-flash-lite";

const args = process.argv.slice(2);
const wantsNarration = args.includes("--narrate");
const [traceId, extra] = args.filter((arg) => arg !== "--narrate");

const { EXIT_NOT_AUDITED, runAudit } = await import("./audit.js");
type AuditDeps = import("./audit.js").AuditDeps;
type Narrator = import("./audit.js").Narrator;

if (traceId === undefined || extra !== undefined || !TRACE_ID.test(traceId)) {
  console.error("usage: pnpm audit:paypal <trace_id> [--narrate]");
  process.exit(EXIT_NOT_AUDITED);
}

const { buildReadOnlyTools, readerOver } = await import("./read-only-toolkit.js");
const { readTraceReadOnly } = await import("./ledger-read.js");
const { prisma } = await import("@praman/db");

const deps: AuditDeps = {
  readTrace: readTraceReadOnly,
  paypal: () => {
    const clientId = process.env["PAYPAL_CLIENT_ID"];
    const clientSecret = process.env["PAYPAL_CLIENT_SECRET"];
    if (!clientId || !clientSecret) return null;
    return readerOver(buildReadOnlyTools({ clientId, clientSecret }));
  },
};

// Off unless asked for. The model is given the finished comparison and no tools.
let narrator: Narrator | null = null;
let narrationSkipped = false;
if (wantsNarration) {
  const geminiKey = process.env["GEMINI_API_KEY"];
  if (geminiKey) {
    const { GeminiProvider } = await import("@praman/agent-core");
    const { narratorFor } = await import("./narrate.js");
    narrator = narratorFor(new GeminiProvider(geminiKey, NARRATION_MODEL));
  } else {
    narrationSkipped = true;
  }
}

let exitCode: number = EXIT_NOT_AUDITED;
try {
  const result = await runAudit(deps, traceId, narrator);
  for (const line of result.lines) console.log(line);
  if (narrationSkipped) console.log("\nNarration skipped: GEMINI_API_KEY is not set. The verdict above stands.");
  exitCode = result.exitCode;
} catch (err) {
  const detail = (err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 200) ?? "";
  console.error(`Not audited: the audit stopped before a verdict. ${detail}`);
  console.error("Nothing was compared. This is neither a pass nor a fail.");
} finally {
  await prisma.$disconnect();
}
process.exit(exitCode);
