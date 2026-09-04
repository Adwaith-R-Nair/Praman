import type { Paise } from "@praman/shared";
import type { ExecOutcome, Executor } from "./executor.js";

/**
 * Deterministic stand-in for the eval harness. Evals must be reproducible
 * (D-02); a live gateway is not. Also the only way to exercise decline,
 * timeout and partial-capture paths on demand.
 */
export class SimulatedExecutor implements Executor {
  #n = 0;
  readonly #orders = new Map<string, ExecOutcome>();
  constructor(private readonly failWith?: "declined" | "timeout") {}

  async createOrder(amountPaise: Paise, receipt: string): Promise<ExecOutcome> {
    if (this.failWith === "timeout") throw new Error("ETIMEDOUT");
    const existing = this.#orders.get(receipt);
    if (existing) return existing;
    const outcome: ExecOutcome = {
      order_id: `order_SIM${String(++this.#n).padStart(8, "0")}`,
      status: this.failWith === "declined" ? "failed" : "captured",
      amount_paise: amountPaise,
      payment_id: this.failWith === "declined" ? null : `pay_SIM${this.#n}`,
      failure_code: this.failWith === "declined" ? "BAD_REQUEST_ERROR" : null,
    };
    this.#orders.set(receipt, outcome);
    return outcome;
  }

  async findByReceipt(r: string): Promise<ExecOutcome | null> {
    return this.#orders.get(r) ?? null;
  }

  async capture(p: string, a: Paise): Promise<ExecOutcome> {
    return { order_id: "order_SIM", status: "captured", amount_paise: a, payment_id: p, failure_code: null };
  }
}
