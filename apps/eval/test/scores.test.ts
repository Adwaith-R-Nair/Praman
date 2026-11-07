import { describe, expect, it } from "vitest";
import { deterministicScores, langfuseScoreSink, startScoreSink, type ScoreClient } from "../src/scores.js";
import type { CaseResult } from "../src/types.js";

function liveCase(influenced: boolean | undefined, money_moved: boolean): CaseResult {
  return {
    case_id: "inj_case",
    family: "prompt_injection",
    layer: 2,
    money_moved,
    expected_money_moves: false,
    amount_moved_minor: 0n,
    reason_code: "OK",
    decision_kind: "ALLOW",
    passed: true,
    incidental: false,
    ...(influenced !== undefined ? { influenced } : {}),
    money_at_risk_minor: 0n,
    currency: "INR",
    latency_ms: 1,
    detail: "",
  };
}

function recordingClient(): { client: ScoreClient; created: Parameters<ScoreClient["score"]["create"]>[0][] } {
  const created: Parameters<ScoreClient["score"]["create"]>[0][] = [];
  return { client: { score: { create: (body) => void created.push(body) } }, created };
}

describe("deterministic eval scores", () => {
  it("copies influenced and money_moved from the runner's result as 1 or 0", () => {
    expect(deterministicScores(liveCase(true, false))).toEqual([
      { name: "influenced", value: 1 },
      { name: "money_moved", value: 0 },
    ]);
    expect(deterministicScores(liveCase(undefined, true))).toEqual([
      { name: "influenced", value: 0 },
      { name: "money_moved", value: 1 },
    ]);
  });

  it("pushes each score to the case's trace as a boolean, under an id that a second push reuses", () => {
    const { client, created } = recordingClient();
    const sink = langfuseScoreSink(client);

    sink.push("a".repeat(32), liveCase(true, false));
    sink.push("a".repeat(32), liveCase(true, false));

    expect(created).toHaveLength(4);
    expect(created[0]).toMatchObject({ traceId: "a".repeat(32), name: "influenced", value: 1, dataType: "BOOLEAN" });
    expect(created[1]).toMatchObject({ traceId: "a".repeat(32), name: "money_moved", value: 0, dataType: "BOOLEAN" });
    // Same ids the second time, so Langfuse updates the score instead of adding another.
    expect(created[2]?.id).toBe(created[0]?.id);
    expect(created[3]?.id).toBe(created[1]?.id);
  });

  it("with no langfuse keys, there is no sink and stopping does nothing", async () => {
    const scores = await startScoreSink({});
    expect(scores.sink).toBeUndefined();
    expect(await scores.stop()).toBe("off");
  });
});
