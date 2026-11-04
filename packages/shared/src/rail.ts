/** Where a merchant's payments go. Merchant configuration on the server decides this, never an intent or a model. */
export const RAILS = ["razorpay", "paypal", "simulated"] as const;

export type Rail = (typeof RAILS)[number];

export function isRail(value: unknown): value is Rail {
  return RAILS.some((r) => r === value);
}
