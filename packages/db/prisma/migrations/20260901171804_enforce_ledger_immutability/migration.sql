-- Ledger immutability. Enforced by the database, not by application discipline.
--
-- A RULE with DO INSTEAD NOTHING would silently discard the write: the UPDATE
-- "succeeds" affecting zero rows and nobody notices. A trigger that raises makes
-- the attempt loud. In a system whose output is evidence, silent failure is the
-- wrong default.
CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entry is append-only: % rejected on seq %',
    TG_OP, COALESCE(OLD.seq, NEW.seq);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();

CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();

-- Prisma cannot express an index on a JSONB expression.
CREATE INDEX ledger_mandate_idx ON ledger_entry ((payload->>'mandate_id'), seq);

-- Catalog prices are money: reject non-positive at the boundary.
ALTER TABLE catalog_item ADD CONSTRAINT catalog_price_positive CHECK (price_paise > 0);
ALTER TABLE catalog_item ADD CONSTRAINT catalog_stock_non_negative CHECK (stock_qty >= 0);
