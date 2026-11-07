-- A capture gets its own outbox record, next to the order it is about, so a slow
-- checkout never looks like a stuck call. Every record that exists today is an
-- order, so the default is right for them and stays right for the two writers that
-- create orders. ledger_entry and its append-only triggers are not touched.

ALTER TABLE "idempotency_record" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'order';
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_kind_check" CHECK ("kind" IN ('order', 'capture'));

-- Set on a capture record only: which order's key it belongs to, and the order id
-- a reconcile reads back. A capture record can't exist without them.
ALTER TABLE "idempotency_record" ADD COLUMN "order_key" CHAR(64);
ALTER TABLE "idempotency_record" ADD COLUMN "order_id" TEXT;
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_capture_names_order_check"
  CHECK ("kind" <> 'capture' OR ("order_key" IS NOT NULL AND "order_id" IS NOT NULL));
