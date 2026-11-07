export function decisionClass(kind: string | null): string {
  if (kind === "ALLOW") return "decision-allow";
  if (kind === "STEP_UP") return "decision-step-up";
  if (kind === "DENY" || kind === "CAPTURE_FAILED" || kind === "ORDER_FAILED" || kind === "RAIL_MISMATCH") return "decision-deny";
  return "";
}

export function decisionLabel(kind: string | null, orderStatus: string | null): string {
  if (kind === "ALLOW" && orderStatus) return `Allowed (${orderStatus})`;
  if (kind === "ALLOW") return "Allowed";
  if (kind === "STEP_UP") return "Needs approval";
  if (kind === "DENY") return "Refused";
  if (kind === "CAPTURE_FAILED") return "Capture failed";
  if (kind === "ORDER_FAILED") return "Payment failed";
  if (kind === "RAIL_MISMATCH") return "Payment mismatch";
  return "Unknown";
}
