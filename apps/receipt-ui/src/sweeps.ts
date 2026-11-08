import { reconcilePending, releaseStaleOrders } from "@praman/control-plane";
import type { ExecutorRouter } from "@praman/exec-core";

/** How often the sweeps run while the demo is in use. A checkout is released between 10 and 11 minutes after it was made. */
export const SWEEP_INTERVAL_MS = 60_000;
/** The sweeps run only if someone used the demo this recently, so an idle database can sleep. */
export const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

/** When the demo was last used, in this process. Memory only: a restart runs one sweep at start anyway. */
export class DemoActivity {
  #last: number | null = null;

  touch(now: Date): void {
    this.#last = now.getTime();
  }

  usedWithin(now: Date, windowMs: number): boolean {
    return this.#last !== null && now.getTime() - this.#last < windowMs;
  }
}

export interface SweepDeps {
  /** The rails the sweeps may ask. A record on a rail not here stays as it is. */
  readonly route: ExecutorRouter;
  readonly now: () => Date;
  readonly log: (line: string) => void;
  readonly reconcile?: (route: ExecutorRouter, now: Date) => Promise<number>;
  readonly release?: (route: ExecutorRouter, now: Date) => Promise<number>;
}

export interface SweepRun {
  /** Pending records settled, or null if that sweep failed. */
  readonly resolved: number | null;
  /** Checkout orders released, or null if that sweep failed. */
  readonly released: number | null;
}

/**
 * One pass of both sweeps, the same as `pnpm reconcile`: settle pending payment calls,
 * then release checkout orders nobody approved within 10 minutes. Each runs whatever
 * the other did, and neither throws: a failure is logged and the next pass tries again.
 */
export async function runSweeps(deps: SweepDeps): Promise<SweepRun> {
  const reconcile = deps.reconcile ?? reconcilePending;
  const release = deps.release ?? releaseStaleOrders;
  let resolved: number | null = null;
  let released: number | null = null;
  try {
    resolved = await reconcile(deps.route, deps.now());
  } catch (err) {
    deps.log(`sweep: reconcile failed, will try again: ${err instanceof Error ? err.name : "unknown error"}`);
  }
  try {
    released = await release(deps.route, deps.now());
  } catch (err) {
    deps.log(`sweep: release failed, will try again: ${err instanceof Error ? err.name : "unknown error"}`);
  }
  if ((resolved ?? 0) > 0 || (released ?? 0) > 0) {
    deps.log(`sweep: settled ${(resolved ?? 0).toString()} pending record(s), released ${(released ?? 0).toString()} checkout order(s)`);
  }
  return { resolved, released };
}

export interface SweepSchedule {
  /** One interval's work: a pass if the demo was used recently and no pass is running. True if it ran. */
  tick(): Promise<boolean>;
  /** Stops the timer. Resolves once a pass already under way has finished, so nothing runs after it. */
  stop(): Promise<void>;
}

/**
 * Runs the sweeps every `intervalMs`, but only while the demo has been used within
 * `activeWindowMs`. A pass still running when the next interval comes is not doubled up.
 * The timer doesn't keep the process alive.
 */
export function scheduleSweeps(deps: SweepDeps & { readonly activity: DemoActivity; readonly intervalMs?: number; readonly activeWindowMs?: number }): SweepSchedule {
  const windowMs = deps.activeWindowMs ?? ACTIVE_WINDOW_MS;
  let current: Promise<SweepRun> | null = null;
  const tick = async (): Promise<boolean> => {
    if (current !== null || !deps.activity.usedWithin(deps.now(), windowMs)) return false;
    current = runSweeps(deps);
    try {
      await current;
      return true;
    } finally {
      current = null;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs ?? SWEEP_INTERVAL_MS);
  timer.unref();
  return {
    tick,
    stop: async () => {
      clearInterval(timer);
      // runSweeps never throws, so this only waits.
      if (current !== null) await current;
    },
  };
}
