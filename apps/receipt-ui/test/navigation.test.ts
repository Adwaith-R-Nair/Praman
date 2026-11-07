import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append, type EventType } from "@praman/ledger";
import { countTraces, listRecentTraceIds } from "../src/data.js";
import { renderIndexPage } from "../src/pages/index.js";
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

  it("a trace that isn't from the demo keeps its link to the index", async () => {
    await writeTrace("trc_other", "MERCHANT_FOOD_01");
    const { html } = await renderTracePage("trc_other");
    expect(html).toContain('href="/"');
    expect(html).not.toContain('href="/demo"');
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
});
