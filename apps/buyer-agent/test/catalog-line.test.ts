import { describe, expect, it } from "vitest";
import { catalogLine } from "../src/agent.js";

describe("the catalog line the model reads", () => {
  it("shows the currency next to the price", () => {
    expect(
      catalogLine({ sku: "SKU_US_1", title: "t", description: "d", category: "food", price_minor: "1250", currency: "USD", in_stock: true }),
    ).toBe("sku=SKU_US_1 category=food price_minor=1250 currency=USD in_stock=true");
  });
});
