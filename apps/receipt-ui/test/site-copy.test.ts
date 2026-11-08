import { describe, expect, it } from "vitest";
import { renderLandingPage } from "../src/pages/landing.js";

// What the public pages say, checked against what the product does. No database.

describe("the front page's links", () => {
  it("sends the code and MCP links to the branch that has the PayPal work", () => {
    const html = renderLandingPage();
    expect(html).toContain('href="https://github.com/Adwaith-R-Nair/Praman/tree/paypal-hackathon"');
    expect(html).toContain('href="https://github.com/Adwaith-R-Nair/Praman/blob/paypal-hackathon/docs/MCP.md"');
    expect(html).not.toContain("/blob/main/");
  });
});
