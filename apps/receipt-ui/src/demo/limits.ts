import type { IncomingMessage } from "node:http";
import { prisma } from "@praman/db";

/**
 * How many requests one key (an IP address, or a demo session) may make in a window.
 * In memory: losing the counts on a restart only resets a short window. Daily caps,
 * which bound cost, are kept in the database instead (DailyUsage).
 */
export class RateLimiter {
  readonly #hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    /** Past this many keys, expired windows are dropped, so memory stays bounded. */
    private readonly maxKeys = 10_000,
  ) {}

  /** True if this request is allowed, and counts it. */
  take(key: string, now: Date): boolean {
    const t = now.getTime();
    const entry = this.#hits.get(key);
    if (entry === undefined || t >= entry.resetAt) {
      if (this.#hits.size >= this.maxKeys) this.#prune(t);
      this.#hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return this.limit > 0;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }

  /** Seconds until this key may try again. */
  retryAfterSeconds(key: string, now: Date): number {
    const entry = this.#hits.get(key);
    return entry === undefined ? 0 : Math.max(1, Math.ceil((entry.resetAt - now.getTime()) / 1000));
  }

  #prune(t: number): void {
    for (const [key, entry] of this.#hits) if (t >= entry.resetAt) this.#hits.delete(key);
    // Still full of live windows: start over rather than grow without bound.
    if (this.#hits.size >= this.maxKeys) this.#hits.clear();
  }
}

/**
 * Who a request is from, for per-IP limits. `proxyHops` is how many proxies in front of
 * this server append the address they saw to X-Forwarded-For (TRUST_PROXY). Each one
 * appends on the right, and a client can write anything it likes on the left, so the
 * visitor is the entry `proxyHops` from the right: the one the outermost trusted proxy
 * wrote. Never the leftmost, which the client chose. With no trusted proxy (0), the
 * socket's own address.
 */
export function clientIp(req: IncomingMessage, proxyHops: number): string {
  if (proxyHops > 0) {
    const header = req.headers["x-forwarded-for"];
    const entries = (Array.isArray(header) ? header.join(",") : (header ?? ""))
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e !== "");
    const chosen = entries[Math.max(0, entries.length - proxyHops)];
    if (chosen !== undefined) return chosen.slice(0, 64);
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** house_session: a session that used the demo's shared sandbox buyer instead of a PayPal login (D-85). */
export type UsageKind = "session" | "model_call" | "house_session";

/** The demo's daily allowance, shared by every visitor. Resets at 00:00 UTC. */
export interface DailyUsage {
  /** True if one more of this kind fits in today's cap, and counts it. */
  take(kind: UsageKind, now: Date): Promise<boolean>;
}

export interface DailyCaps {
  readonly session: number;
  readonly model_call: number;
  /** Left out on a server with no house buyer, which is a cap of none. */
  readonly house_session?: number;
}

export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * Daily caps kept in Postgres, so a restart doesn't reset them. One statement adds one
 * to today's count only while it is under the cap, so two requests at once can't both
 * take the last one.
 */
export class DbDailyUsage implements DailyUsage {
  constructor(
    readonly caps: DailyCaps,
    private readonly db: typeof prisma = prisma,
  ) {}

  async take(kind: UsageKind, now: Date): Promise<boolean> {
    const cap = this.caps[kind] ?? 0;
    if (cap <= 0) return false;
    const day = utcDay(now);
    const rows = await this.db.$queryRaw<{ used: number }[]>`
      INSERT INTO demo_usage (day, kind, used) VALUES (${day}, ${kind}, 1)
      ON CONFLICT (day, kind) DO UPDATE SET used = demo_usage.used + 1
      WHERE demo_usage.used < ${cap}
      RETURNING used`;
    return rows.length === 1;
  }
}

/** The same caps in memory. For tests, and a server run with no hosted limits to keep. */
export class MemoryDailyUsage implements DailyUsage {
  readonly #used = new Map<string, number>();

  constructor(readonly caps: DailyCaps) {}

  async take(kind: UsageKind, now: Date): Promise<boolean> {
    const key = `${utcDay(now)}|${kind}`;
    const used = this.#used.get(key) ?? 0;
    if (used >= (this.caps[kind] ?? 0)) return false;
    this.#used.set(key, used + 1);
    return true;
  }
}

/** A whole number from the environment, or the default when unset. A bad value is an error, not a guess. */
export function capFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d{1,7}$/.test(raw)) throw new Error(`${name} must be a whole number`);
  return Number(raw);
}

/** Defaults for the hosted demo. DEMO_DAILY_MODEL_CALLS and DEMO_DAILY_SESSIONS override them. */
export const DEFAULT_DAILY_MODEL_CALLS = 400;
export const DEFAULT_DAILY_SESSIONS = 200;
/**
 * Sessions a day that may use the demo's shared sandbox buyer (D-85). A quarter of the
 * day's sessions: the story charges that account $17.00 a session, and no mandate lets a
 * session take more than $60.00, so a full day is $850 of sandbox money as the story
 * goes and $3,000 at the very most. DEMO_DAILY_HOUSE_SESSIONS overrides it.
 */
export const DEFAULT_DAILY_HOUSE_SESSIONS = 50;

/** Per-IP and per-session limits. Generous for a person clicking through the story; tight for a script. */
export const LIMITS = {
  /** New demo sessions from one address. */
  startPerIp: { limit: 5, windowMs: 10 * 60 * 1000 },
  /**
   * Sessions put on the demo's shared sandbox buyer from one address in a day (D-85).
   * Without it, one address starting five sessions every ten minutes could take the whole
   * day's house-buyer sessions in under two hours and leave every later visitor the login.
   * Fifteen leaves room for several people behind one office address.
   */
  housePerIp: { limit: 15, windowMs: 24 * 60 * 60 * 1000 },
  /** Button presses in one session. The story has about fifteen. */
  postsPerSession: { limit: 30, windowMs: 60 * 1000 },
  /** Trace pages, verifications and dispute bundles from one address. Each reads the database. */
  publicPerIp: { limit: 60, windowMs: 60 * 1000 },
  /** Webhook deliveries from one address. Each one is verified with a call to PayPal. */
  webhookPerIp: { limit: 120, windowMs: 60 * 1000 },
} as const;
