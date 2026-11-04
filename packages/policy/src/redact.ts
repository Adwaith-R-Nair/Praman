import type { AgentVisibleDecision, Decision } from "./types.js";

/** Strips mandate limits from a Decision before it reaches the agent. See D-08. */
export function redact(decision: Decision): AgentVisibleDecision {
  switch (decision.kind) {
    case "ALLOW":
      return { kind: "ALLOW", amount_minor: decision.amount_minor };
    case "STEP_UP":
      return { kind: "STEP_UP", amount_minor: decision.amount_minor };
    case "DENY":
      return { kind: "DENY", reason_code: decision.reason_code };
  }
}
