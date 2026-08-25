import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { rescueStuckScan } from "../services/scan-state.server";
import type { Issue } from "../types";

/**
 * Lightweight progress feed for the dashboard.
 *
 * The full dashboard loader carries every product, fix and simulation — half a
 * megabyte and several seconds once a store has a real catalogue. Polling that
 * every two seconds made requests pile up, froze the progress bar and tripped
 * the "connection lost" banner. This route answers the only question a
 * progress view actually asks — how far along is the scan — with counters and
 * a short tail of recent work, so it stays small and fast.
 *
 * The dashboard reloads its heavy data once, when this feed reports the scan
 * has finished.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
    select: { id: true },
  });
  if (!shop) return { scan: null, serverTime: Date.now() };

  const scan = await prisma.scan.findFirst({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      phase: true,
      score: true,
      productsScanned: true,
      issuesFound: true,
      startedAt: true,
      createdAt: true,
    },
  });
  if (!scan) return { scan: null, serverTime: Date.now() };

  const rescued = await rescueStuckScan(scan);

  const [simulationCount, fixCount, generatingCount, recentProducts, recentSimulations] =
    await Promise.all([
      prisma.simulation.count({ where: { scanId: scan.id } }),
      prisma.fix.count({ where: { productSnapshot: { scanId: scan.id } } }),
      prisma.productSnapshot.count({
        where: { scanId: scan.id, fixStatus: "queued" },
      }),
      // Newest first, capped: the strip shows a handful of cards, not the
      // whole catalogue.
      prisma.productSnapshot.findMany({
        where: { scanId: scan.id },
        orderBy: { createdAt: "desc" },
        take: 12,
        select: { id: true, title: true, issues: true },
      }),
      prisma.simulation.findMany({
        where: { scanId: scan.id },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: {
          id: true,
          question: true,
          appearanceCount: true,
          runCount: true,
        },
      }),
    ]);

  return {
    scan: {
      id: scan.id,
      status: rescued?.status ?? scan.status,
      phase: rescued ? ("finished" as const) : scan.phase,
      score: scan.score,
      productsScanned: scan.productsScanned,
      issuesFound: scan.issuesFound,
      simulationCount,
      fixCount,
      generatingCount,
      recentProducts: recentProducts.map((p) => ({
        id: p.id,
        title: p.title,
        issueCount: (p.issues as unknown as Issue[]).length,
      })),
      recentSimulations,
    },
    serverTime: Date.now(),
  };
};
