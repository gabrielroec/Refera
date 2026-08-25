import prisma from "../db.server";
import { entitlementsFor, type Entitlements } from "../lib/entitlements";
import type { PlanId } from "../lib/plans";
import { rescueStuckScan } from "./scan-state.server";

/**
 * What a shop is allowed to do right now.
 *
 * `Shop.planHandle` is the local record of what Shopify says the merchant
 * subscribed to. Reconciling that column against Shopify is a separate concern
 * (see the plan for `subscription.server.ts`); this file only reads it and
 * answers the two questions the UI asks: can they scan, and can they apply.
 *
 * Note on staleness: once reconciliation exists, a `planVerifiedAt` older than
 * the refresh window has to mean "re-verify", never "not paying" — a transient
 * API failure must not read as a cancelled subscription. That check belongs with
 * the reconcile, not here, because there is nothing to re-verify against yet.
 */

export interface PlanState {
  planHandle: PlanId;
  entitlements: Entitlements;
  canApplyFixes: boolean;
  /** True once the shop has a *finished* scan — failed attempts do not count. */
  hasUsedFreeScan: boolean;
  /** A scan is currently queued or running (blocks concurrent scans for everyone). */
  scanInProgress: boolean;
  /** Successful scans inside the current allowance window. */
  scansUsed: number;
  canRunScan: boolean;
  /** Why not, when `canRunScan` is false — so the UI can say something true. */
  blockedReason: "in-progress" | "free-scan-used" | "monthly-limit" | null;
}

export async function getPlanState(shopId: string): Promise<PlanState> {
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: {
      planHandle: true,
      scans: {
        where: { status: { in: ["queued", "running"] } },
        select: { id: true, status: true, startedAt: true, createdAt: true },
        take: 1,
      },
    },
  });

  const entitlements = entitlementsFor(shop.planHandle);

  // A scan in flight blocks the next one, so a run that died without reporting
  // it would lock the shop out — for 65 minutes on the pages that happen to
  // rescue it, and permanently on the ones that do not. Release it here, in the
  // one place every gate goes through.
  const active = shop.scans[0] ?? null;
  const rescued = active
    ? await rescueStuckScan({
        id: active.id,
        status: active.status as "queued" | "running",
        startedAt: active.startedAt,
        createdAt: active.createdAt,
      })
    : null;
  const scanInProgress = active !== null && rescued === null;

  const scansUsed = await countScansInWindow(shopId, entitlements);
  const hasUsedFreeScan = !entitlements.paid && scansUsed > 0;

  const withinAllowance = scansUsed < entitlements.scans.limit;
  const canRunScan = !scanInProgress && withinAllowance;

  return {
    planHandle: entitlements.planHandle,
    entitlements,
    canApplyFixes: entitlements.canApplyFixes,
    hasUsedFreeScan,
    scanInProgress,
    scansUsed,
    canRunScan,
    blockedReason: canRunScan
      ? null
      : scanInProgress
        ? "in-progress"
        : entitlements.scans.per === "lifetime"
          ? "free-scan-used"
          : "monthly-limit",
  };
}

/**
 * Successful scans inside the plan's allowance window.
 *
 * Only `done` scans count. A scan that failed did not deliver anything, so
 * charging the merchant's allowance for it would mean an outage on our side
 * costs them a scan.
 */
async function countScansInWindow(
  shopId: string,
  entitlements: Entitlements,
): Promise<number> {
  if (entitlements.scans.per === "lifetime") {
    return prisma.scan.count({ where: { shopId, status: "done" } });
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return prisma.scan.count({
    where: { shopId, status: "done", createdAt: { gte: monthStart } },
  });
}

/** Finds or creates the Shop row for a myshopify domain. */
export async function ensureShop(domain: string) {
  return prisma.shop.upsert({
    where: { domain },
    update: {},
    create: { domain },
  });
}
