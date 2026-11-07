import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateKeypair } from "@praman/mandate";
import { routeByRail } from "@praman/exec-core";
import { checkEnv, checkStartup, keyFingerprint, DEVELOPER_KEY_FINGERPRINTS } from "../src/startup.js";
import { DemoActivity, runSweeps, scheduleSweeps } from "../src/sweeps.js";

// Plan Task 13: what the hosted server refuses, and what it does when it is pushed.

const b64 = (pem: string) => Buffer.from(pem, "utf8").toString("base64");
const pair = () => {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  return { priv: b64(privateKeyPem), pub: b64(publicKeyPem) };
};
const okFetch = async () => ({ status: 200 });

describe("start-up refusals", () => {
  it("refuses to start with non-sandbox paypal or razorpay credentials or base urls", async () => {
    const live = await checkStartup({ PAYPAL_BASE_URL: "https://api-m.paypal.com" }, okFetch);
    expect(live).toMatchObject({ ok: false });
    expect(JSON.stringify(live)).toContain("PAYPAL_BASE_URL");

    const sandbox = await checkStartup({ PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com/" }, okFetch);
    expect(sandbox).toMatchObject({ ok: true });

    const rzpLive = await checkStartup({ RAZORPAY_KEY_ID: "rzp_live_abc", RAZORPAY_KEY_SECRET: "s" }, okFetch);
    expect(JSON.stringify(rzpLive)).toContain("rzp_test_");
    expect(JSON.stringify(rzpLive)).not.toContain("rzp_live_abc");
    expect(await checkStartup({ RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: "s" }, okFetch)).toMatchObject({ ok: true });
    expect(await checkStartup({ RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: "s", RAZORPAY_BASE_URL: "https://example.test" }, okFetch)).toMatchObject({ ok: false });

    // PayPal's sandbox refusing the client id and secret means they aren't sandbox credentials.
    let asked = "";
    const refusing = async (url: string) => {
      asked = url;
      return { status: 401 };
    };
    const liveCreds = await checkStartup({ PAYPAL_CLIENT_ID: "live-id", PAYPAL_CLIENT_SECRET: "live-secret" }, refusing);
    expect(liveCreds).toMatchObject({ ok: false });
    expect(asked).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(JSON.stringify(liveCreds)).not.toContain("live-secret");
    expect(await checkStartup({ PAYPAL_CLIENT_ID: "sb-id", PAYPAL_CLIENT_SECRET: "sb-secret" }, okFetch)).toMatchObject({ ok: true });

    // The sandbox being unreachable doesn't stop the server: every call goes to the sandbox host anyway.
    const down = await checkStartup({ PAYPAL_CLIENT_ID: "sb-id", PAYPAL_CLIENT_SECRET: "sb-secret" }, async () => {
      throw new TypeError("fetch failed");
    });
    expect(down).toMatchObject({ ok: true });
    expect(JSON.stringify(down)).toContain("couldn't be reached");
  });

  it("refuses to start in demo mode with the local mandate key", async () => {
    const local = pair();
    const reused = checkEnv({ MANDATE_PRIVATE_KEY: local.priv, MANDATE_PUBLIC_KEY: local.pub, DEMO_MANDATE_PRIVATE_KEY: local.priv, DEMO_MANDATE_PUBLIC_KEY: local.pub });
    expect(reused.join(" ")).toContain("local mandate key");

    const own = pair();
    expect(checkEnv({ MANDATE_PRIVATE_KEY: local.priv, MANDATE_PUBLIC_KEY: local.pub, DEMO_MANDATE_PRIVATE_KEY: own.priv, DEMO_MANDATE_PUBLIC_KEY: own.pub })).toEqual([]);

    // Halves of two different pairs.
    expect(checkEnv({ DEMO_MANDATE_PRIVATE_KEY: own.priv, DEMO_MANDATE_PUBLIC_KEY: local.pub }).join(" ")).toContain("not the public half");
  });

  it("in production, also refuses a developer's key, the local key being present, and a non-https base url", () => {
    const own = pair();
    const prod = { NODE_ENV: "production", DEMO_MANDATE_PRIVATE_KEY: own.priv, DEMO_MANDATE_PUBLIC_KEY: own.pub, DEMO_BASE_URL: "https://praman-demo.onrender.com" };
    expect(checkEnv(prod)).toEqual([]);
    expect(checkEnv({ ...prod, DEMO_BASE_URL: "http://praman-demo.onrender.com" }).join(" ")).toContain("https://");
    expect(checkEnv({ ...prod, MANDATE_PRIVATE_KEY: pair().priv }).join(" ")).toContain("must not hold the local mandate key");
    expect(checkEnv({ NODE_ENV: "production", DEMO_BASE_URL: "https://x.onrender.com" }).join(" ")).toContain("needed in production");
    // The fingerprint list is checked against the key's public half.
    expect(keyFingerprint(own.priv)).toBe(keyFingerprint(own.pub));
    expect(DEVELOPER_KEY_FINGERPRINTS).not.toContain(keyFingerprint(own.priv));
  });

  it("the real server process exits before listening when a check fails", async () => {
    const server = fileURLToPath(new URL("../src/server.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", server], {
      env: { ...process.env, RAZORPAY_KEY_ID: "rzp_live_not_allowed", RAZORPAY_KEY_SECRET: "x", RECEIPT_UI_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(1);
    expect(output).toContain("refusing to start");
    expect(output).toContain("rzp_test_");
    expect(output).not.toContain("listening");
    expect(output).not.toContain("rzp_live_not_allowed");
  }, 30_000);
});

describe("the in-process sweeps", () => {
  const until = async (done: () => boolean, ms = 2_000) => {
    const start = Date.now();
    while (!done() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 5));
  };

  it("the sweep runs on an interval and one failure does not stop it", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const activity = new DemoActivity();
    activity.touch(new Date());
    let reconcileRuns = 0;
    const schedule = scheduleSweeps({
      route: routeByRail([]),
      now: () => new Date(),
      log: (l) => logs.push(l),
      activity,
      intervalMs: 10,
      reconcile: async () => {
        reconcileRuns += 1;
        calls.push("reconcile");
        if (reconcileRuns === 1) throw new Error("database asleep: postgresql://u:secret@host");
        return 0;
      },
      release: async () => {
        calls.push("release");
        if (reconcileRuns === 2) throw new Error("rail down");
        return 1;
      },
    });
    await until(() => reconcileRuns >= 4);
    schedule.stop();
    expect(reconcileRuns).toBeGreaterThanOrEqual(4);
    // The release ran even in the pass where reconcile threw, and the pass after release threw ran too.
    expect(calls.slice(0, 6)).toEqual(["reconcile", "release", "reconcile", "release", "reconcile", "release"]);
    expect(logs.some((l) => l.includes("reconcile failed"))).toBe(true);
    expect(logs.some((l) => l.includes("release failed"))).toBe(true);
    expect(logs.join("\n")).not.toContain("secret");
  });

  it("runs only while the demo has been used in the last 30 minutes", async () => {
    let now = Date.parse("2026-11-08T10:00:00Z");
    const activity = new DemoActivity();
    let runs = 0;
    const deps = { route: routeByRail([]), now: () => new Date(now), log: () => {}, activity, intervalMs: 60_000, reconcile: async () => (runs += 1, 0), release: async () => 0 };
    const schedule = scheduleSweeps(deps);
    expect(await schedule.tick()).toBe(false);
    activity.touch(new Date(now));
    now += 29 * 60 * 1000;
    expect(await schedule.tick()).toBe(true);
    now += 2 * 60 * 1000;
    expect(await schedule.tick()).toBe(false);
    schedule.stop();
    expect(runs).toBe(1);
  });

  it("a pass never overlaps the one before it", async () => {
    const activity = new DemoActivity();
    activity.touch(new Date());
    let release: () => void = () => {};
    let runs = 0;
    const schedule = scheduleSweeps({
      route: routeByRail([]),
      now: () => new Date(),
      log: () => {},
      activity,
      intervalMs: 60_000,
      reconcile: () => {
        runs += 1;
        return new Promise<number>((r) => (release = () => r(0)));
      },
      release: async () => 0,
    });
    const first = schedule.tick();
    expect(await schedule.tick()).toBe(false);
    release();
    expect(await first).toBe(true);
    schedule.stop();
    expect(runs).toBe(1);
  });

  it("one pass reports what each sweep did, and null for one that failed", async () => {
    const run = await runSweeps({ route: routeByRail([]), now: () => new Date(), log: () => {}, reconcile: async () => 2, release: async () => Promise.reject(new Error("x")) });
    expect(run).toEqual({ resolved: 2, released: null });
  });
});
