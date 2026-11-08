import { describe, expect, it } from "vitest";
import { reportFileStem } from "../src/report.js";

describe("reportFileStem", () => {
  it("replaces the committed report only when both layers ran", () => {
    expect(reportFileStem(true, true)).toBe("report");
    expect(reportFileStem(true, false)).toBe("report.partial");
    expect(reportFileStem(false, true)).toBe("report.partial");
  });
});
