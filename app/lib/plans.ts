import {
  MAX_PRODUCTS_PER_SCAN,
  QUESTIONS_PER_SCAN,
  RUNS_PER_QUESTION,
} from "./constants";

/**
 * The plans, as one source of truth for the pricing page and for enforcement.
 *
 * Every quota here is a number, not a sentence. The display strings on the cards
 * are derived from those numbers, so the page cannot advertise a limit the
 * scanner does not apply — which is the failure this file exists to prevent.
 * `app/lib/entitlements.ts` turns a plan handle into the quota the pipeline
 * reads.
 *
 * Handles are the wire identity: they must match the plan handles configured in
 * the Shopify Partner Dashboard exactly, and renaming one orphans every merchant
 * already subscribed to it.
 *
 * Nothing is invented — same rule as `ai-adoption.ts`, and for the same reason:
 * a merchant who catches one fabricated number on this screen has no reason to
 * believe the score that brought them here.
 */

export type PlanId = "free" | "starter" | "growth" | "scale";
export type PaidPlanId = Exclude<PlanId, "free">;

/**
 * What the merchant counts is answers; what a scan counts is questions. Every
 * question is asked `RUNS_PER_QUESTION` times, so the two must be shown
 * together or the "0 of 30" on the overview has nothing to attach to.
 */
export function answersFor(questions: number): number {
  return questions * RUNS_PER_QUESTION;
}

/** Fixes read the same on every paid tier; the contrast is with Free. */
export const PAID_FIXES = "Unlimited, one-click apply";

/** How the Free plan reads, in the same units the paid cards use. */
export const FREE_PLAN = {
  /** One successful scan, ever — not one per month. */
  scans: 1,
  scansLabel: "1 scan, one time",
  maxProducts: MAX_PRODUCTS_PER_SCAN,
  productsLabel: `${MAX_PRODUCTS_PER_SCAN} per scan`,
  questions: QUESTIONS_PER_SCAN,
  /** Fixes the merchant may look at. Applying any of them is a paid feature. */
  maxFixes: 5,
  fixesLabel: "5 samples, preview only",
  competitors: false,
  history: "Current scan only",
  support: "Documentation",
} as const;

export interface PaidPlan {
  id: PaidPlanId;
  name: string;
  /** One line on who this is for. Sits above the price on the card. */
  positioning: string;
  priceUsd: number;
  /** Header above the four value rows, so each card carries the one before it. */
  carryForward: string;

  /** Successful scans allowed per calendar month. */
  scansPerMonth: number;
  /** How those scans are spaced, when that reads more naturally than the count. */
  cadence: string | null;
  questions: number;
  competitors: boolean;

  // Table-only rows.
  history: string;
  /**
   * Held at "Not available" on every tier for now.
   *
   * A per-extra-store add-on cannot be expressed under Shopify App Pricing:
   * there is no quantity on any billing input type, a subscription carries at
   * most one recurring line item, and there is no add-on primitive. Selling
   * "$79 per extra store" here would be a price with nothing behind it. When a
   * real multi-store customer turns up, the shape that works is a discounted
   * per-store plan each additional shop subscribes to on its own install.
   */
  additionalStores: string;
  support: string;
}

/**
 * Starter, Growth, Scale — left to right, which puts Growth in the literal
 * centre of a three-column row. Free is deliberately not in this list: the
 * merchant reading the pricing page is already on it, so it is their state, not
 * one of the options.
 */
export const PAID_PLANS: PaidPlan[] = [
  {
    id: "starter",
    name: "Starter",
    positioning: "For a single store that wants to keep checking.",
    priceUsd: 39,
    carryForward: "Includes:",
    scansPerMonth: 2,
    cadence: null,
    questions: 25,
    competitors: false,
    history: "3 months",
    additionalStores: "Not available",
    support: "Email",
  },
  {
    id: "growth",
    name: "Growth",
    positioning: "For stores that need to move, and to see who AI recommends instead.",
    priceUsd: 99,
    carryForward: "Everything in Starter, plus:",
    scansPerMonth: 4,
    cadence: "weekly",
    questions: 50,
    competitors: true,
    history: "12 months",
    additionalStores: "Not available",
    support: "Priority email",
  },
  {
    id: "scale",
    name: "Scale",
    positioning: "For agencies and multi-store merchants.",
    priceUsd: 299,
    carryForward: "Everything in Growth, plus:",
    scansPerMonth: 8,
    cadence: "twice weekly",
    questions: 75,
    competitors: true,
    history: "Unlimited",
    additionalStores: "Not available",
    support: "Priority email and an onboarding call",
  },
];

/** "4 per month (weekly)" — one unit on every card, cadence only where it helps. */
export function scansLabel(plan: PaidPlan): string {
  const base = `${plan.scansPerMonth} per month`;
  return plan.cadence ? `${base} (${plan.cadence})` : base;
}

export function findPaidPlan(id: string): PaidPlan | undefined {
  return PAID_PLANS.find((p) => p.id === id);
}

/**
 * Which plan to badge as recommended.
 *
 * A real claim, not decoration: it reads the shop's own scan, and it can
 * genuinely return Starter. A badge hardcoded to the middle tier is "Most
 * popular" wearing a different hat — and Refera has no popularity data,
 * because it has not launched.
 *
 * Returns null when there is nothing measured to base a recommendation on.
 */
export function recommendedPlan(
  appearances: number,
  totalRuns: number,
  highSeverityIssueTypes: number,
): PaidPlanId | null {
  if (totalRuns === 0) return null;
  if (appearances === 0) return "growth";
  if (highSeverityIssueTypes >= 2) return "growth";
  return "starter";
}

// ---------------------------------------------------------------------------
// Comparison table
// ---------------------------------------------------------------------------

/**
 * A boolean row prints an icon in *every* cell, included or not — a table where
 * some cells have icons and others are blank is a documented Built for Shopify
 * rejection reason. A value row prints text in every cell and no icons at all.
 */
export interface ComparisonRow {
  label: string;
  values: [free: string, starter: string, growth: string, scale: string];
}

export interface BooleanRow {
  label: string;
  values: [free: boolean, starter: boolean, growth: boolean, scale: boolean];
}

export interface ComparisonGroup {
  heading: string;
  rows: (ComparisonRow | BooleanRow)[];
}

export function isBooleanRow(row: ComparisonRow | BooleanRow): row is BooleanRow {
  return typeof row.values[0] === "boolean";
}

const [starter, growth, scale] = PAID_PLANS;

function questionRow(label: string, render: (q: number) => string): ComparisonRow {
  return {
    label,
    values: [
      render(FREE_PLAN.questions),
      render(starter.questions),
      render(growth.questions),
      render(scale.questions),
    ],
  };
}

export const COMPARISON: ComparisonGroup[] = [
  {
    heading: "Scanning",
    rows: [
      {
        label: "Scans",
        values: [
          FREE_PLAN.scansLabel,
          scansLabel(starter),
          scansLabel(growth),
          scansLabel(scale),
        ],
      },
      {
        label: "Products per scan",
        values: [
          FREE_PLAN.productsLabel,
          "All products",
          "All products",
          "All products",
        ],
      },
      {
        label: "History kept",
        values: [FREE_PLAN.history, starter.history, growth.history, scale.history],
      },
    ],
  },
  {
    heading: "AI answers",
    rows: [
      questionRow("Questions per scan", (q) => String(q)),
      questionRow("Answers per scan", (q) => String(answersFor(q))),
      {
        label: "Competitor tracking",
        values: [
          FREE_PLAN.competitors,
          starter.competitors,
          growth.competitors,
          scale.competitors,
        ],
      },
    ],
  },
  {
    heading: "Fixes",
    rows: [
      {
        label: "Fixes generated",
        values: [FREE_PLAN.fixesLabel, PAID_FIXES, PAID_FIXES, PAID_FIXES],
      },
      { label: "Apply to your store", values: [false, true, true, true] },
      { label: "Apply in bulk", values: [false, true, true, true] },
    ],
  },
  {
    heading: "Account",
    rows: [
      {
        label: "Additional stores",
        values: [
          "Not available",
          starter.additionalStores,
          growth.additionalStores,
          scale.additionalStores,
        ],
      },
      {
        label: "Support",
        values: [FREE_PLAN.support, starter.support, growth.support, scale.support],
      },
    ],
  },
];
