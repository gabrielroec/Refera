import { SCORE_WEIGHTS } from "../lib/constants";
import { ISSUE_DEFINITIONS } from "../lib/issues";
import type {
  Issue,
  IssueCode,
  IssueSeverity,
  ScoreBreakdown,
  SimulationResult,
} from "../types";

/**
 * Penalty applied to a product's 100-point budget per issue found.
 *
 * A product missing its description AND its category lands at 50 — bad, but not
 * zero, because it still has a title an assistant can read. Nothing here should
 * be able to drive a single product below 0.
 */
const SEVERITY_PENALTY: Record<IssueSeverity, number> = {
  high: 25,
  medium: 12,
  low: 5,
};

/**
 * How much an appearance is worth, by rank.
 *
 * Being mentioned 8th in a list is real but weak — a shopper rarely reads that
 * far — so it earns half of what a top-3 mention does.
 */
function positionWeight(position: number | null): number {
  if (position === null) return 0.7; // appeared, rank unknown
  if (position <= 3) return 1;
  if (position <= 5) return 0.7;
  return 0.5;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** 0-100 completeness of one product's data. */
export function scoreProduct(issues: Issue[]): number {
  const penalty = issues.reduce(
    (sum, issue) => sum + SEVERITY_PENALTY[issue.severity],
    0,
  );
  return clamp(100 - penalty);
}

/** 0-100 average completeness across the catalogue. */
export function computeDataScore(issuesByProduct: Issue[][]): number {
  if (issuesByProduct.length === 0) return 0;
  const total = issuesByProduct.reduce(
    (sum, issues) => sum + scoreProduct(issues),
    0,
  );
  return Math.round(total / issuesByProduct.length);
}

/**
 * 0-100 share of simulated answers where the store surfaced, weighted by rank.
 *
 * Runs that errored still count in the denominator — pretending a failed run
 * never happened would quietly inflate the score.
 */
export function computeVisibilityScore(
  simulations: SimulationResult[],
): number {
  const totalRuns = simulations.reduce((sum, s) => sum + s.runCount, 0);
  if (totalRuns === 0) return 0;

  const weighted = simulations.reduce(
    (sum, sim) =>
      sum +
      sim.executions
        .filter((e) => e.appeared)
        .reduce((acc, e) => acc + positionWeight(e.position), 0),
    0,
  );

  return Math.round(clamp((weighted / totalRuns) * 100));
}

/** Combines both halves into the headline number shown on the dial. */
export function computeScore(
  issuesByProduct: Issue[][],
  simulations: SimulationResult[],
): ScoreBreakdown {
  const dataScore = computeDataScore(issuesByProduct);
  const visibilityScore = computeVisibilityScore(simulations);

  const total = Math.round(
    dataScore * SCORE_WEIGHTS.data + visibilityScore * SCORE_WEIGHTS.visibility,
  );

  const totalRuns = simulations.reduce((sum, s) => sum + s.runCount, 0);
  const appearances = simulations.reduce(
    (sum, s) => sum + s.appearanceCount,
    0,
  );
  const distinctCompetitors = new Set(
    simulations.flatMap((s) => s.competitors),
  ).size;

  return {
    dataScore,
    visibilityScore,
    total: clamp(total),
    details: {
      productsScanned: issuesByProduct.length,
      issuesFound: issuesByProduct.reduce((sum, i) => sum + i.length, 0),
      totalRuns,
      appearances,
      distinctCompetitors,
    },
  };
}

// ---------------------------------------------------------------------------
// Issue grouping
// ---------------------------------------------------------------------------

export interface IssueGroup {
  code: IssueCode;
  slug: string;
  label: string;
  why: string;
  severity: IssueSeverity;
  fixable: boolean;
  /** How many products carry this issue. */
  productCount: number;
  /** Fixes already generated and awaiting review, across those products. */
  readyFixes: number;
  /**
   * Points the headline score would gain if every instance were resolved.
   * This is what ranks the list — a merchant should spend their attention
   * where it moves the number, not where the count happens to be highest.
   */
  scoreImpact: number;
}

export interface ProductIssues {
  issues: Issue[];
  /** Fixes awaiting review on this product, keyed by the issue they resolve. */
  fixesByIssue?: Partial<Record<IssueCode, number>>;
}

/**
 * Collapses per-product issues into one row per issue type.
 *
 * The screen this feeds replaces a 39-row product table containing 158 inline
 * messages: the merchant decides once per problem, not once per product.
 */
export function computeIssueGroups(products: ProductIssues[]): IssueGroup[] {
  const dataScore = computeDataScore(products.map((p) => p.issues));

  const seen = new Map<IssueCode, { products: number; fixes: number }>();
  for (const product of products) {
    for (const issue of product.issues) {
      const entry = seen.get(issue.code) ?? { products: 0, fixes: 0 };
      entry.products += 1;
      entry.fixes += product.fixesByIssue?.[issue.code] ?? 0;
      seen.set(issue.code, entry);
    }
  }

  const groups: IssueGroup[] = [];
  for (const [code, entry] of seen) {
    const definition = ISSUE_DEFINITIONS[code];
    if (!definition) continue;

    // Recompute the catalogue score as if this issue type did not exist; the
    // difference is what resolving it is worth, after the 50/50 weighting.
    const without = computeDataScore(
      products.map((p) => p.issues.filter((i) => i.code !== code)),
    );
    const scoreImpact = Math.round((without - dataScore) * SCORE_WEIGHTS.data);

    groups.push({
      code,
      slug: definition.slug,
      label: definition.label,
      why: definition.why,
      severity: definition.severity,
      fixable: definition.fixable,
      productCount: entry.products,
      readyFixes: entry.fixes,
      scoreImpact,
    });
  }

  return groups.sort((a, b) => b.scoreImpact - a.scoreImpact);
}
