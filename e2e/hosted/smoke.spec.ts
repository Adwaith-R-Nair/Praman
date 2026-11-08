import { expect, expectNoSidewaysScroll, PHONE, test, watchContext, newWatch } from "../support.js";

/**
 * The live demo, from outside. One session start in the whole file; the rest are reads.
 * A session start refused by the per-address limit, or a day whose sessions are used up,
 * is the demo working as designed, so the test says so and stops there.
 */

const PAGES = ["/", "/demo", "/demo/recorded", "/traces"];

const NEEDED_HEADERS: Readonly<Record<string, RegExp>> = {
  "content-security-policy": /default-src 'none'/,
  "x-content-type-options": /^nosniff$/,
  "x-frame-options": /^DENY$/,
  "referrer-policy": /^same-origin$/,
  "cross-origin-opener-policy": /^same-origin$/,
  "permissions-policy": /payment=\(\)/,
  "strict-transport-security": /max-age=\d+/,
};

test("healthz answers ok with the security headers", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe("ok");
  for (const [name, shape] of Object.entries(NEEDED_HEADERS)) expect(res.headers()[name], name).toMatch(shape);
});

for (const path of PAGES) {
  test(`${path} loads clean and carries the security headers`, async ({ page }) => {
    const res = await page.goto(path);
    if (res === null) throw new Error(`no response for ${path}`);
    expect(res.status()).toBe(200);
    const headers = await res.allHeaders();
    for (const [name, shape] of Object.entries(NEEDED_HEADERS)) expect(headers[name], name).toMatch(shape);
    await expect(page.locator("h1").first()).toBeVisible();
  });
}

test("the public pages fit a phone", async ({ browser, baseURL }) => {
  const origin = new URL(baseURL ?? "").origin;
  const context = await browser.newContext({ ...PHONE, baseURL: origin });
  const watch = newWatch();
  await watchContext(context, origin, watch);
  const page = await context.newPage();
  for (const path of PAGES) {
    await page.goto(path);
    await expectNoSidewaysScroll(page);
  }
  await context.close();
  expect(watch.problems).toEqual([]);
});

test("one session start shows a signed mandate and an empty console", async ({ page }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start a session" }).click();
  await page.waitForLoadState("load");

  if (new URL(page.url()).pathname === "/demo/recorded") {
    console.log("session start: today's sessions are used up, so the recorded run was shown");
    await expect(page.locator("figcaption")).toContainText("Recorded run, not live.");
    return;
  }
  if ((await page.locator("h1").first().textContent()) === "Too many requests") {
    console.log("session start: the per-address session limit answered, as designed");
    return;
  }

  console.log("session start: a new session opened");
  const mandate = page.locator("section#mandate");
  await expect(mandate).toContainText("$60.00");
  await expect(mandate).toContainText("$40.00");
  await expectNoSidewaysScroll(page);

  await page.goto("/demo/console");
  await expect(page.locator("#chain-stamp")).toHaveText("Chain verified", { timeout: 60_000 });
  await expect(page.locator("#count")).toHaveText("0 rows");
});
