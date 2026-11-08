import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools.js";

describe("the tools the model is given", () => {
  it("are reading the catalog and proposing a cart, and nothing that moves money back or forth", () => {
    // A model proposes; only Praman decides a purchase, and only a person starts a refund (D-66).
    expect(TOOLS.map((t) => t.name)).toEqual(["list_catalog", "get_sku", "propose_intent"]);
  });
});
