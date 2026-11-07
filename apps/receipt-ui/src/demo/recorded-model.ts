import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ModelProvider, ProviderTurn, ToolCall } from "@praman/agent-core";
import type { PurchaseBeat } from "./config.js";

const ANSWERS_PATH = fileURLToPath(new URL("./recorded/model-answers.json", import.meta.url));

type RecordedStep = PurchaseBeat | "injection";

export interface RecordedAnswer {
  /** The ledger trace the answer was read back from, in the run that recorded it. */
  readonly traceId: string;
  readonly recordedAt: string;
  /** The model's turns, in order: the tool calls it made. */
  readonly turns: readonly (readonly ToolCall[])[];
}

export interface RecordedAnswers {
  readonly model: string;
  readonly answers: Readonly<Record<RecordedStep, RecordedAnswer>>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toolCall(v: unknown): ToolCall {
  if (!isRecord(v) || typeof v["id"] !== "string" || typeof v["name"] !== "string" || !isRecord(v["input"])) throw new Error("a recorded model answer has a malformed tool call");
  return { id: v["id"], name: v["name"], input: { ...v["input"] } };
}

function answer(v: unknown): RecordedAnswer {
  if (!isRecord(v) || typeof v["trace_id"] !== "string" || typeof v["recorded_at"] !== "string" || !Array.isArray(v["turns"])) throw new Error("a recorded model answer is malformed");
  const turns = v["turns"].map((t: unknown) => {
    if (!isRecord(t) || !Array.isArray(t["calls"])) throw new Error("a recorded model turn is malformed");
    return t["calls"].map(toolCall);
  });
  return { traceId: v["trace_id"], recordedAt: v["recorded_at"], turns };
}

/**
 * Real answers the live model gave in one run of this demo, read back from that run's
 * ledger traces. They stand in for the model once the demo's daily model calls are
 * used up, and every page that shows one says it is a recording.
 */
export function loadModelAnswers(raw: string = readFileSync(ANSWERS_PATH, "utf8")): RecordedAnswers {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed["model"] !== "string" || !isRecord(parsed["answers"])) throw new Error("the recorded model answers are malformed");
  const a = parsed["answers"];
  return { model: parsed["model"], answers: { first: answer(a["first"]), second: answer(a["second"]), large: answer(a["large"]), injection: answer(a["injection"]) } };
}

/**
 * Plays back one recorded answer, turn by turn. The tools still run live, so the
 * catalog the agent reads and the prices Praman uses are today's. Its id starts with
 * "recorded/", and that is what the ledger's intent row records as the model.
 */
export class RecordedProvider implements ModelProvider {
  #turn = 0;

  constructor(
    private readonly model: string,
    private readonly recorded: RecordedAnswer,
  ) {}

  get id(): string {
    return `recorded/${this.model}`;
  }

  async send(): Promise<ProviderTurn> {
    const calls = this.recorded.turns[this.#turn];
    this.#turn += 1;
    if (calls === undefined) return { kind: "TEXT", text: "The recording has no more turns.", raw: null };
    return { kind: "TOOL_CALLS", calls, raw: null };
  }
}
