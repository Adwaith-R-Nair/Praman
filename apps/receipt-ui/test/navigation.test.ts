import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append, type EventType } from "@praman/ledger";
import { createApp } from "../src/app.js";
import { ASSETS } from "../src/assets.js";
import { countTraces, listRecentTraceIds } from "../src/data.js";
import { renderIndexPage } from "../src/pages/index.js";
import { renderLandingPage } from "../src/pages/landing.js";
import { renderCheckoutReturnPage, renderErrorPage, renderRecordedRunPage, renderStartPage } from "../src/pages/demo.js";
import { renderTracePage } from "../src/pages/trace.js";

// A visitor who opens a demo step's trace must be able to get back to the demo, and the
// public index must not list demo visitors' traces. Runs against TEST_DATABASE_URL.
beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record RESTART IDENTITY`;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function writeTrace(traceId: string, merchantId: string): Promise<void> {
  const event = (eventType: EventType, payload: Record<string, unknown>) =>
    prisma.$transaction((tx) => append(tx, { traceId, ts: new Date("2026-11-08T10:00:00.000Z"), actor: "system", eventType, payload }));
  await event("intent", { intent_id: traceId, merchant_id: merchantId, mandate_id: "mnd_nav" });
  await event("decision", { mandate_id: "mnd_nav", kind: "ALLOW", reason_code: "OK", amount_minor: "450", currency: "USD" });
}

describe("getting back to the demo from a trace", () => {
  it.each(["DEMO_CAFE", "DEMO_MARKET", "DEMO_HARNESS"])("a %s trace links back to /demo", async (merchant) => {
    await writeTrace("trc_demo_step", merchant);
    const { status, html } = await renderTracePage("trc_demo_step");
    expect(status).toBe(200);
    expect(html).toContain('href="/demo"');
    expect(html).not.toContain("all traces");
  });

  it("a trace that isn't from the demo keeps its link to the index, which now lives at /traces", async () => {
    await writeTrace("trc_other", "MERCHANT_FOOD_01");
    const { html } = await renderTracePage("trc_other");
    expect(html).toContain('href="/traces"');
    expect(html).not.toContain('href="/demo"');
  });
});

describe("getting from the demo to the front page", () => {
  it("every demo page links to the front page at /", () => {
    for (const html of [renderStartPage(null, { paypal: true, model: true }), renderRecordedRunPage(), renderCheckoutReturnPage(false), renderErrorPage()]) {
      expect(html).toContain('<a class="wordmark" href="/">Praman</a>');
    }
  });
});

describe("the index of recent traces", () => {
  it("leaves out every demo visitor's traces, in the list and in the count", async () => {
    await writeTrace("trc_cafe", "DEMO_CAFE");
    await writeTrace("trc_market", "DEMO_MARKET");
    await writeTrace("trc_harness", "DEMO_HARNESS");
    await writeTrace("trc_real", "MERCHANT_FOOD_01");

    expect(await listRecentTraceIds(25)).toEqual(["trc_real"]);
    expect(await countTraces()).toBe(1);
    const html = await renderIndexPage();
    expect(html).not.toContain("trc_cafe");
    expect(html).not.toContain("trc_harness");
    expect(html).toContain("trc_real");
  });

  it("links to the demo", async () => {
    await writeTrace("trc_real", "MERCHANT_FOOD_01");
    expect(await renderIndexPage()).toContain('href="/demo"');
  });

  it("links to the demo even when it has no traces to list", async () => {
    await writeTrace("trc_cafe", "DEMO_CAFE");
    expect(await renderIndexPage()).toContain('href="/demo"');
  });
  it("with nothing to list, speaks to a visitor and gives no developer command", async () => {
    await writeTrace("trc_cafe", "DEMO_CAFE");
    const html = await renderIndexPage();
    expect(html).not.toContain("pnpm");
    expect(html).not.toContain("No traces yet");
    expect(html).toMatch(/<h1[^>]*>[^<]*<a href="\/demo">/);
  });
});

describe("the favicon", () => {
  it("is linked from the front page and served", async () => {
    expect(renderLandingPage()).toContain('rel="icon"');
    expect(ASSETS.get("/favicon.ico")?.contentType).toBe("image/svg+xml");
    expect(ASSETS.get("/favicon.svg")?.body).toContain("<svg");
  });
});

describe("a trace on the simulated rail", () => {
  it("says the payment was simulated", async () => {
    await prisma.$transaction(async (tx) => {
      await append(tx, { traceId: "trc_sim", ts: new Date(), actor: "agent", eventType: "intent", payload: { mandate_id: "mnd_s", model_id: "harness/no-model" } });
      await append(tx, { traceId: "trc_sim", ts: new Date(), actor: "praman", eventType: "decision", payload: { mandate_id: "mnd_s", kind: "ALLOW", reason_code: "OK", amount_minor: "500", currency: "USD" } });
      await append(tx, { traceId: "trc_sim", ts: new Date(), actor: "praman", eventType: "outcome", payload: { mandate_id: "mnd_s", rail: "simulated", order_id: "SIM1", status: "captured", amount_minor: "500", currency: "USD" } });
    });
    expect((await renderTracePage("trc_sim")).html).toContain("Simulated payment.");
  });

  it("doesn't say so on a real rail", async () => {
    await prisma.$transaction(async (tx) => {
      await append(tx, { traceId: "trc_pp", ts: new Date(), actor: "agent", eventType: "intent", payload: { mandate_id: "mnd_s" } });
      await append(tx, { traceId: "trc_pp", ts: new Date(), actor: "praman", eventType: "outcome", payload: { mandate_id: "mnd_s", rail: "paypal", order_id: "PP1", status: "captured", amount_minor: "500", currency: "USD" } });
    });
    expect((await renderTracePage("trc_pp")).html).not.toContain("Simulated payment.");
  });
});

describe("the site root and the index", () => {
  async function get(path: string, accept = "*/*"): Promise<Response> {
    const app = createApp({
      demo: null,
      webhooks: { webhookId: null, verify: async () => false, apply: async () => ({ kind: "ignored", reason: "test" }) as never, now: () => new Date() },
      hsts: false,
      proxyHops: 0,
      onDemoRequest: () => {},
      log: () => {},
    });
    const server = createServer((req, res) => {
      void app(req, res);
    });
    server.listen(0);
    await once(server, "listening");
    try {
      return await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}${path}`, { redirect: "manual", headers: { accept } });
    } finally {
      server.close();
    }
  }

  it.each([
    ["no traces at all", null],
    ["only demo traces, as on a fresh hosted database", "DEMO_CAFE"],
    ["traces outside the demo", "MERCHANT_FOOD_01"],
  ])("/ is the landing page with %s, and leads into the demo", async (_label, merchant) => {
    if (merchant !== null) await writeTrace("trc_root", merchant);
    const res = await get("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<a class="btn[^"]*" href="\/demo">/);
    expect(html).not.toContain("trc_root");
  });

  it("the landing page says the problem, who it is for, and what Praman does, in plain words", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain("can be talked into spending");
    expect(html).toContain("Merchants and platforms");
    expect(html).toContain("give an agent spending authority");
    expect(html).toContain("CATEGORY_OUT_OF_SCOPE");
    expect(html).not.toContain("\u2014");
    expect(html).not.toContain("pnpm");
  });

  it("/traces shows the index when there are traces outside the demo", async () => {
    await writeTrace("trc_real", "MERCHANT_FOOD_01");
    const res = await get("/traces");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("trc_real");
  });

  it("/traces with nothing to list says so and links to the demo, instead of redirecting", async () => {
    await writeTrace("trc_cafe", "DEMO_CAFE");
    const res = await get("/traces");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/demo"');
    expect(html).not.toContain("trc_cafe");
  });

  it("a browser asking for an unknown path gets a page that leads back to the demo", async () => {
    const res = await get("/nope", "text/html,application/xhtml+xml");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('href="/demo"');
  });

  it("a script asking for an unknown path still gets plain text", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });
});

describe("pages work under a content security policy with no inline code", () => {
  /** Anything a CSP without 'unsafe-inline' would block: inline script, style blocks, style or event attributes. */
  function inlineCode(html: string): string[] {
    const found: string[] = [];
    for (const m of html.matchAll(/<script\b([^>]*)>/gi)) if (!/\bsrc=/.test(m[1] ?? "")) found.push(m[0]);
    for (const m of html.matchAll(/<style\b[^>]*>/gi)) found.push(m[0]);
    for (const m of html.matchAll(/<[^>]+\s(style|on[a-z]+)\s*=/gi)) found.push(m[0]);
    return found;
  }

  it("the index and a trace page load script and style only from files", async () => {
    await writeTrace("trc_csp", "MERCHANT_FOOD_01");
    const trace = await renderTracePage("trc_csp");
    expect(inlineCode(trace.html)).toEqual([]);
    expect(trace.html).toContain('<script src="/assets/trace.js" defer></script>');
    expect(trace.html).toContain('data-trace-id="trc_csp"');
    expect(inlineCode(await renderIndexPage())).toEqual([]);
    expect(inlineCode(renderLandingPage())).toEqual([]);
    expect(inlineCode((await renderTracePage("trc_missing")).html)).toEqual([]);
  });

  it("escapes the page title", async () => {
    const { html } = await renderTracePage("<b>x</b>");
    expect(html).not.toContain("<b>x</b>");
  });
});
