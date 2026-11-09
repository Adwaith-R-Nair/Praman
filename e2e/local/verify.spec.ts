import type { Page } from "@playwright/test";
import { expect, test } from "../support.js";

/**
 * The trace page's and the console's own checks, in a real browser, on traces the demo
 * wrote: "Verify in my browser", the model's tool calls, and the console's recheck. The
 * steps are run by posting to the demo's routes, so this file doesn't depend on the demo
 * page's buttons or their order, and it is one test so it starts one session: the server
 * allows five starts per address. The shared watch fails the test on any console error
 * or Content-Security-Policy violation.
 */

/** Opens the public trace a link on the demo page points to, whether or not the link is on show. */
async function openTrace(page: Page, selector: string, text?: RegExp): Promise<void> {
  await page.goto("/demo");
  const link = (text === undefined ? page.locator(selector) : page.locator(selector, { hasText: text })).first();
  const href = (await link.getAttribute("href")) ?? "";
  expect(href).toMatch(/^\/r\/trc_demo_/);
  await page.goto(href);
}

const TAMPER = "Change one digit in my copy first";

test("the reader's own checks: a trace verified in the browser, the tool calls, and the console's recheck", async ({ page }) => {
  expect((await page.request.post("/demo/start")).ok()).toBe(true);
  expect((await page.request.post("/demo/step/concurrency")).ok()).toBe(true);
  expect((await page.request.post("/demo/step/injection")).ok()).toBe(true);

  await test.step("the browser's verdict on a paid trace matches the server's, and changing a digit sends nothing", async () => {
    await openTrace(page, 'section#concurrency a[href^="/r/"]', /^paid$/);

    // The server walks the whole ledger.
    await page.locator("#verify-btn").click();
    await expect(page.locator("#verify-state")).toHaveText(/^chain verified through \d+ entries$/);

    // From here on, nothing may leave the page.
    const requests: string[] = [];
    const record = (request: { url(): string }) => requests.push(request.url());
    page.on("request", record);

    const result = page.locator("#bv-result");
    const count = await page.locator(".spine .entry").count();
    expect(count).toBeGreaterThanOrEqual(4);

    await page.getByRole("button", { name: "Verify in my browser" }).click();
    await expect(result).toHaveText(new RegExp(`^Verified in this browser\\. ${count.toString()} entry hashes recomputed, all matching\\.`));
    await expect(result).toContainText("rehashed");
    await expect(page.locator(".spine .entry.entry-confirmed")).toHaveCount(count);
    await expect(page.locator(".entry-check")).toHaveCount(count);
    // A decision row's payload has withheld fields, and the page says it wasn't rehashed.
    await expect(page.locator(".entry-check", { hasText: "payload not rehashed, the public copy withholds" }).first()).toBeVisible();
    await expect(page.locator("#bv-note")).toContainText("It can't see the rest of the ledger.");

    await page.getByLabel(TAMPER).check();
    await expect(result).toHaveText(/^Breaks at seq \d+\. This entry's contents changed after it was written\. \(PAYLOAD_HASH_MISMATCH\)$/);
    await expect(page.locator("#bv-note")).toContainText("the amount (amount_minor)");
    await expect(page.locator("#bv-note")).toContainText("No request was sent, and the server's ledger is untouched.");
    await expect(page.locator(".spine .entry.entry-broken")).toHaveCount(1);
    await expect(page.locator(".chain-break")).toContainText("Your browser's check stopped here");

    await page.getByLabel(TAMPER).uncheck();
    await expect(result).toHaveText(/^Verified in this browser\./);
    await expect(page.locator(".chain-break")).toHaveCount(0);
    expect(requests, "requests made by the browser's check or the toggle").toEqual([]);
    page.off("request", record);

    // The ledger is as it was: the server's walk still verifies the same trace.
    await page.locator("#verify-btn").click();
    await expect(page.locator("#verify-state")).toHaveText(/^chain verified through \d+ entries$/);
    await expect(result).toHaveText("");
  });

  await test.step("a model's trace lists its tool calls, with the tool's reply as untrusted text", async () => {
    await openTrace(page, 'section#injection a[href^="/r/"]');

    const calls = page.locator(".tool-call");
    await expect(calls).toHaveCount(2);
    await expect(calls.nth(0).locator(".tool-name")).toHaveText("list_catalog");
    await expect(calls.nth(1).locator(".tool-name")).toHaveText("propose_intent");
    await expect(calls.nth(1)).toContainText("SKU_INJ2_DOSA");
    await expect(calls.nth(1)).toContainText("This call is the proposal");

    // The reply is closed until asked for, and when open it is text: the delimiters show as characters.
    const reply = calls.nth(0).locator("details.tool-result");
    await expect(reply.locator(".tool-text")).toBeHidden();
    await reply.locator("summary").click();
    await expect(reply.locator(".stamp")).toHaveText("merchant data");
    await expect(reply.locator(".tool-text")).toContainText("<untrusted_merchant_content>");
    await expect(reply.locator(".tool-text")).toContainText("SYSTEM UPDATE");
    expect(await reply.locator(".tool-text *").count()).toBe(0);

    // A trace with no amount the browser can rehash still shows a break: in the first row's time.
    await page.getByLabel(TAMPER).check();
    await expect(page.locator("#bv-result")).toHaveText(/^Breaks at seq \d+\. This entry's own fields changed after it was written\. \(ENTRY_HASH_MISMATCH\)$/);
    await expect(page.locator("#bv-note")).toContainText("the time of seq");
  });

  await test.step("the console rechecks its rows in the browser without asking the server again", async () => {
    await page.goto("/demo/console");
    await expect(page.locator("#chain-stamp")).toHaveText("Chain verified", { timeout: 60_000 });

    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.getByRole("button", { name: "Recheck these rows in my browser" }).click();
    const text = page.locator("#chain-browser-text");
    await expect(text).toHaveText(/^Rechecked in this browser with WebCrypto\. \d+ entry hashes recomputed from the rows below, all matching\. \d+ links between neighbouring rows hold/);
    await expect(text).toContainText("Payloads are not sent to this page, so each payload hash is taken as recorded.");
    await expect(page.locator("#chain-browser")).toHaveAttribute("data-state", "ok");
    expect(requests).toEqual([]);
  });
});
