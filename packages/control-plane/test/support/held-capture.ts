import type { CaptureRequest, ExecOutcome, Executor, OrderLookup } from "@praman/exec-core";

/** Holds the first capture call until open(), so a test can act between T1 and T2. Reads pass straight through. */
export class HeldCapture implements Executor {
  readonly #inner: Executor;
  #open: () => void = () => {};
  readonly #gate = new Promise<void>((resolve) => {
    this.#open = resolve;
  });
  #held = false;

  constructor(inner: Executor) {
    this.#inner = inner;
  }

  get rail(): Executor["rail"] {
    return this.#inner.rail;
  }

  async untilHeld(): Promise<void> {
    while (!this.#held) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  open(): void {
    this.#open();
  }

  createOrder(req: Parameters<Executor["createOrder"]>[0]): Promise<ExecOutcome> {
    return this.#inner.createOrder(req);
  }

  findOrder(lookup: OrderLookup): Promise<ExecOutcome | null> {
    return this.#inner.findOrder(lookup);
  }

  async capture(req: CaptureRequest): Promise<ExecOutcome> {
    this.#held = true;
    await this.#gate;
    return this.#inner.capture(req);
  }
}
