import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { isRetryable, modelErrorLabel } from "../src/gemini.js";

// Gemini's free tier answers a burst with 429, and the API gives short-lived 500, 502,
// 503 and 504 errors. Each is worth another try after a pause. A 400 or 403 is a
// request the same retry would send again unchanged, so it is not.
describe("which Gemini errors are tried again", () => {
  it.each([429, 500, 502, 503, 504])("retries a %d", (status) => {
    expect(isRetryable(new ApiError({ message: "x", status }))).toBe(true);
  });

  it.each([400, 401, 403, 404])("does not retry a %d", (status) => {
    expect(isRetryable(new ApiError({ message: "x", status }))).toBe(false);
  });

  it("does not retry an error that is not from the API", () => {
    expect(isRetryable(new Error("socket hang up"))).toBe(false);
  });
});

describe("what the operator's log says about a failed model call", () => {
  it("names the API status, and never the message, which can carry request text", () => {
    expect(modelErrorLabel(new ApiError({ message: "quota for key AIza-secret", status: 429 }))).toBe("ApiError 429");
  });

  it("names other errors by name only", () => {
    expect(modelErrorLabel(new TypeError("boom"))).toBe("TypeError");
    expect(modelErrorLabel("a string")).toBe("unknown error");
  });
});
