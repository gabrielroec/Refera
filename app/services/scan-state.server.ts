import prisma from "../db.server";

/**
 * Ceilings after which a scan in a non-terminal state is certainly dead.
 *
 * `running` is bounded by the task's own maxDuration (3600s); `queued` means
 * no worker ever picked the job up, which in practice happens within seconds
 * or never.
 */
const RUNNING_TIMEOUT_MS = 65 * 60 * 1000;
const QUEUED_TIMEOUT_MS = 10 * 60 * 1000;

export interface ScanLifecycleRow {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  startedAt: Date | null;
  createdAt: Date;
}

/**
 * Marks a scan failed when it is provably stuck, and returns what changed.
 *
 * A run killed from outside (worker crash, OOM, maxDuration) can miss every
 * failure hook and leave the row `running` forever; a job no worker ever
 * dequeued stays `queued` with no startedAt. Either way the dashboard would
 * spin and the shop could never scan again, since a scan in flight blocks the
 * next one.
 *
 * Deliberately targets one row by id rather than sweeping the table: this runs
 * on a polled request path, where a scan of every scan for the shop cost
 * seconds per request.
 */
export async function rescueStuckScan(
  scan: ScanLifecycleRow,
): Promise<{ status: "failed"; error: string } | null> {
  const now = Date.now();

  const stuck =
    (scan.status === "running" &&
      scan.startedAt !== null &&
      now - scan.startedAt.getTime() > RUNNING_TIMEOUT_MS) ||
    (scan.status === "queued" && now - scan.createdAt.getTime() > QUEUED_TIMEOUT_MS);

  if (!stuck) return null;

  const error =
    scan.status === "queued"
      ? "The scan job was never picked up by a worker. Check that the job queue is running, then try again."
      : "The scan timed out. Run it again.";

  // updateMany with the status guard: a worker finishing at the same moment
  // must win rather than be overwritten with a failure.
  const { count } = await prisma.scan.updateMany({
    where: { id: scan.id, status: scan.status },
    data: { status: "failed", phase: "finished", error, finishedAt: new Date() },
  });

  return count > 0 ? { status: "failed", error } : null;
}

/** Ceiling for a single on-demand fix generation (the task takes ~30s). */
const FIX_GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Releases fix generations whose worker died without running its failure hook,
 * so the row stops showing "Generating…" forever and can be retried.
 */
export async function rescueStuckFixGenerations(shopId: string): Promise<void> {
  await prisma.productSnapshot.updateMany({
    where: {
      scan: { shopId },
      fixStatus: "queued",
      updatedAt: { lt: new Date(Date.now() - FIX_GENERATION_TIMEOUT_MS) },
    },
    data: { fixStatus: "failed" },
  });
}
