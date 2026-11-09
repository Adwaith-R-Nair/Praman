import { expect, expectNoSidewaysScroll, PHONE, test } from "../support.js";

/**
 * The demo's shared sandbox buyer (D-85) as a visitor meets it, against the stand-in
 * PayPal. The header below picks the local server's second demo, the one built with a
 * stand-in house token, the way a hosted server with DEMO_HOUSE_BUYER_TOKEN set would be.
 * story.spec.ts runs without it and checks the choice is absent there.
 */

const HOUSE_TOKEN = "E2E-HOUSE-TOKEN";

test.use({ extraHTTPHeaders: { "x-e2e-house": "1" } });

interface PayPalSaw {
  readonly charges: number;
  readonly house_charges: number;
  readonly checkouts: number;
  readonly deleted: number;
}

test("a visitor pays for the small purchases with no PayPal login, and the checkout still needs a buyer", async ({ page, request }) => {
  const paypalSaw = async (): Promise<PayPalSaw> => {
    const seen: PayPalSaw = await (await request.get("/__e2e/paypal")).json();
    return seen;
  };
  const press = (name: string) => page.getByRole("button", { name, exact: true }).click();
  const step = (id: string) => page.locator(`section#${id}`);
  const before = await paypalSaw();

  await test.step("the start page says the small purchases need no login", async () => {
    await page.goto("/demo");
    await expect(page.locator("section.start")).toContainText("with no PayPal login");
    await expect(page.locator("section.start .persona")).toContainText("Meera");
    await press("Start a session");
  });

  await test.step("step 3 offers both ways to connect, the login first", async () => {
    await expect(page.locator("section.step").nth(2)).toHaveAttribute("id", "connect");
    const buttons = step("connect").locator(".actions button");
    await expect(buttons).toHaveText(["Connect PayPal", "Use the demo's sandbox buyer"]);
    await expect(step("connect")).toContainText("sandbox money only");
    await expect(step("first").getByRole("button", { name: "Ask the agent to buy lunch" })).toBeDisabled();
    // Two buttons in one row is the widest this step gets, so it is held to a phone's width here.
    const desktop = page.viewportSize();
    await page.setViewportSize(PHONE.viewport);
    await expectNoSidewaysScroll(page);
    await expect(page.getByRole("button", { name: "Use the demo's sandbox buyer" })).toBeVisible();
    if (desktop !== null) await page.setViewportSize(desktop);
  });

  await test.step("choosing the demo's buyer connects without leaving the page", async () => {
    await press("Use the demo's sandbox buyer");
    await expect(page).toHaveURL(/\/demo#connect$/);
    await expect(step("connect").locator(".ok")).toContainText("Connected to the demo's sandbox buyer");
    await expect(step("connect").locator(".ok")).toContainText("It stays saved at PayPal when your session ends.");
    await expect(page.getByRole("button", { name: "Use the demo's sandbox buyer" })).toHaveCount(0);
    await expect(page.locator("footer.end")).toContainText("stays saved at PayPal for other visitors");
    expect(await paypalSaw()).toMatchObject({ charges: before.charges, house_charges: before.house_charges });
  });

  await test.step("the first purchase still stops for approval, then charges the demo's buyer", async () => {
    await press("Ask the agent to buy lunch");
    const first = step("first");
    await expect(first.locator(".result")).toHaveAttribute("data-state", "awaiting_approval");
    await expect(first.locator(".approval code.code")).toHaveText("STEP_UP_FIRST_MERCHANT");
    expect(await paypalSaw()).toMatchObject({ house_charges: before.house_charges });
    await press("Approve");
    await expect(first.locator(".result")).toHaveAttribute("data-state", "done");
    await expect(first).toContainText("Paid from the demo's sandbox buyer account, with no buyer present.");
    await expect(first.locator(".presence")).toHaveText("Buyer not present, approved earlier in the signed mandate");
    expect(await paypalSaw()).toMatchObject({ charges: before.charges + 1, house_charges: before.house_charges + 1 });
  });

  await test.step("the second purchase is allowed and charged with nobody approving", async () => {
    await step("second").getByRole("button", { name: "Ask the agent to buy a coffee" }).click();
    await expect(step("second").locator(".stamp")).toHaveText("Allowed");
    await expect(step("second")).toContainText("Paid from the demo's sandbox buyer account");
    expect(await paypalSaw()).toMatchObject({ house_charges: before.house_charges + 2, checkouts: before.checkouts });
  });

  await test.step("the large purchase is not charged to the demo's buyer: it goes to PayPal's checkout", async () => {
    await press("Ask the agent to buy a team lunch");
    const large = step("large");
    await expect(large.locator(".result")).toHaveAttribute("data-state", "awaiting_approval");
    await press("Approve");
    await expect(large.locator(".result")).toHaveAttribute("data-state", "awaiting_checkout");
    await expect(large.locator(".presence")).toHaveText("Buyer present");
    await expect(large.locator(".checkout")).toContainText("needs a buyer at PayPal's checkout");
    await expect(large.locator(".checkout")).toContainText("Without that login this purchase stays unpaid and nothing is charged.");
    await expect(large.locator(".checkout")).not.toContainText("logged this window in");
    expect(await paypalSaw()).toMatchObject({ house_charges: before.house_charges + 2, checkouts: before.checkouts + 1 });
  });

  await test.step("the page never carries the token, and ending the session deletes nothing at PayPal", async () => {
    expect(await page.content()).not.toContain(HOUSE_TOKEN);
    await press("End this session");
    await expect(page.getByRole("button", { name: "Start a session" })).toBeVisible();
    expect(await paypalSaw()).toMatchObject({ deleted: before.deleted });
  });
});
