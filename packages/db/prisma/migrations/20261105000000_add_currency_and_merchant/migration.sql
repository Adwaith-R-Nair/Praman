-- Every row that exists today is in INR, because nothing else was accepted.
-- The default exists only to backfill those rows and is dropped straight after,
-- so a new row that forgets its currency fails instead of quietly becoming INR.
-- ledger_entry and its append-only triggers are not touched.

ALTER TABLE "catalog_item" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE "catalog_item" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_currency_check" CHECK ("currency" IN ('INR', 'USD'));

ALTER TABLE "approval" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE "approval" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "approval" ADD CONSTRAINT "approval_currency_check" CHECK ("currency" IN ('INR', 'USD'));

CREATE TABLE "merchant" (
    "merchant_id" TEXT NOT NULL,
    "rail" TEXT NOT NULL,
    "currency" TEXT NOT NULL,

    CONSTRAINT "merchant_pkey" PRIMARY KEY ("merchant_id"),
    CONSTRAINT "merchant_rail_check" CHECK ("rail" IN ('razorpay', 'paypal', 'simulated')),
    CONSTRAINT "merchant_currency_check" CHECK ("currency" IN ('INR', 'USD'))
);
