/**
 * Capture responses as PayPal documents them, NOT recorded from a live capture.
 * Live captures did happen in the sandbox on 2026-11-08 and matched this reading
 * (D-49), but they are not copied here: a test built on them would depend on orders
 * only this sandbox account has, which PayPal may expire.
 * Source: the Orders v2 OpenAPI schema at developer.paypal.com/api/orders/v2/schema.json,
 * sample samples_orders_capture_00_orders_capture, on 2026-11-05, with buyer details,
 * shipping and the fee breakdown left out. The order id, capture id and capture
 * status are PayPal's sample values or its documented enum.
 */
export function documentedCapture(captureStatus: string, value = "100.00", currency = "USD", orderId = "5O190127TN364715T") {
  return {
    id: orderId,
    status: "COMPLETED",
    purchase_units: [
      {
        reference_id: "d9f80740-38f0-11e8-b467-0ed5f89f718b",
        payments: {
          captures: [
            {
              id: "3C679366HH908993F",
              status: captureStatus,
              amount: { currency_code: currency, value },
              final_capture: true,
              create_time: "2018-04-01T21:20:49Z",
              update_time: "2018-04-01T21:20:49Z",
            },
          ],
        },
      },
    ],
    links: [{ href: `https://api-m.paypal.com/v2/checkout/orders/${orderId}`, rel: "self", method: "GET" }],
  };
}
