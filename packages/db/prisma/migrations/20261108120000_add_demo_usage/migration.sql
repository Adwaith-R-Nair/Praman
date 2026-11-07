-- The hosted demo's daily allowance: how many new sessions and model calls each UTC
-- day has used. A plain counter the demo increments, separate from the ledger, which
-- is not touched.
CREATE TABLE "demo_usage" (
    "day" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "used" INTEGER NOT NULL,

    CONSTRAINT "demo_usage_pkey" PRIMARY KEY ("day", "kind"),
    CONSTRAINT "demo_usage_kind_check" CHECK ("kind" IN ('session', 'model_call')),
    CONSTRAINT "demo_usage_used_check" CHECK ("used" >= 0)
);
