# Synthetic PayPal webhook fixtures

**None of these files is a real PayPal delivery.** They were written by hand on
2026-11-08 from PayPal's published shapes, because at the time no real sandbox webhook
had been delivered to this project: there was no public URL for PayPal to send to, and
the spike in plan Task 0 never received one. Later the same day the app was hosted, and
a real `PAYMENT.CAPTURE.COMPLETED` delivery reached it and verified (`docs/BUILD_LOG.md`,
P21). That delivery was not saved here, so these files are still synthetic.

Sources, both fetched on 2026-11-08:

- The event envelope (`id`, `create_time`, `resource_type`, `event_type`, `summary`,
  `resource`, `resource_version`, `event_version`, `links`) is the `event` schema in
  PayPal's Webhooks v1 OpenAPI file, `developer.paypal.com/api/webhooks/v1/schema.json`.
- The `resource` of a `PAYMENT.CAPTURE.*` event is a capture as described by the
  `capture` schema in the Payments v2 OpenAPI file,
  `developer.paypal.com/api/payments/v2/schema.json`, including
  `supplementary_data.related_ids.order_id`. Its status enum is `COMPLETED`,
  `DECLINED`, `PARTIALLY_REFUNDED`, `PENDING`, `REFUNDED`, `FAILED`.

Every id says `SYNTHETIC` or `SYNTH` so it can't be mistaken for one PayPal issued.
Tests replace the order id and invoice id with the ones their own order got.

They carry no signature. PayPal documents that mock events can't be checked with the
verify-webhook-signature postback, and these aren't even mock events, so tests stand in
for PayPal's verification answer. A test against a recorded real delivery is still
owed. When one is recorded, add it beside these and say in the file name which ones are
real.
