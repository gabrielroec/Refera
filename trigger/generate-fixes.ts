import { logger, task } from "@trigger.dev/sdk";
import prisma from "../app/db.server";
import { generateAndStoreFixes } from "../app/services/fixer.server";
import { detectIssues, fetchProductById } from "../app/services/scanner.server";
import { buildStoreContext } from "../app/services/simulator.server";
import { unauthenticated } from "../app/shopify.server";
import type { ScannedProduct } from "../app/types";

export interface GenerateFixesPayload {
  snapshotId: string;
  /** myshopify domain, used to load the offline Admin API session. */
  shopDomain: string;
}

/**
 * On-demand fix generation for one product.
 *
 * Scans generate fixes eagerly only for the worst MAX_PRODUCTS_WITH_FIXES
 * products; the merchant can ask for any other product from the diagnosis
 * list, which enqueues this task. Same generator, same persistence as the
 * scan path — just one product, a few seconds.
 */
export const generateFixesTask = task({
  id: "generate-fixes",
  onFailure: async ({ payload }: { payload: GenerateFixesPayload }) => {
    await prisma.productSnapshot
      .updateMany({
        where: { id: payload.snapshotId, fixStatus: "queued" },
        data: { fixStatus: "failed" },
      })
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  },
  run: async (payload: GenerateFixesPayload) => {
    logger.info("Generating fixes on demand", { ...payload });

    try {
      const snapshot = await prisma.productSnapshot.findUniqueOrThrow({
        where: { id: payload.snapshotId },
        include: { scan: { include: { shop: true } } },
      });
      const shop = snapshot.scan.shop;

      const { admin } = await unauthenticated.admin(payload.shopDomain);

      // Prefer the live product over the snapshot: if it changed since the
      // scan, the fixes should target what the merchant will actually edit.
      const mirrored = await prisma.productMirror.findUnique({
        where: { shopId_productId: { shopId: shop.id, productId: snapshot.productId } },
        select: { data: true },
      });
      const product =
        (mirrored?.data as unknown as ScannedProduct | undefined) ??
        (await fetchProductById(admin, snapshot.productId));
      if (!product) {
        throw new Error("Product no longer exists in the store");
      }

      const store = buildStoreContext(
        shop.domain,
        null,
        shop.name,
        shop.niche,
        shop.currencyCode,
        shop.primaryLocale,
        [product],
      );

      const count = await generateAndStoreFixes(
        admin,
        { id: snapshot.id, product, issues: detectIssues(product) },
        store,
      );
      logger.info("Fixes generated", { product: product.title, count });
      return { snapshotId: snapshot.id, count };
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  },
});
