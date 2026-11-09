import { expect, expectNoSidewaysScroll, PHONE, test, watchContext, newWatch } from "../support.js";

/**
 * The demo story as a visitor clicks it, in one session, against the stand-in PayPal
 * and scripted model. The order matters, as it does for a real visitor, so it is one
 * test with named steps.
 */

const PAYPAL = "https://www.sandbox.paypal.com/";

test("the whole story, its trace, a refund, the console and the revocation", async ({ page, request }) => {
  const paypalSaw = async () => {
    const seen: unknown = await (await request.get("/__e2e/paypal")).json();
    return seen;
  };
  const press = (name: string) => page.getByRole("button", { name, exact: true }).click();
  const step = (id: string) => page.locator(`section#${id}`);

  await test.step("start a session and see the signed mandate", async () => {
    await page.goto("/demo");
    await press("Start a session");
    await expect(page).toHaveURL(/\/demo$/);
    const mandate = step("mandate");
    await expect(mandate).toContainText("$60.00");
    await expect(mandate).toContainText("$40.00");
    await expect(mandate).toContainText("$20.00");
    await expect(step("first").getByRole("button", { name: "Ask the agent to buy lunch" })).toBeDisabled();
    // The poisoned listing is step 2, ahead of connecting PayPal, and revoking is last.
    await expect(page.locator("section.step")).toHaveCount(8);
    await expect(page.locator("section.step").nth(1)).toHaveAttribute("id", "injection");
    await expect(page.locator("section.step").nth(2)).toHaveAttribute("id", "connect");
    await expect(page.locator("section.step").nth(7)).toHaveAttribute("id", "revoke");
  });

  await test.step("a poisoned listing first, with no PayPal connected: the live model, then a fooled cart refused", async () => {
    await expect(step("connect").locator(".ok")).toHaveCount(0);
    await press("Ask the agent to order at Corner Market");
    const injection = step("injection");
    await expect(injection.locator(".message").first()).toContainText("The agent ignored the poisoned line");
    await press("Send the fooled cart to Praman");
    await expect(injection.locator('.result[data-state="refused"]')).toContainText("Refused");
    await expect(injection.locator('.result[data-state="refused"] code.code')).toHaveText("CATEGORY_OUT_OF_SCOPE");
    const noGate = injection.locator(".no-gate");
    await expect(noGate).toContainText("Arithmetic, not a payment");
    await expect(noGate.locator(".no-gate-total")).toHaveText("$109.00");
    await expect(noGate).toContainText("Nothing was charged.");
    await expect(injection.locator(".recording figcaption")).toContainText("Recorded run, not live.");
    await expect(injection.locator(".recording figcaption")).toContainText("in US dollars");
    expect(await paypalSaw()).toMatchObject({ charges: 0, checkouts: 0 });
  });

  await test.step("connect PayPal without the page ever seeing the saved method", async () => {
    await press("Connect PayPal");
    await page.locator("#approve").click();
    await expect(step("connect").locator(".ok")).toContainText("Connected");
    expect(await page.content()).not.toContain("PAYTOKEN");
  });

  await test.step("first purchase stops for approval, then charges the saved account", async () => {
    await press("Ask the agent to buy lunch");
    const first = step("first");
    await expect(first.locator(".result")).toHaveAttribute("data-state", "awaiting_approval");
    await expect(first.locator(".stamp")).toHaveText("Asked you first");
    await expect(first.locator(".amount")).toHaveText("$12.50");
    expect(await paypalSaw()).toMatchObject({ charges: 0 });
    await press("Approve this purchase");
    await expect(first.locator(".result")).toHaveAttribute("data-state", "done");
    await expect(first).toContainText("$12.50 charged to the saved PayPal account");
    expect(await paypalSaw()).toMatchObject({ charges: 1 });
  });

  await test.step("second purchase is allowed and paid with nobody approving", async () => {
    await step("second").getByRole("button", { name: "Ask the agent to buy a coffee" }).click();
    const second = step("second");
    await expect(second.locator(".result")).toHaveAttribute("data-state", "done");
    await expect(second.locator(".stamp")).toHaveText("Allowed");
    await expect(second.locator(".spotlight")).toContainText("Only Praman's ALLOW");
    expect(await paypalSaw()).toMatchObject({ charges: 2 });
  });

  await test.step("large purchase goes through a checkout and is only captured once the buyer approved", async () => {
    await press("Ask the agent to buy a team lunch");
    const large = step("large");
    await expect(large.locator(".result")).toHaveAttribute("data-state", "awaiting_approval");
    await press("Approve this purchase");
    await expect(large.locator(".result")).toHaveAttribute("data-state", "awaiting_checkout");
    expect(await large.getByLabel("PayPal checkout link").inputValue()).toContain(`${PAYPAL}checkoutnow`);
    expect(await paypalSaw()).toMatchObject({ charges: 2, checkouts: 1 });

    await press("Capture the payment");
    await expect(large.locator(".result")).toHaveAttribute("data-state", "awaiting_checkout");
    await expect(large.locator(".message")).toContainText("hasn't approved this payment yet");

    await request.post("/__e2e/paypal");
    await press("Capture the payment");
    await expect(large.locator(".result")).toHaveAttribute("data-state", "done");
    await expect(large).toContainText("$32.00 captured after the buyer approved at PayPal.");
  });

  await test.step("twenty at once: the budget holds", async () => {
    await press("Send twenty at once");
    const harness = step("concurrency").locator(".harness");
    await expect(harness.locator(".harness-line")).toHaveText("5 of 20 paid.");
    await expect(harness.locator(".message")).toContainText("Spend stayed within the budget.");
    await expect(harness.locator(".message")).toContainText("Model calls: 0.");
  });

  await test.step("the trace page verifies its chain and refunds the purchase once", async () => {
    await step("first").getByRole("link", { name: "Ledger trace" }).click();
    await expect(page).toHaveURL(/\/demo\/r\/first$/);
    await page.locator("#verify-btn").click();
    await expect(page.locator("#verify-state")).toHaveText(/^chain verified through \d+ entries$/);

    await press("Refund $12.50");
    await expect(page).toHaveURL(/\/demo\/r\/first#refund$/);
    await expect(page.locator("#refund-control .notice")).toContainText("Refunded in full");
    await expect(page.getByRole("button", { name: "Refund $12.50" })).toHaveCount(0);
    expect(await paypalSaw()).toMatchObject({ refunds: 1 });

    await page.goto("/demo");
    await expect(step("first")).toContainText("Refunded to the buyer. The mandate's budget still counts it.");
  });

  await test.step("the dispute bundle downloads as JSON", async () => {
    const href = await step("first").getByRole("link", { name: "Dispute bundle" }).getAttribute("href");
    // The visitor's own copy: their session cookie is what proves they own it.
    expect(href).toBe("/demo/dispute/first");
    const bundle = await page.request.get(href ?? "/missing");
    expect(bundle.status()).toBe(200);
    expect(bundle.headers()["content-disposition"]).toContain("attachment");
    const own = JSON.stringify(await bundle.json());
    expect(own).not.toContain("PAYTOKEN");
    expect(own).toContain("max_total_minor");

    // Anyone else with the trace id gets the verdict and no limits.
    const traceId = (await step("first").locator(".trace-id").textContent()) ?? "";
    const publicBundle = await request.get(`/dispute/${encodeURIComponent(traceId)}`);
    expect(publicBundle.status()).toBe(200);
    expect(JSON.stringify(await publicBundle.json())).not.toContain("max_total_minor");
  });

  await test.step("revoking refuses the agent's next purchase before it reaches PayPal", async () => {
    await press("Revoke the mandate");
    const revoke = step("revoke");
    await expect(step("mandate").locator(".revoked-line")).toContainText("Revoked.");
    await revoke.getByRole("button", { name: "Ask the agent to buy a coffee" }).click();
    await expect(revoke.locator('.result[data-state="refused"]')).toBeVisible();
    await expect(revoke.locator("code.code")).toHaveText("MANDATE_REVOKED");
    await expect(revoke.locator(".agent-view code")).toContainText("DENY");
    expect(await paypalSaw()).toMatchObject({ charges: 2, checkouts: 1 });
  });

  await test.step("the console shows the session's rows, the chain intact and the revocation", async () => {
    await page.getByRole("link", { name: "Open your ledger console" }).click();
    await expect(page).toHaveURL(/\/demo\/console$/);
    await expect(page.locator("#chain-stamp")).toHaveText("Chain verified");
    await expect(page.locator("#chain")).toHaveAttribute("data-state", "ok");
    await expect(page.locator("#count")).toHaveText(/^\d+ rows$/);
    await expect(page.locator("#chart-reasons canvas")).toBeVisible();
    await expect(page.locator('#grid [role="row"][row-id]').first()).toBeVisible();

    await page.locator("#quick").fill("mandate_revoked");
    await expect(page.locator("#count")).toHaveText(/^1 of \d+ rows$/);
    await page.locator('#grid [role="row"][row-id] [role="gridcell"]').first().click();
    await expect(page.locator("#detail")).not.toContainText("Select a row");
  });
});

test.describe("without a session", () => {
  test("the start page, the recorded run and the empty console", async ({ page, watch }) => {
    expect(watch.expected).toEqual([]);
    await page.goto("/demo");
    await expect(page.locator(".persona")).toContainText("Meera gives her shopping agent");
    await expect(page.getByRole("button", { name: "Start a session" })).toBeEnabled();
    await page.goto("/demo/recorded");
    await expect(page.locator("figcaption")).toContainText("Recorded run, not live.");
    await page.goto("/demo/console");
    await expect(page.locator(".notice")).toContainText("no demo session in this browser");
  });

  test("the public pages fit a phone", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ ...PHONE, baseURL: baseURL ?? "" });
    const watch = newWatch();
    await watchContext(context, new URL(baseURL ?? "").origin, watch);
    const page = await context.newPage();
    for (const path of ["/", "/demo", "/demo/recorded", "/traces"]) {
      await page.goto(path);
      await expectNoSidewaysScroll(page);
    }
    await context.close();
    expect(watch.problems).toEqual([]);
  });
});
