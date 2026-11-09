import { expect, expectNoSidewaysScroll, PHONE, test, watchContext, newWatch } from "../support.js";

/**
 * The public sample at /sample, from outside. Reads only: no session is started and
 * nothing is posted. A server with no sample set (SAMPLE_MANDATE_IDS unset) is a valid
 * state, so the test checks that nothing links to the page and stops there.
 */

/** What no public page or public JSON may carry (D-84). */
const WITHHELD = ["STEP_UP_", "signed_mandate", "public_key_pem", "redaction_salt", "max_total_minor", "max_per_txn_minor", "threshold_minor"];

test("the sample run is populated and public, or absent and unlinked", async ({ page, request, browser, baseURL, watch: pageWatch }) => {
  // With no sample set the page is a 404 by design, and the browser logs that one answer.
  pageWatch.expected.push(/\/sample: Failed to load resource: the server responded with a status of 404/);
  const res = await page.goto("/sample");
  if (res === null) throw new Error("no response for /sample");

  if (res.status() === 404) {
    console.log("sample: none is set on this server");
    await expect(page.locator("h1")).toHaveText("No sample run on this server");
    for (const path of ["/traces", "/demo/console"]) {
      await page.goto(path);
      await expect(page.locator('a[href="/sample"]'), path).toHaveCount(0);
    }
    return;
  }

  expect(res.status()).toBe(200);
  expect((await res.allHeaders())["content-security-policy"]).toMatch(/style-src 'self' 'nonce-[^']+' https/);
  await expect(page.locator("#chain-stamp")).toHaveText("Chain verified", { timeout: 90_000 });
  await expect(page.locator("#count")).toHaveText(/^[1-9]\d* rows$/);
  await expect(page.locator(".ag-row").first()).toBeVisible();
  const html = await page.content();
  for (const word of WITHHELD) expect(html, word).not.toContain(word);

  const data = await request.get("/sample/data");
  expect(data.status()).toBe(200);
  const json = await data.text();
  for (const word of WITHHELD) expect(json, word).not.toContain(word);
  const parsed: unknown = JSON.parse(json);
  const spend = typeof parsed === "object" && parsed !== null && "spend" in parsed && Array.isArray(parsed.spend) ? parsed.spend : [];
  for (const series of spend) expect(series).toMatchObject({ budgetMinor: null, budgetLabel: null });
  console.log(`sample: populated, ${(await page.locator("#count").textContent()) ?? ""}`);

  // The reader's own recheck of the rows runs in the browser and agrees with the server.
  await page.getByRole("button", { name: "Recheck these rows in my browser" }).click();
  await expect(page.locator("#chain-browser-text")).toHaveText(/^Rechecked in this browser with WebCrypto\. \d+ entry hash(es)? recomputed from the rows below, (all )?matching\./);

  // Every trace line leads to a public trace page and a public bundle. The first is opened.
  const firstTrace = page.locator(".sample-trace-main").first();
  const firstBundle = page.locator(".sample-trace-bundle").first();
  const traceHref = (await firstTrace.getAttribute("href")) ?? "";
  const bundleHref = (await firstBundle.getAttribute("href")) ?? "";
  expect(traceHref).toMatch(/^\/r\//);
  expect(bundleHref).toMatch(/^\/dispute\//);
  const bundle = await request.get(bundleHref);
  expect(bundle.status()).toBe(200);
  const bundleText = await bundle.text();
  // The bundle names the fields it withholds, so only the limits themselves are looked for.
  for (const word of ["max_total_minor", "threshold_minor", "STEP_UP_"]) expect(bundleText, word).not.toContain(word);

  await firstTrace.click();
  await expect(page).toHaveURL(new RegExp(`${traceHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(page.locator("h1.decision")).toBeVisible();
  await expect(page.locator('a[href^="/sample#trace="]')).toBeVisible();
  await expect(page.locator('nav a[href="/sample"]')).toBeVisible();
  // On that trace, the browser's own check of the page's rows passes.
  await page.getByRole("button", { name: "Verify in my browser" }).click();
  await expect(page.locator("#bv-result")).toHaveText(/^Verified in this browser\./);

  // The other pages say where the sample is.
  await page.goto("/traces");
  await expect(page.locator('a[href="/sample"]')).toBeVisible();

  const origin = new URL(baseURL ?? "").origin;
  const context = await browser.newContext({ ...PHONE, baseURL: origin });
  const watch = newWatch();
  await watchContext(context, origin, watch);
  const phone = await context.newPage();
  await phone.goto("/sample");
  await expect(phone.locator("#chain-stamp")).toHaveText("Chain verified", { timeout: 90_000 });
  await expectNoSidewaysScroll(phone);
  await context.close();
  expect(watch.problems).toEqual([]);
});
