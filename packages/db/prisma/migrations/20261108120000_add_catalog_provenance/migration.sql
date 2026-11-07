-- An imported catalog item keeps where its price came from and when it was pinned.
-- Existing rows were seeded by hand and get NULLs. A source and a fetch time come
-- together or not at all, so an imported price can't lose the time it was true.
-- ledger_entry and its append-only triggers are not touched.

ALTER TABLE "catalog_item" ADD COLUMN "source" TEXT;
ALTER TABLE "catalog_item" ADD COLUMN "source_ref" TEXT;
ALTER TABLE "catalog_item" ADD COLUMN "source_url" TEXT;
ALTER TABLE "catalog_item" ADD COLUMN "price_fetched_at" TIMESTAMPTZ(3);
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_provenance_check"
  CHECK (("source" IS NULL) = ("price_fetched_at" IS NULL));
