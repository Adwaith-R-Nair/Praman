import type { CaptureRequest, CreateOrderRequest, ExecOutcome, Executor, OrderLookup, Rail, RefundOutcome, RefundRequest } from "@praman/exec-core";
import type { SavedMethodCharger } from "./executor.js";

/**
 * Which saved payment method pays for this order, or null for a checkout the buyer
 * approves at PayPal. The server decides, from its own records: never the intent, the
 * model or a request. The answer is a secret, read from a server-side store.
 */
export type SavedMethodChoice = (req: CreateOrderRequest) => string | null;

/**
 * The PayPal rail, for a caller that holds a saved payment method. An order either
 * charges that method with no buyer present, captured as it is created, or becomes a
 * checkout order as usual. Either way it is one createOrder call from runIntent or
 * resolveApproval, under the outbox record and the derived key, and its answer goes
 * through acceptOutcome like any other (D-33, D-49).
 *
 * findOrder and capture are the plain rail's. A lookup with no order id repeats the
 * create as a checkout order, never as a charge: if PayPal no longer holds the key,
 * repeating a charge could take the money twice, and a new checkout order moves
 * nothing until a buyer approves it (D-26).
 */
export class SavedMethodExecutor implements Executor {
  readonly #inner: SavedMethodCharger;
  readonly #choose: SavedMethodChoice;

  /** The plain rail's refund, when it has one. A refund never goes near the saved method. */
  readonly refund?: (req: RefundRequest) => Promise<RefundOutcome>;

  constructor(inner: SavedMethodCharger, choose: SavedMethodChoice) {
    this.#inner = inner;
    this.#choose = choose;
    const refund = inner.refund;
    if (refund !== undefined) this.refund = (req) => refund.call(inner, req);
  }

  get rail(): Rail {
    return this.#inner.rail;
  }

  createOrder(req: CreateOrderRequest): Promise<ExecOutcome> {
    const vaultId = this.#choose(req);
    return vaultId === null ? this.#inner.createOrder(req) : this.#inner.chargeSavedMethod(req, vaultId);
  }

  findOrder(lookup: OrderLookup): Promise<ExecOutcome | null> {
    return this.#inner.findOrder(lookup);
  }

  capture(req: CaptureRequest): Promise<ExecOutcome> {
    return this.#inner.capture(req);
  }
}
