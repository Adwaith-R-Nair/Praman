import { defineConfig } from "@playwright/test";

/**
 * The hosted smoke suite: `pnpm e2e:hosted`. Read-only against the live demo apart from
 * one session start, so run it by hand and not in a loop: the demo allows five new
 * sessions per address per ten minutes and a fixed number per day. PRAMAN_HOSTED_URL
 * points it elsewhere.
 */
export default defineConfig({
  testDir: "./hosted",
  outputDir: "../test-screenshots/e2e-hosted",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // The free host can take close to a minute to wake.
  timeout: 150_000,
  forbidOnly: true,
  reporter: [["list"]],
  use: { baseURL: process.env["PRAMAN_HOSTED_URL"] ?? "https://praman-demo.onrender.com", channel: process.env["CHROME_CHANNEL"] ?? "chrome", headless: true, navigationTimeout: 120_000 },
});
