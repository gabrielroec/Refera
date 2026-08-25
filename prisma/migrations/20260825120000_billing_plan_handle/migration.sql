-- Billing: the plan handle entitlement is keyed on, the subscription state we
-- persist, and the quota snapshot a background scan runs under.

ALTER TABLE "Shop" ADD COLUMN "planHandle" TEXT NOT NULL DEFAULT 'free';
ALTER TABLE "Shop" ADD COLUMN "planStatus" TEXT;
ALTER TABLE "Shop" ADD COLUMN "planCycleEnd" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "planVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Shop" ADD COLUMN "subscriptionGid" TEXT;

-- Carry the old two-value enum across before dropping it. `pro` was a manual
-- flag on the development store, set to exercise the apply-fixes gate, so it
-- maps to a tier that keeps that access rather than silently demoting the store.
-- Every value here is replaced by the first reconcile against Shopify.
UPDATE "Shop" SET "planHandle" = CASE WHEN "plan" = 'pro' THEN 'growth' ELSE 'free' END;

ALTER TABLE "Shop" DROP COLUMN "plan";
DROP TYPE "Plan";

ALTER TABLE "Scan" ADD COLUMN "planHandle" TEXT;
ALTER TABLE "Scan" ADD COLUMN "quota" JSONB;

-- One scan in flight per shop, enforced by the database rather than by hope.
--
-- Reading the plan, checking the gate and inserting the row are three
-- unsynchronised statements, so a double-clicked button starts two scans — and a
-- scan is 30 to 225 grounded LLM calls. A partial unique index is the only place
-- this can be made atomic, and Prisma's DSL cannot express one, so it lives here
-- and is invisible to `schema.prisma` by necessity.
CREATE UNIQUE INDEX "Scan_one_active_per_shop"
  ON "Scan"("shopId")
  WHERE "status" IN ('queued', 'running');
