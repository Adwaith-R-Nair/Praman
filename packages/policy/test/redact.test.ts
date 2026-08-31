import { describe, expect, it } from "vitest";
import { paise } from "@praman/shared";
import { redact } from "../src/redact.js";
import type { Decision } from "../src/types.js";

describe("redact", () => {
  it("strips reason_code, remaining_paise and detail from ALLOW", () => {
    const decision: Decision = {
      kind: "ALLOW",
      amount_paise: paise(10000n),
      reason_code: "OK",
      remaining_paise: paise(390000n),
    };
    expect(redact(decision)).toEqual({
      kind: "ALLOW",
      amount_paise: paise(10000n),
    });
  });

  it("strips the step-up sub-code from STEP_UP", () => {
    const decision: Decision = {
      kind: "STEP_UP",
      amount_paise: paise(60000n),
      reason_code: "STEP_UP_THRESHOLD",
    };
    expect(redact(decision)).toEqual({
      kind: "STEP_UP",
      amount_paise: paise(60000n),
    });
  });

  it("does not reveal whether a STEP_UP was FIRST_MERCHANT or THRESHOLD", () => {
    const firstMerchant: Decision = {
      kind: "STEP_UP",
      amount_paise: paise(60000n),
      reason_code: "STEP_UP_FIRST_MERCHANT",
    };
    const threshold: Decision = {
      kind: "STEP_UP",
      amount_paise: paise(60000n),
      reason_code: "STEP_UP_THRESHOLD",
    };
    expect(redact(firstMerchant)).toEqual(redact(threshold));
  });

  it("strips detail from DENY, keeping only kind and reason_code", () => {
    const decision: Decision = {
      kind: "DENY",
      reason_code: "MANDATE_AMOUNT_EXCEEDED",
      detail: "Amount 120000 paise exceeds per-transaction limit 80000 paise.",
    };
    expect(redact(decision)).toEqual({
      kind: "DENY",
      reason_code: "MANDATE_AMOUNT_EXCEEDED",
    });
  });

  it("never leaks a mandate limit value through the redacted shape", () => {
    const decisions: Decision[] = [
      {
        kind: "ALLOW",
        amount_paise: paise(10000n),
        reason_code: "OK",
        remaining_paise: paise(390000n),
      },
      {
        kind: "STEP_UP",
        amount_paise: paise(60000n),
        reason_code: "STEP_UP_THRESHOLD",
      },
      {
        kind: "DENY",
        reason_code: "MANDATE_AMOUNT_EXCEEDED",
        detail:
          "Amount 120000 paise exceeds per-transaction limit 80000 paise.",
      },
    ];

    for (const decision of decisions) {
      const visible = redact(decision);
      expect(Object.keys(visible)).not.toContain("detail");
      expect(Object.keys(visible)).not.toContain("remaining_paise");
      // 80000 and 390000 only ever appeared inside detail/remaining_paise —
      // neither field survives redaction, so neither value can either.
      const serialised = Object.values(visible).map(String).join(" ");
      expect(serialised).not.toMatch(/80000|390000|per-transaction/);
    }
  });
});
