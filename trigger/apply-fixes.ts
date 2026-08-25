import { logger, task } from "@trigger.dev/sdk";
import prisma from "../app/db.server";
import { refreshMirroredProduct } from "../app/services/catalogue.server";
import { applyFix } from "../app/services/fixer.server";
import { unauthenticated } from "../app/shopify.server";

export interface ApplyFixesPayload {
  fixIds: string[];
  /** myshopify domain, used to load the offline Admin API session. */
  shopDomain: string;
}

/**
 * Writes approved fixes to the store, one at a time.
 *
 * Runs as a job rather than inside the request so the merchant sees real
 * progress: each fix flips to `applied` the moment Shopify accepts it, and the
 * dashboard polls those statuses. A dozen writes against a throttled Admin API
 * would otherwise be a spinner with nothing behind it.
 *
 * Sequential on purpose — these are writes to a live catalogue, and the Admin
 * API throttles. A partial run is fine: every fix records its own outcome.
 */
export const applyFixesTask = task({
  id: "apply-fixes",
  onFailure: async ({ payload }: { payload: ApplyFixesPayload }) => {
    // Release anything still marked approved so the UI stops showing it as
    // in-flight and the merchant can retry.
    await prisma.fix
      .updateMany({
        where: { id: { in: payload.fixIds }, status: "approved", appliedAt: null },
        data: { error: "The apply job stopped unexpectedly. Try again." },
      })
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  },
  run: async (payload: ApplyFixesPayload) => {
    logger.info("Applying fixes", { count: payload.fixIds.length });

    try {
      const { admin } = await unauthenticated.admin(payload.shopDomain);

      const fixes = await prisma.fix.findMany({
        where: { id: { in: payload.fixIds }, status: "approved" },
        include: { productSnapshot: { select: { productId: true } } },
        orderBy: { createdAt: "asc" },
      });

      let applied = 0;
      let failed = 0;

      for (const fix of fixes) {
        const result = await applyFix(
          admin,
          fix.productSnapshot.productId,
          fix.type,
          fix.after,
        );

        await prisma.fix.update({
          where: { id: fix.id },
          data: result.ok
            ? { status: "applied", appliedAt: new Date(), error: null }
            : { status: "approved", error: result.error },
        });

        if (result.ok) {
          applied += 1;
          // Keep the mirror honest so an immediate re-scan sees the new
          // content hash instead of carrying the product forward unchanged.
          await refreshMirroredProduct(
            payload.shopDomain,
            admin,
            fix.productSnapshot.productId,
          ).catch((error) => logger.warn("Mirror refresh failed", { error: String(error) }));
        } else {
          failed += 1;
        }
      }

      logger.info("Apply finished", { applied, failed });
      return { applied, failed };
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  },
});
