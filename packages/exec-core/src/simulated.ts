import type { CaptureRequest, CreateOrderRequest, ExecOutcome, Executor, OrderLookup } from "./executor.js";

/**
 * Deterministic stand-in for the eval harness. Evals must be reproducible
 * (D-02); a live gateway is not. Also the only way to exercise decline,
 * timeout and partial-capture paths on demand.
 */
export class SimulatedExecutor implements Executor {
  readonly rail = "simulated";
  #n = 0;
  readonly #orders = new Map<string, ExecOutcome>();
  constructor(private readonly failWith?: "declined" | "timeout") {}

  async createOrder(req: CreateOrderRequest): Promise<ExecOutcome> {
    if (this.failWith === "timeout") throw new Error("ETIMEDOUT");
    const existing = this.#orders.get(req.receipt);
    if (existing) return existing;
    const outcome: ExecOutcome = {
      rail: this.rail,
      order_id: `order_SIM${String(++this.#n).padStart(8, "0")}`,
      status: this.failWith === "declined" ? "failed" : "captured",
      amount_minor: req.amount_minor,
      currency: req.currency,
      payment_id: this.failWith === "declined" ? null : `pay_SIM${this.#n}`,
      approve_url: null,
      failure_code: this.failWith === "declined" ? "BAD_REQUEST_ERROR" : null,
    };
    this.#orders.set(req.receipt, outcome);
    return outcome;
  }

  async findOrder(lookup: OrderLookup): Promise<ExecOutcome | null> {
    return this.#orders.get(lookup.receipt) ?? null;
  }

  async capture(req: CaptureRequest): Promise<ExecOutcome> {
    return {
      rail: this.rail,
      order_id: req.order_id,
      status: "captured",
      amount_minor: req.amount_minor,
      currency: req.currency,
      payment_id: `pay_SIM_${req.order_id}`,
      approve_url: null,
      failure_code: null,
    };
  }
}
