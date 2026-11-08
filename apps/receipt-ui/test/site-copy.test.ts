import { describe, expect, it } from "vitest";
import { renderLandingPage } from "../src/pages/landing.js";
import { renderDemoPage, renderRecordedRunPage, renderStartPage, loadRecording } from "../src/pages/demo.js";
import { generateKeypair } from "@praman/mandate";
import { SessionStore } from "../src/demo/session.js";

// What the public pages say, checked against what the product does. No database.

describe("the front page's links", () => {
  it("sends the code and MCP links to the branch that has the PayPal work", () => {
    const html = renderLandingPage();
    expect(html).toContain('href="https://github.com/Adwaith-R-Nair/Praman/tree/paypal-hackathon"');
    expect(html).toContain('href="https://github.com/Adwaith-R-Nair/Praman/blob/paypal-hackathon/docs/MCP.md"');
    expect(html).not.toContain("/blob/main/");
  });
});

describe("the recorded run", () => {
  it("links the screenshot to its full size, for phones", () => {
    expect(renderRecordedRunPage()).toContain('<a href="/demo/recorded-run.png"><img src="/demo/recorded-run.png"');
  });

  it("says the demo is out of sessions only after a refused start", () => {
    expect(renderRecordedRunPage()).not.toContain("as many sessions today");
    expect(renderRecordedRunPage(true)).toContain("as many sessions today");
  });
});

describe("a visitor with no sandbox login", () => {
  it("is told where the login is and offered the recorded run", () => {
    const html = renderStartPage(null, { paypal: true, model: true });
    expect(html).toContain("testing instructions on the project's Devpost page");
    expect(html).toContain('href="/demo/recorded"');
    expect(renderLandingPage()).toContain("Devpost testing notes");
  });
});

describe("who signed the demo's mandate", () => {
  const session = () => {
    const { privateKeyPem, publicKeyPem } = generateKeypair();
    return new SessionStore({ privateKeyPem, publicKeyPem, keyId: "test_k" }).create(new Date());
  };

  it("doesn't say the visitor signed something the server signed", () => {
    const pages = [renderLandingPage(), renderStartPage(null, { paypal: true, model: true }), renderRecordedRunPage(), renderDemoPage(session(), loadRecording())];
    for (const html of pages) {
      expect(html).not.toMatch(/you sign\b|you signed|You sign\b|you've authorised/);
    }
  });

  it("says the server signed it with a demo key", () => {
    expect(renderDemoPage(session(), loadRecording())).toContain("The server signed them with a demo key");
    expect(renderLandingPage()).toContain("signed for you by the server with a demo key");
  });
});
