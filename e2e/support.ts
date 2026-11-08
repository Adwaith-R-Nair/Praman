import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * Shared by both suites. Every page in a test is watched for browser console errors,
 * uncaught exceptions and Content-Security-Policy violations, and a test fails if any
 * were seen. The browser may talk only to the server under test: Google's font
 * stylesheet is answered with nothing, so no third party is contacted, and any other
 * outside address is blocked and fails the test.
 */

export interface Watch {
  readonly problems: string[];
  /** Problems a test expects, so the rest still fail it. */
  readonly expected: RegExp[];
}

const isFont = (url: URL): boolean => url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";

export function newWatch(): Watch {
  return { problems: [], expected: [] };
}

function note(watch: Watch, problem: string): void {
  if (!watch.expected.some((shape) => shape.test(problem))) watch.problems.push(problem);
}

export async function watchContext(context: BrowserContext, origin: string, watch: Watch): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (isFont(url)) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    return route.abort();
  });
  // Routing doesn't see the hops of a redirect, so outside requests are caught here.
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin && !isFont(url)) note(watch, `request left the server under test: ${url.origin}${url.pathname}`);
  });
  context.on("page", (page) => watchPage(page, watch));
}

function watchPage(page: Page, watch: Watch): void {
  page.on("console", (message) => {
    if (message.type() === "error") note(watch, `console error on ${page.url()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => note(watch, `uncaught exception on ${page.url()}: ${error.message}`));
}

interface Fixtures {
  watch: Watch;
}

export const test = base.extend<Fixtures>({
  watch: [
    async ({ context, baseURL }, use) => {
      if (baseURL === undefined) throw new Error("the suite has no baseURL");
      const watch = newWatch();
      await watchContext(context, new URL(baseURL).origin, watch);
      await use(watch);
      expect(watch.problems, "browser console errors, CSP violations or outside requests").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** The page is no wider than the screen, so a phone never scrolls sideways. */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const [scrollWidth, clientWidth] = await page.evaluate<[number, number]>("[document.documentElement.scrollWidth, document.documentElement.clientWidth]");
  expect(scrollWidth, `${page.url()} scrolls sideways`).toBeLessThanOrEqual(clientWidth);
}

export const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } as const;
