import { describe, expect, it } from "vitest";
import { renderLandingPage } from "../src/pages/landing.js";
import { renderDemoPage, renderRecordedRunPage, renderStartPage, loadRecording } from "../src/pages/demo.js";
import { generateKeypair } from "@praman/mandate";
import { SessionStore } from "../src/demo/session.js";

// What the public pages say, checked against what the product does. No database.

const session = () => {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  return new SessionStore({ privateKeyPem, publicKeyPem, keyId: "test_k" }).create(new Date());
};

describe("the front page's links", () => {
  it("sends the code link to the repository root and the MCP link to the default branch", () => {
    const html = renderLandingPage();
    expect(html).toContain('href="https://github.com/Adwaith-R-Nair/Praman"');
    expect(html).toContain('href="https://github.com/Adwaith-R-Nair/Praman/blob/HEAD/docs/MCP.md"');
    expect(html).not.toContain("/tree/paypal-hackathon");
    expect(html).not.toContain("/blob/paypal-hackathon/");
    expect(html).not.toContain("/blob/main/");
  });
});

describe("the front page's first screen", () => {
  const html = renderLandingPage();
  const hero = html.slice(html.indexOf('<section class="hero">'), html.indexOf("</section>"));

  it("leads with the person and what happens to her, before anything about Praman", () => {
    expect(hero).toContain("Meera gives her shopping agent her PayPal account and $60 a week for lunch.");
    expect(hero).toContain("a shop's listing tells the agent to add a $100 gift card");
    expect(hero.indexOf("Meera gives")).toBeLessThan(hero.indexOf("Praman is the signed permission"));
    expect(hero).toContain("PayPal doesn't trust the browser with the price, and Praman doesn't trust the model with it.");
  });

  it("says Meera is an example, not a customer", () => {
    expect(html).toContain("Meera is an example, not a customer");
  });

  it("names what it is built on, and says the Channel3 catalog is in the local MCP shop", () => {
    const line = /<p class="built-on">([^<]*)<\/p>/.exec(html)?.[1] ?? "";
    for (const name of ["PayPal sandbox", "Render", "AG Grid", "Channel3", "Gemini"]) expect(line, name).toContain(name);
    expect(line).toMatch(/local MCP shop[^.]*Channel3/);
    // The products are real and the retailer is never paid, so the page must not say the shop sells them.
    expect(line).not.toMatch(/\bsells\b/);
  });

  it("gives the poisoned listing the step number the demo page gives it, and says it is the first one a visitor runs", () => {
    const n = /<section class="step[^"]*" id="injection">\s*<h2><span class="step-n">(\d+)<\/span>/.exec(renderDemoPage(session(), loadRecording()))?.[1];
    expect(n).toBe("2");
    expect(html).toContain(`Step ${n ?? "?"} of the demo, and the first one you run.`);
    expect(html).not.toContain("The first step of the demo");
    expect(html).not.toMatch(/step 6/i);
  });

  it("says the first step a visitor runs needs no login, and which steps the sandbox login is for", () => {
    const note = /<span class="cta-note">([^<]*)<\/span>/.exec(html)?.[1] ?? "";
    expect(note).toContain("The first step you run needs no login.");
    expect(note).toContain("The sandbox login for the PayPal steps is in the Devpost testing notes.");
  });
});

describe("the front page's link preview", () => {
  const html = renderLandingPage();
  const head = html.slice(0, html.indexOf("</head>"));
  /** The content of one meta tag, by its property or name attribute. */
  const meta = (key: string): string | null => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(head)?.[1] ?? null;

  it("carries Open Graph tags that name PayPal and the person", () => {
    expect(meta("og:type")).toBe("website");
    expect(meta("og:site_name")).toBe("Praman");
    expect(meta("og:title")).toContain("PayPal");
    expect(meta("og:description")).toContain("Meera");
    expect(meta("og:url")).toBe("https://praman-demo.onrender.com/");
  });

  it("carries a Twitter card with the same title and description", () => {
    expect(meta("twitter:card")).toBe("summary");
    expect(meta("twitter:title")).toBe(meta("og:title"));
    expect(meta("twitter:description")).toBe(meta("og:description"));
  });

  it("keeps the description short enough for a preview, and the same as the page's own", () => {
    const description = meta("og:description") ?? "";
    expect(description.length).toBeGreaterThan(80);
    expect(description.length).toBeLessThanOrEqual(200);
    expect(meta("description")).toBe(description);
  });

  it("names no preview image, because the app serves none that fits a card", () => {
    expect(meta("og:image")).toBeNull();
    expect(meta("twitter:image")).toBeNull();
  });

  it("has no em dash in any tag", () => {
    expect(head).not.toContain("—");
  });
});

describe("the recorded run", () => {
  it("describes all eight steps to a screen reader, ending with the revocation", () => {
    const html = renderRecordedRunPage();
    expect(html).toContain("after all eight steps");
    expect(html).toContain("MANDATE_REVOKED");
    expect(html).not.toContain("seven steps");
  });

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
