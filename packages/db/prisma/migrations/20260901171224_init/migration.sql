-- CreateTable
CREATE TABLE "ledger_entry" (
    "seq" BIGSERIAL NOT NULL,
    "trace_id" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "actor" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "prev_hash" CHAR(64) NOT NULL,
    "entry_hash" CHAR(64) NOT NULL,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "mandate" (
    "mandate_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "issuer_id" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mandate_pkey" PRIMARY KEY ("mandate_id")
);

-- CreateTable
CREATE TABLE "catalog_item" (
    "merchant_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "price_paise" BIGINT NOT NULL,
    "stock_qty" INTEGER NOT NULL,

    CONSTRAINT "catalog_item_pkey" PRIMARY KEY ("merchant_id","sku")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "key" CHAR(64) NOT NULL,
    "trace_id" TEXT NOT NULL,
    "outcome" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "approval" (
    "approval_id" TEXT NOT NULL,
    "trace_id" TEXT NOT NULL,
    "mandate_id" TEXT NOT NULL,
    "intent" JSONB NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "approval_pkey" PRIMARY KEY ("approval_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entry_entry_hash_key" ON "ledger_entry"("entry_hash");

-- CreateIndex
CREATE INDEX "ledger_entry_trace_id_seq_idx" ON "ledger_entry"("trace_id", "seq");
