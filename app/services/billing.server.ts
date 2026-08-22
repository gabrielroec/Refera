import prisma from "../db.server";
import { FEATURE_APPLY_FIXES_REQUIRES_PRO } from "../lib/constants";

/**
 * Billing stub.
 *
 * The MVP ships the *gate*, not the payment: `Shop.plan` is the single source
 * of truth, defaulting to `free`. When real Shopify Billing lands, the purchase
 * flow's only job is to flip that column — nothing else in the app changes.
 */

export interface PlanState {
  plan: "free" | "pro";
  canApplyFixes: boolean;
  /** True once the shop has a *finished* scan — failed attempts do not count. */
  hasUsedFreeScan: boolean;
  /** A scan is currently queued or running (blocks concurrent scans for everyone). */
  scanInProgress: boolean;
  canRunScan: boolean;
}

export async function getPlanState(shopId: string): Promise<PlanState> {
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: {
      plan: true,
      _count: {
        select: {
          scans: { where: { status: "done" } },
        },
      },
      scans: {
        where: { status: { in: ["queued", "running"] } },
        select: { id: true },
        take: 1,
      },
    },
  });

  const isPro = shop.plan === "pro";
  const hasUsedFreeScan = shop._count.scans > 0;
  const scanInProgress = shop.scans.length > 0;

  return {
    plan: shop.plan,
    canApplyFixes: isPro || !FEATURE_APPLY_FIXES_REQUIRES_PRO,
    hasUsedFreeScan,
    scanInProgress,
    // Free plan: exactly one successful scan; re-scans are Pro. A failed scan
    // does not consume the free one. Nobody runs two scans at once.
    canRunScan: !scanInProgress && (isPro || !hasUsedFreeScan),
  };
}

/** Finds or creates the Shop row for a myshopify domain. */
export async function ensureShop(domain: string) {
  return prisma.shop.upsert({
    where: { domain },
    update: {},
    create: { domain },
  });
}
