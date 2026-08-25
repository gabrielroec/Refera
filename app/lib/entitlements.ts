import { MAX_PRODUCTS_WITH_FIXES, RUNS_PER_QUESTION } from "./constants";
import { FREE_PLAN, findPaidPlan, type PlanId } from "./plans";

/**
 * What a shop is allowed to do, derived from its plan handle.
 *
 * The single place plan strings are interpreted. Everything else — the scan
 * gate, the apply-fixes gate, the pipeline's quotas — reads an `Entitlements`
 * object and never compares a handle itself. That rule is the whole point: the
 * previous shape of this logic was `shop.plan === "pro"` scattered across two
 * gates, which would have denied every paying customer the moment a third plan
 * existed, with only one line for TypeScript to complain about.
 */

export interface Entitlements {
  planHandle: PlanId;
  /** True for any tier the merchant pays for. */
  paid: boolean;

  /** Successful scans allowed, and the window they are counted over. */
  scans: {
    limit: number;
    /** `lifetime` is the free plan's single scan; paid plans reset monthly. */
    per: "month" | "lifetime";
  };

  /** Products read per scan. `null` means the whole catalogue. */
  maxProducts: number | null;
  /** Buyer-intent questions generated per scan. */
  questions: number;
  /** Executions per question. The merchant sees questions x runs as "answers". */
  runs: number;
  /** Products that get fixes written. `null` means every eligible product. */
  maxFixes: number | null;

  canApplyFixes: boolean;
  competitorTracking: boolean;
}

/**
 * Narrow a plan handle to what it grants.
 *
 * An unrecognised handle falls back to Free rather than throwing. The handle is
 * owned by the Partner Dashboard, so a value we do not know means the dashboard
 * moved ahead of this deploy — and the safe reading of "I don't recognise this"
 * is to grant the free tier, not to crash a merchant's scan.
 */
export function entitlementsFor(planHandle: string): Entitlements {
  const paid = findPaidPlan(planHandle);

  if (!paid) {
    return {
      planHandle: "free",
      paid: false,
      scans: { limit: FREE_PLAN.scans, per: "lifetime" },
      maxProducts: FREE_PLAN.maxProducts,
      questions: FREE_PLAN.questions,
      runs: RUNS_PER_QUESTION,
      maxFixes: FREE_PLAN.maxFixes,
      canApplyFixes: false,
      competitorTracking: FREE_PLAN.competitors,
    };
  }

  return {
    planHandle: paid.id,
    paid: true,
    scans: { limit: paid.scansPerMonth, per: "month" },
    maxProducts: null,
    questions: paid.questions,
    runs: RUNS_PER_QUESTION,
    maxFixes: null,
    canApplyFixes: true,
    competitorTracking: paid.competitors,
  };
}

/**
 * The subset frozen onto a Scan row when it is enqueued.
 *
 * Trigger.dev tasks cannot ask Shopify what the plan is — the unauthenticated
 * admin context they run under has no billing surface — and re-reading it
 * mid-run would be worse than useless: the catalogue is read at the start of a
 * scan and the questions are written minutes later, so a plan change in between
 * produces a scan that spent one tier's product budget and another tier's
 * questions.
 */
export interface ScanQuota {
  maxProducts: number | null;
  questions: number;
  runs: number;
  maxFixes: number | null;
}

export function scanQuotaFor(entitlements: Entitlements): ScanQuota {
  return {
    maxProducts: entitlements.maxProducts,
    questions: entitlements.questions,
    runs: entitlements.runs,
    maxFixes: entitlements.maxFixes,
  };
}

/**
 * Read a quota back off a Scan row.
 *
 * Scans created before quotas existed have `null`, and rather than guess at what
 * they were run under, they fall back to the free tier's numbers — which are the
 * global constants those scans actually used.
 */
export function scanQuotaFrom(stored: unknown): ScanQuota {
  const fallback = scanQuotaFor(entitlementsFor("free"));
  if (!stored || typeof stored !== "object") return fallback;

  const q = stored as Partial<Record<keyof ScanQuota, unknown>>;
  const int = (value: unknown, or: number | null): number | null => {
    if (value === null) return null;
    return typeof value === "number" && Number.isFinite(value) ? value : or;
  };

  return {
    maxProducts: int(q.maxProducts, fallback.maxProducts),
    questions: int(q.questions, fallback.questions) ?? fallback.questions,
    runs: int(q.runs, fallback.runs) ?? fallback.runs,
    maxFixes: int(q.maxFixes, fallback.maxFixes),
  };
}

/**
 * How many products get fixes written during the scan itself.
 *
 * A paid plan's `maxFixes` is null — every eligible product is fixable — but
 * "fixable" and "written up front" are different budgets. Fix generation runs
 * alongside the simulations, so only the worst `MAX_PRODUCTS_WITH_FIXES` cost no
 * extra wall-clock; the rest stay eligible and are generated on demand from the
 * diagnosis list. Free is capped lower because its fixes are samples.
 */
export function eagerFixBudget(quota: ScanQuota): number {
  return quota.maxFixes === null
    ? MAX_PRODUCTS_WITH_FIXES
    : Math.min(quota.maxFixes, MAX_PRODUCTS_WITH_FIXES);
}
