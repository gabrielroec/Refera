import { logger, task } from "@trigger.dev/sdk";
import prisma from "../app/db.server";
import { runScanPipeline } from "../app/services/pipeline.server";
import { unauthenticated } from "../app/shopify.server";

export interface ScanPayload {
  scanId: string;
  /** myshopify domain, used to load the offline Admin API session. */
  shopDomain: string;
}

/**
 * The background scan.
 *
 * Runs on Trigger.dev because the pipeline takes minutes (30 grounded LLM
 * calls, sequentially) — far past any Vercel function timeout. The web app only
 * ever enqueues this task; all real work and all writes happen here.
 *
 * Retries are intentionally off (`maxAttempts: 1`): a scan is not idempotent
 * (snapshots and simulations are appended as it goes), and a merchant re-runs
 * it with one click anyway. Failures land in the Scan row as `failed` +
 * message, which the dashboard surfaces.
 */
export const scanTask = task({
  id: "scan",
  /**
   * Safety net for deaths that never reach runScanPipeline's own catch —
   * maxDuration kills, OOM, worker crashes. Without this the Scan row stays
   * `running` forever and the dashboard spinner never resolves.
   */
  onFailure: async ({ payload, error }: { payload: ScanPayload; error: unknown }) => {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.scan
      .updateMany({
        where: { id: payload.scanId, status: "running" },
        data: {
          status: "failed",
          error: `Scan run failed: ${message}`,
          finishedAt: new Date(),
        },
      })
      .catch(() => {});
    await prisma.$disconnect().catch(() => {});
  },
  run: async (payload: ScanPayload) => {
    logger.info("Scan starting", { ...payload });

    // Offline session -> Admin API client, no HTTP request involved.
    const { admin } = await unauthenticated.admin(payload.shopDomain);

    // On failure runScanPipeline marks the Scan row failed and rethrows, so
    // the Trigger.dev run is also marked failed and shows up red.
    try {
      await runScanPipeline(payload.scanId, admin, (message, data) =>
        logger.info(message, data),
      );
    } finally {
      // Serverless-style workers can strand pooled connections; be explicit.
      await prisma.$disconnect().catch(() => {});
    }

    return { scanId: payload.scanId };
  },
});
