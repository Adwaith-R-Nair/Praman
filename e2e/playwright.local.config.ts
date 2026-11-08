import { defineConfig } from "@playwright/test";

const PORT = 4190;
const baseURL = `http://localhost:${PORT.toString()}`;

/**
 * The local browser suite: `pnpm e2e`. Starts e2e/local-server.ts, the real app against
 * a throwaway database with PayPal and the model stood in, so it needs no credentials
 * and reaches nothing outside this machine. Drives the installed Chrome (CHROME_CHANNEL,
 * default chrome), the same browser scripts/screenshots.ts uses, so nothing is downloaded.
 */
export default defineConfig({
  testDir: "./local",
  outputDir: "../test-screenshots/e2e-local",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  forbidOnly: true,
  reporter: [["list"]],
  use: { baseURL, channel: process.env["CHROME_CHANNEL"] ?? "chrome", headless: true, trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec tsx e2e/local-server.ts",
    cwd: "..",
    port: PORT,
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { TSX_DISABLE_CACHE: "1", E2E_PORT: PORT.toString() },
  },
});
