import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";

/**
 * The only actions switched on, in the toolkit's own names (read from the code of
 * @paypal/agent-toolkit 1.11.0). An action that is not listed is off. Nothing here
 * creates, captures, refunds, sends, updates or accepts anything.
 */
export const READ_ONLY_ACTIONS = {
  orders: { get: true },
  payments: { getRefunds: true },
  disputes: { list: true, get: true },
} as const;

/** The tools those four actions give. test/read-only-toolkit.test.ts pins this list against the real toolkit. */
export const READ_TOOL_NAMES = ["get_dispute", "get_order", "get_refund", "list_disputes"] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

/** The host the toolkit's own client picks when its context says sandbox. */
export const TOOLKIT_SANDBOX_HOST = "api.sandbox.paypal.com";

/** The toolkit sets no timeout on its requests, so one is kept here. */
export const TOOL_TIMEOUT_MS = 30_000;

/** What a read tool answered: PayPal's JSON, or the toolkit's error object reduced to a status and a code. */
export type ToolAnswer =
  | { readonly kind: "ok"; readonly body: Readonly<Record<string, unknown>> }
  | { readonly kind: "error"; readonly status: number | null; readonly code: string };

export interface ReadOnlyTools {
  /** The names of the tools the toolkit handed back, sorted. */
  readonly enabled: readonly string[];
  call(name: ReadToolName, args: Readonly<Record<string, string>>): Promise<ToolAnswer>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Stops the auditor unless the toolkit returned exactly the four read tools. The
 * toolkit's configuration decides which tools are listed, so a later version that
 * renamed an action, or an edit that switched another one on, would change this list.
 */
export function assertReadOnly(enabled: readonly string[]): void {
  const sorted = [...enabled].sort();
  const same = sorted.length === READ_TOOL_NAMES.length && READ_TOOL_NAMES.every((name, i) => sorted[i] === name);
  if (!same) throw new Error(`The PayPal toolkit returned tools other than the four read tools: ${sorted.join(", ") || "none"}`);
}

/**
 * The toolkit answers with a JSON string. An error comes back as a string too:
 * {"ok":false,"status":404,"code":"PAYPAL_API_HTTP_ERROR","message":...} for an HTTP
 * answer, seen live on 2026-11-09, or {"error":{...}} for anything else. The message
 * is PayPal's text and is dropped here.
 */
export function readToolAnswer(raw: unknown): ToolAnswer {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "error", status: null, code: "ANSWER_NOT_JSON" };
    }
  }
  if (!isRecord(parsed)) return { kind: "error", status: null, code: "ANSWER_NOT_AN_OBJECT" };
  if (parsed["ok"] === false) {
    const status = parsed["status"];
    const code = parsed["code"];
    return {
      kind: "error",
      status: typeof status === "number" && Number.isInteger(status) ? status : null,
      code: typeof code === "string" && /^[A-Z_]{1,40}$/.test(code) ? code : "TOOLKIT_ERROR",
    };
  }
  if (isRecord(parsed["error"])) return { kind: "error", status: null, code: "TOOLKIT_ERROR" };
  return { kind: "ok", body: parsed };
}

async function withTimeout<T>(work: PromiseLike<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds PayPal's Agent Toolkit with the read actions only, always against the
 * sandbox, and hands back nothing but a way to call those four tools.
 *
 * Calls go through the tool objects getTools() returned, each bound by the toolkit
 * to one method. The toolkit's PayPalAPI.run(), and handleToolCall() on its OpenAI
 * and Bedrock adapters, dispatch any method name whatever the configuration says
 * (read in 1.11.0), so neither is used or reachable from what this returns.
 */
export function buildReadOnlyTools(credentials: { readonly clientId: string; readonly clientSecret: string }): ReadOnlyTools {
  const toolkit = new PayPalAgentToolkit({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    configuration: { actions: READ_ONLY_ACTIONS, context: { sandbox: true } },
  });
  if (new URL(toolkit.client.getBaseUrl()).hostname !== TOOLKIT_SANDBOX_HOST) {
    throw new Error("The PayPal toolkit is not pointed at the sandbox, and live keys are out of scope for this repo");
  }
  const tools = toolkit.getTools();
  const enabled = Object.keys(tools).sort();
  assertReadOnly(enabled);

  return {
    enabled,
    async call(name, args) {
      const execute = tools[name]?.execute;
      if (execute === undefined) return { kind: "error", status: null, code: "TOOL_MISSING" };
      try {
        const raw: unknown = await withTimeout(execute({ ...args }, { toolCallId: `praman_audit_${name}`, messages: [] }), TOOL_TIMEOUT_MS);
        return readToolAnswer(raw);
      } catch {
        return { kind: "error", status: null, code: "NO_ANSWER" };
      }
    },
  };
}

/** A PayPal id as the auditor will send it. The toolkit puts ids into the URL path as they are. */
const SENDABLE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const NOT_SENT: ToolAnswer = { kind: "error", status: null, code: "ID_NOT_SENT" };

/** The four reads, by what they are about. Tests put a fake behind this. */
export interface PayPalReader {
  getOrder(orderId: string): Promise<ToolAnswer>;
  getRefund(refundId: string): Promise<ToolAnswer>;
  /** Disputes on one captured payment. */
  listDisputes(captureId: string): Promise<ToolAnswer>;
  getDispute(disputeId: string): Promise<ToolAnswer>;
}

/**
 * Names each read's argument the way the toolkit's schema does. An id that is not
 * plain letters, digits, _ or - is not sent: it came from a ledger row or a PayPal
 * answer, and it would land in a URL.
 */
export function readerOver(tools: ReadOnlyTools): PayPalReader {
  const send = (name: ReadToolName, field: string, id: string): Promise<ToolAnswer> =>
    SENDABLE_ID.test(id) ? tools.call(name, { [field]: id }) : Promise.resolve(NOT_SENT);
  return {
    getOrder: (orderId) => send("get_order", "id", orderId),
    getRefund: (refundId) => send("get_refund", "refund_id", refundId),
    listDisputes: (captureId) => send("list_disputes", "disputed_transaction_id", captureId),
    getDispute: (disputeId) => send("get_dispute", "dispute_id", disputeId),
  };
}
