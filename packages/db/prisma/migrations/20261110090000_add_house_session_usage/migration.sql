-- A third daily counter for the hosted demo: sessions that used the demo's shared
-- sandbox buyer instead of logging in to PayPal (D-85). Same table and same rule as
-- the other two: a plain counter, separate from the ledger, which is not touched.
ALTER TABLE "demo_usage" DROP CONSTRAINT "demo_usage_kind_check";
ALTER TABLE "demo_usage" ADD CONSTRAINT "demo_usage_kind_check" CHECK ("kind" IN ('session', 'model_call', 'house_session'));
