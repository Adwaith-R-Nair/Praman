import { expect, expectNoSidewaysScroll, PHONE, test } from "../support.js";

/**
 * The shop's errands (D-93) as a visitor clicks them, against the scripted model and the
 * stand-in PayPal, on a three-product snapshot from the committed Channel3 test fixture.
 * Every errand stops at Praman's decision, so the stand-in PayPal is never asked.
 */
test("errands at the shop are decided, never bought", async ({ page, request }) => {
  const errand = (id: string) => page.locator(`section#${id}`);

  await test.step("start a session and follow the link to the shop", async () => {
    await page.goto("/demo");
    await page.getByRole("button", { name: "Start a session" }).click();
    await page.getByRole("link", { name: "Send the agent on errands at a shop with real products" }).click();
    await expect(page).toHaveURL(/\/demo\/shop$/);
    await expect(page.locator(".shop-pinned")).toContainText("Prices were pinned 2026-11-08 12:00 UTC");
    await expect(page.locator("section.shop-errand")).toHaveCount(3);
  });

  await test.step("a notebook: Praman would ask a person first", async () => {
    await errand("notebook").getByRole("button", { name: "Send the agent" }).click();
    const result = errand("notebook").locator(".result");
    await expect(result).toContainText("Would ask a person first");
    await expect(result.locator("code.code")).toHaveText("STEP_UP_FIRST_MERCHANT");
    await expect(result).toContainText("$37.95 catalog price");
    await expect(result).toContainText("Decided, not bought. Nothing was sent to PayPal.");
    await expect(errand("notebook").locator(".tool-calls")).toContainText("list_catalog");
    await expect(errand("notebook").getByRole("button", { name: "Send the agent" })).toHaveCount(0);
  });

  await test.step("headphones: refused, outside the mandate's categories", async () => {
    await errand("headphones").getByRole("button", { name: "Send the agent" }).click();
    const result = errand("headphones").locator(".result");
    await expect(result).toContainText("Refused");
    await expect(result.locator("code.code")).toHaveText("CATEGORY_OUT_OF_SCOPE");
  });

  await test.step("the trace is on the ledger, and PayPal was never asked", async () => {
    await errand("headphones").getByRole("link", { name: "Ledger trace" }).click();
    await expect(page.locator("h1").first()).toBeVisible();
    await expect(page.locator("body")).toContainText("CATEGORY_OUT_OF_SCOPE");
    const seen: unknown = await (await request.get("/__e2e/paypal")).json();
    expect(seen).toMatchObject({ charges: 0, checkouts: 0 });
  });
});

test.describe("on a phone", () => {
  test.use(PHONE);
  test("the shop page fits", async ({ page }) => {
    await page.goto("/demo");
    await page.getByRole("button", { name: "Start a session" }).click();
    await page.goto("/demo/shop");
    await page.locator("section#kettle").getByRole("button", { name: "Send the agent" }).click();
    await expect(page.locator("section#kettle .result")).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});
