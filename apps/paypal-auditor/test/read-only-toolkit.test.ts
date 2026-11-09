import { describe, expect, it } from "vitest";
import { ALL_TOOLS_ENABLED, PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { assertReadOnly, buildReadOnlyTools, READ_ONLY_ACTIONS, READ_TOOL_NAMES, readerOver, readToolAnswer, type ReadOnlyTools, type ToolAnswer } from "../src/read-only-toolkit.js";

// No test here reaches PayPal: building the toolkit makes no request, and nothing below calls a real tool.
const credentials = { clientId: "not-a-real-id", clientSecret: "not-a-real-secret" };

describe("the toolkit's enabled set", () => {
  it("switches on exactly four actions, in the toolkit's own names", () => {
    expect(READ_ONLY_ACTIONS).toEqual({ orders: { get: true }, payments: { getRefunds: true }, disputes: { list: true, get: true } });
  });

  it("gets exactly the four read tools back from the real toolkit", () => {
    expect(buildReadOnlyTools(credentials).enabled).toEqual(["get_dispute", "get_order", "get_refund", "list_disputes"]);
    expect([...READ_TOOL_NAMES]).toEqual(["get_dispute", "get_order", "get_refund", "list_disputes"]);
  });

  it("has no tool that creates, pays, refunds, sends, updates or accepts", () => {
    const writes = /create|pay_|capture|refund_for|send|update|cancel|delete|accept|record|activate|generate|setup/;
    expect(buildReadOnlyTools(credentials).enabled.filter((name) => writes.test(name))).toEqual([]);
    // The same pattern does find the toolkit's writing tools, so the line above can fail.
    const all = Object.keys(new PayPalAgentToolkit({ ...credentials, configuration: { actions: ALL_TOOLS_ENABLED, context: { sandbox: true } } }).getTools());
    expect(all).toEqual(expect.arrayContaining(["create_order", "pay_order", "create_refund", "accept_dispute_claim"]));
    expect(all.filter((name) => writes.test(name)).length).toBeGreaterThan(30);
  });

  it("stops if the toolkit hands back any other set", () => {
    expect(() => assertReadOnly(["get_dispute", "get_order", "get_refund", "list_disputes"])).not.toThrow();
    expect(() => assertReadOnly(["list_disputes", "get_refund", "get_order", "get_dispute"])).not.toThrow();
    expect(() => assertReadOnly(["create_order", "get_dispute", "get_order", "get_refund", "list_disputes"])).toThrow(/other than the four read tools/);
    expect(() => assertReadOnly(["create_refund", "get_dispute", "get_order", "list_disputes"])).toThrow();
    expect(() => assertReadOnly(["get_order", "get_refund", "list_disputes"])).toThrow();
    expect(() => assertReadOnly([])).toThrow();
  });
});

describe("readToolAnswer", () => {
  it("reads PayPal's JSON from the string the toolkit returns", () => {
    expect(readToolAnswer('{"id":"5MW43748XP341760A","status":"COMPLETED"}')).toEqual({ kind: "ok", body: { id: "5MW43748XP341760A", status: "COMPLETED" } });
  });

  it("reduces the toolkit's error object to a status and a code, dropping PayPal's message", () => {
    const answer = readToolAnswer('{"ok":false,"status":404,"code":"PAYPAL_API_HTTP_ERROR","message":"The specified resource does not exist."}');
    expect(answer).toEqual({ kind: "error", status: 404, code: "PAYPAL_API_HTTP_ERROR" });
  });

  it("treats anything else it can't read as an error, never as an order", () => {
    expect(readToolAnswer('{"error":{"message":"boom","type":"paypal_error"}}')).toEqual({ kind: "error", status: null, code: "TOOLKIT_ERROR" });
    expect(readToolAnswer("not json")).toEqual({ kind: "error", status: null, code: "ANSWER_NOT_JSON" });
    expect(readToolAnswer("[1,2]")).toEqual({ kind: "error", status: null, code: "ANSWER_NOT_AN_OBJECT" });
    expect(readToolAnswer('{"ok":false,"status":"404","code":"<b>x</b>"}')).toEqual({ kind: "error", status: null, code: "TOOLKIT_ERROR" });
  });
});

describe("readerOver", () => {
  function recording(): ReadOnlyTools & { readonly sent: unknown[] } {
    const sent: unknown[] = [];
    const answer: ToolAnswer = { kind: "ok", body: {} };
    return { sent, enabled: [...READ_TOOL_NAMES], call: (name, args) => (sent.push([name, args]), Promise.resolve(answer)) };
  }

  it("names each argument the way the toolkit's schema does", async () => {
    const tools = recording();
    const reader = readerOver(tools);
    await reader.getOrder("5MW43748XP341760A");
    await reader.getRefund("90W33293UC2395338");
    await reader.listDisputes("1DA33593DL077134A");
    await reader.getDispute("PP-D-12345");
    expect(tools.sent).toEqual([
      ["get_order", { id: "5MW43748XP341760A" }],
      ["get_refund", { refund_id: "90W33293UC2395338" }],
      ["list_disputes", { disputed_transaction_id: "1DA33593DL077134A" }],
      ["get_dispute", { dispute_id: "PP-D-12345" }],
    ]);
  });

  it("does not send an id that could change the request's path", async () => {
    const tools = recording();
    const reader = readerOver(tools);
    for (const id of ["5MW43748XP341760A/capture", "../v2/payments/captures/X/refund", "A?x=1", "A B", "", "A".repeat(65)]) {
      expect(await reader.getOrder(id)).toEqual({ kind: "error", status: null, code: "ID_NOT_SENT" });
      expect(await reader.getRefund(id)).toEqual({ kind: "error", status: null, code: "ID_NOT_SENT" });
    }
    expect(tools.sent).toEqual([]);
  });
});
