-- AlterTable
ALTER TABLE "idempotency_record" ADD COLUMN     "amount_paise" BIGINT,
ADD COLUMN     "receipt" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "outcome" DROP NOT NULL;

-- Prisma cannot express a CHECK constraint natively.
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_status_valid"
  CHECK (status IN ('pending', 'succeeded', 'failed'));
