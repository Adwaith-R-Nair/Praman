-- Amounts are minor units now, not paise. RENAME keeps every value and every
-- constraint, including catalog_price_positive, whose check follows the column.
--
-- ledger_entry is not touched, and neither are its append-only triggers. Its
-- rows keep amount_paise inside their payloads forever, because the hash chain
-- covers those bytes. Readers accept both names (D-28).
ALTER TABLE "catalog_item" RENAME COLUMN "price_paise" TO "price_minor";
ALTER TABLE "idempotency_record" RENAME COLUMN "amount_paise" TO "amount_minor";
ALTER TABLE "approval" RENAME COLUMN "amount_paise" TO "amount_minor";
