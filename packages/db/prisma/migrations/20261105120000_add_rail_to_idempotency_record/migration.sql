-- Every record that exists today went to Razorpay in INR, or to the simulator
-- pretending to be it. As in the currency migration, the defaults only backfill
-- those rows and are dropped straight after, so a new record that forgets its
-- rail fails instead of quietly becoming Razorpay.
-- ledger_entry and its append-only triggers are not touched.

ALTER TABLE "idempotency_record" ADD COLUMN "rail" TEXT NOT NULL DEFAULT 'razorpay';
ALTER TABLE "idempotency_record" ALTER COLUMN "rail" DROP DEFAULT;
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_rail_check" CHECK ("rail" IN ('razorpay', 'paypal', 'simulated'));

ALTER TABLE "idempotency_record" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE "idempotency_record" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_currency_check" CHECK ("currency" IN ('INR', 'USD'));

-- A merchant with no row is now refused, and until today a catalog alone was
-- enough. Anything already selling in INR keeps working on Razorpay. A merchant
-- seeded since the merchant table arrived already has its row and is left alone.
INSERT INTO "merchant" ("merchant_id", "rail", "currency")
SELECT DISTINCT "merchant_id", 'razorpay', 'INR' FROM "catalog_item" WHERE "currency" = 'INR'
ON CONFLICT ("merchant_id") DO NOTHING;
