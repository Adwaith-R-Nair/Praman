-- A refund gets its own outbox record, the same two phases as an order or a capture
-- (D-22, D-40). Like a capture record, it names the order it belongs to: the order's
-- key and the order id. The ledger's own rows name the capture being refunded.
-- ledger_entry and its append-only triggers are not touched.

ALTER TABLE "idempotency_record" DROP CONSTRAINT "idempotency_record_kind_check";
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_kind_check" CHECK ("kind" IN ('order', 'capture', 'refund'));

ALTER TABLE "idempotency_record" DROP CONSTRAINT "idempotency_record_capture_names_order_check";
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_capture_names_order_check"
  CHECK ("kind" NOT IN ('capture', 'refund') OR ("order_key" IS NOT NULL AND "order_id" IS NOT NULL));
