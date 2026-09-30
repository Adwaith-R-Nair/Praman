import { describe, expect, it } from "vitest";
import type { ConversationItem, ModelProvider, ProviderTurn, ToolSpec } from "../src/provider.js";
import { TracedProvider } from "../src/traced-provider.js";

// No Langfuse keys are set anywhere in this test run, so no OpenTelemetry
// SDK is ever started — exactly the "no keys configured" state the real
// entrypoints are in until Phase 10's .env wiring step. TracedProvider must
// behave identically to the bare provider in this state (D-xx).
class FakeProvider implements ModelProvider {
  readonly id = "fake/model";
  #turn: ProviderTurn;
  #err: Error | undefined;

  constructor(turn: ProviderTurn, err?: Error) {
    this.#turn = turn;
    this.#err = err;
  }

  async send(_system: string, _history: readonly ConversationItem[], _tools: readonly ToolSpec[]): Promise<ProviderTurn> {
    if (this.#err) throw this.#err;
    return this.#turn;
  }
}

describe("TracedProvider", () => {
  it("returns the inner provider's turn unchanged when no Langfuse SDK is started", async () => {
    const turn: ProviderTurn = { kind: "TEXT", text: "hello", raw: { fake: true }, usage: { input: 10, output: 5, total: 15 } };
    const traced = new TracedProvider(new FakeProvider(turn));

    const result = await traced.send("system", [], []);

    expect(result).toEqual(turn);
  });

  it("exposes the inner provider's id unchanged", () => {
    const traced = new TracedProvider(new FakeProvider({ kind: "TEXT", text: "", raw: null }));
    expect(traced.id).toBe("fake/model");
  });

  it("propagates an error from the inner provider rather than swallowing it", async () => {
    const err = new Error("provider exploded");
    const traced = new TracedProvider(new FakeProvider({ kind: "TEXT", text: "", raw: null }, err));

    await expect(traced.send("system", [], [])).rejects.toThrow("provider exploded");
  });

  it("passes through a TOOL_CALLS turn unchanged, usage included", async () => {
    const turn: ProviderTurn = {
      kind: "TOOL_CALLS",
      calls: [{ id: "c1", name: "list_catalog", input: {} }],
      raw: { fake: true },
      usage: { input: 20, output: 3 },
    };
    const traced = new TracedProvider(new FakeProvider(turn));

    const result = await traced.send("system", [], []);

    expect(result).toEqual(turn);
  });
});
