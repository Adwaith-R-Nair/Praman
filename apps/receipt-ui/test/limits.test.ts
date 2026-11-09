import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { generateKeypair } from "@praman/mandate";
import { routeByRail } from "@praman/exec-core";
import { checkEnv, checkStartup, keyFingerprint, DEVELOPER_KEY_FINGERPRINTS } from "../src/startup.js";
import { DemoActivity, runSweeps, scheduleSweeps } from "../src/sweeps.js";
import { HouseBuyer } from "../src/demo/house.js";
import { demoDepsFromEnv, houseStartupNote } from "../src/demo/wiring.js";
import { capFromEnv, clientIp, DbDailyUsage, DEFAULT_DAILY_HOUSE_SESSIONS, DEFAULT_DAILY_SESSIONS, MemoryDailyUsage, RateLimiter } from "../src/demo/limits.js";

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

  it("builds the house buyer only from its secret, with PayPal credentials and a cap above zero", () => {
    const demo = pair();
    const env = { DEMO_MANDATE_PRIVATE_KEY: demo.priv, DEMO_MANDATE_PUBLIC_KEY: demo.pub, PAYPAL_CLIENT_ID: "sb-id", PAYPAL_CLIENT_SECRET: "sb-secret" };
    const houseOf = (e: NodeJS.ProcessEnv) => {
      const wiring = demoDepsFromEnv(e, 4100);
      if (!wiring.ok) throw new Error(wiring.reason);
      return wiring.deps.house ?? null;
    };
    const token = "HOUSETOKEN-77aa-NEVER-SHOWN";
    expect(houseOf(env)).toBeNull();
    expect(houseOf({ ...env, DEMO_HOUSE_BUYER_TOKEN: "" })).toBeNull();
    expect(houseOf({ ...env, DEMO_HOUSE_BUYER_TOKEN: token })).toBeInstanceOf(HouseBuyer);
    expect(houseOf({ ...env, DEMO_HOUSE_BUYER_TOKEN: token })?.holds(token)).toBe(true);
    expect(houseOf({ ...env, DEMO_HOUSE_BUYER_TOKEN: token })?.on).toBe(true);
    expect(houseOf({ ...env, DEMO_HOUSE_BUYER_TOKEN: token, DEMO_DAILY_HOUSE_SESSIONS: "5" })?.on).toBe(true);
    // A cap of zero switches it off with the secret left in place. The server still knows
    // the token, so it can still refuse to delete it at PayPal.
    const paused = houseOf({ ...env, DEMO_HOUSE_BUYER_TOKEN: token, DEMO_DAILY_HOUSE_SESSIONS: "0" });
    expect(paused?.on).toBe(false);
    expect(paused?.holds(token)).toBe(true);
    expect(paused?.offered(new Date())).toBe(false);
    // Nothing to charge it with: off, and still known.
    const noPayPal = houseOf({ DEMO_MANDATE_PRIVATE_KEY: demo.priv, DEMO_MANDATE_PUBLIC_KEY: demo.pub, DEMO_HOUSE_BUYER_TOKEN: token });
    expect(noPayPal?.on).toBe(false);
    expect(noPayPal?.holds(token)).toBe(true);
  });

  it("says at start-up which way the house-buyer switch is, and nothing on a server without the secret", () => {
    const token = "HOUSETOKEN-77aa-NEVER-SHOWN";
    expect(houseStartupNote(null)).toBeNull();
    const on = houseStartupNote(new HouseBuyer(token));
    expect(on).toContain("house buyer on");
    const off = houseStartupNote(new HouseBuyer(token, { on: false }));
    expect(off).toContain("house buyer off");
    expect(off).toContain("not deleted");
    expect(`${on ?? ""}${off ?? ""}`).not.toContain(token);
  });

  it("refuses a house-buyer secret that isn't a token id or has no PayPal credentials, without printing it", () => {
    const creds = { PAYPAL_CLIENT_ID: "sb-id", PAYPAL_CLIENT_SECRET: "sb-secret" };
    const token = "HOUSETOKEN-77aa-NEVER-SHOWN";
    expect(checkEnv({ ...creds, DEMO_HOUSE_BUYER_TOKEN: token })).toEqual([]);
    expect(checkEnv({ ...creds, DEMO_HOUSE_BUYER_TOKEN: "", DEMO_DAILY_HOUSE_SESSIONS: "" })).toEqual([]);
    expect(checkEnv({ ...creds, DEMO_HOUSE_BUYER_TOKEN: token, DEMO_DAILY_HOUSE_SESSIONS: "25" })).toEqual([]);

    const bad = "not a token; drop table";
    const malformed = checkEnv({ ...creds, DEMO_HOUSE_BUYER_TOKEN: bad }).join(" ");
    expect(malformed).toContain("DEMO_HOUSE_BUYER_TOKEN");
    expect(malformed).not.toContain(bad);

    const alone = checkEnv({ DEMO_HOUSE_BUYER_TOKEN: token }).join(" ");
    expect(alone).toContain("PAYPAL_CLIENT_ID");
    expect(alone).not.toContain(token);

    expect(checkEnv({ DEMO_DAILY_HOUSE_SESSIONS: "lots" }).join(" ")).toContain("DEMO_DAILY_HOUSE_SESSIONS must be a whole number");
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
    await schedule.stop();
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
    await schedule.stop();
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
    await schedule.stop();
    expect(runs).toBe(1);
  });

  it("one pass reports what each sweep did, and null for one that failed", async () => {
    const run = await runSweeps({ route: routeByRail([]), now: () => new Date(), log: () => {}, reconcile: async () => 2, release: async () => Promise.reject(new Error("x")) });
    expect(run).toEqual({ resolved: 2, released: null });
  });
});

describe("the limits themselves", () => {
  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE demo_usage`;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a daily cap in the database holds under concurrent takes and survives a new instance", async () => {
    const now = new Date("2026-11-09T23:59:00Z");
    const usage = new DbDailyUsage({ session: 5, model_call: 0 });
    const results = await Promise.all(Array.from({ length: 12 }, () => usage.take("session", now)));
    expect(results.filter(Boolean)).toHaveLength(5);
    // A restart is a new instance over the same table: still full.
    expect(await new DbDailyUsage({ session: 5, model_call: 0 }).take("session", now)).toBe(false);
    // A cap of zero allows none, and the next UTC day starts again.
    expect(await usage.take("model_call", now)).toBe(false);
    expect(await usage.take("session", new Date("2026-11-10T00:00:01Z"))).toBe(true);
    const rows = await prisma.demoUsage.findMany({ orderBy: { day: "asc" } });
    expect(rows.map((r) => [r.day, r.kind, r.used])).toEqual([
      ["2026-11-09", "session", 5],
      ["2026-11-10", "session", 1],
    ]);
  });

  it("counts house-buyer sessions as a kind of their own, and allows none where no cap is given", async () => {
    const now = new Date("2026-11-10T10:00:00Z");
    const usage = new DbDailyUsage({ session: 1, model_call: 0, house_session: 3 });
    const results = await Promise.all(Array.from({ length: 8 }, () => usage.take("house_session", now)));
    expect(results.filter(Boolean)).toHaveLength(3);
    // A restart doesn't refill it, and it is counted apart from the day's sessions.
    expect(await new DbDailyUsage({ session: 1, model_call: 0, house_session: 3 }).take("house_session", now)).toBe(false);
    expect(await usage.take("session", now)).toBe(true);
    // A server with no house buyer gives no cap for it.
    expect(await new DbDailyUsage({ session: 5, model_call: 5 }).take("house_session", new Date("2026-11-11T10:00:00Z"))).toBe(false);
    expect(await new MemoryDailyUsage({ session: 5, model_call: 5 }).take("house_session", now)).toBe(false);
    const rows = await prisma.demoUsage.findMany({ orderBy: { kind: "asc" } });
    expect(rows.map((r) => [r.day, r.kind, r.used])).toEqual([
      ["2026-11-10", "house_session", 3],
      ["2026-11-10", "session", 1],
    ]);
    expect(DEFAULT_DAILY_HOUSE_SESSIONS).toBeGreaterThan(0);
    expect(DEFAULT_DAILY_HOUSE_SESSIONS).toBeLessThan(DEFAULT_DAILY_SESSIONS);
  });

  it("the memory cap counts the same way", async () => {
    const usage = new MemoryDailyUsage({ session: 2, model_call: 1 });
    const now = new Date("2026-11-09T10:00:00Z");
    expect([await usage.take("session", now), await usage.take("session", now), await usage.take("session", now)]).toEqual([true, true, false]);
    expect([await usage.take("model_call", now), await usage.take("model_call", now)]).toEqual([true, false]);
  });

  it("a rate limit allows its count per window, per key, and stays bounded in memory", () => {
    const limiter = new RateLimiter(2, 1_000, 3);
    const t = new Date(0);
    expect([limiter.take("a", t), limiter.take("a", t), limiter.take("a", t)]).toEqual([true, true, false]);
    expect(limiter.take("b", t)).toBe(true);
    expect(limiter.retryAfterSeconds("a", t)).toBe(1);
    expect(limiter.take("a", new Date(1_000))).toBe(true);
    // Many keys never grow the map past its bound; the oldest windows are dropped.
    for (let i = 0; i < 50; i++) limiter.take(`k${i.toString()}`, new Date(5_000 + i * 2_000));
    expect(limiter.take("k49", new Date(5_000 + 49 * 2_000))).toBe(true);
  });

  it("reads the client address from X-Forwarded-For only behind a trusted proxy", () => {
    const req = (xff: string | undefined, remote: string) => ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;
    expect(clientIp(req("203.0.113.7", "10.0.0.2"), 1)).toBe("203.0.113.7");
    expect(clientIp(req("203.0.113.7", "10.0.0.2"), 0)).toBe("10.0.0.2");
    expect(clientIp(req(undefined, "10.0.0.2"), 1)).toBe("10.0.0.2");
  });

  it("takes the address the trusted proxy appended, never one the client wrote in front", () => {
    const req = (xff: string) => ({ headers: { "x-forwarded-for": xff }, socket: { remoteAddress: "10.0.0.2" } }) as unknown as IncomingMessage;
    // A client sends "X-Forwarded-For: 10.0.0.9"; the proxy appends the address it saw.
    expect(clientIp(req("10.0.0.9, 203.0.113.7"), 1)).toBe("203.0.113.7");
    expect(clientIp(req("10.0.0.9,10.0.0.8 , 203.0.113.7"), 1)).toBe("203.0.113.7");
    // Two proxies that each append: the visitor is second from the right.
    expect(clientIp(req("10.0.0.9, 203.0.113.7, 172.16.0.5"), 2)).toBe("203.0.113.7");
    // Fewer entries than proxies: the leftmost is the best there is.
    expect(clientIp(req("203.0.113.7"), 2)).toBe("203.0.113.7");
  });

  it("the number of trusted proxies must be a small whole number", () => {
    expect(checkEnv({ TRUST_PROXY: "1" })).toEqual([]);
    expect(checkEnv({ TRUST_PROXY: "" })).toEqual([]);
    expect(checkEnv({ TRUST_PROXY: "yes" }).join(" ")).toContain("TRUST_PROXY");
    expect(checkEnv({ TRUST_PROXY: "12" }).join(" ")).toContain("TRUST_PROXY");
  });

  it("a cap from the environment must be a whole number", () => {
    expect(capFromEnv({}, "DEMO_DAILY_MODEL_CALLS", 400)).toBe(400);
    expect(capFromEnv({ DEMO_DAILY_MODEL_CALLS: "250" }, "DEMO_DAILY_MODEL_CALLS", 400)).toBe(250);
    expect(() => capFromEnv({ DEMO_DAILY_MODEL_CALLS: "1e9" }, "DEMO_DAILY_MODEL_CALLS", 400)).toThrow();
    expect(checkEnv({ DEMO_DAILY_MODEL_CALLS: "-1" }).join(" ")).toContain("whole number");
  });
});
