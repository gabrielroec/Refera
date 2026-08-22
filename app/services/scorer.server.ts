import { SCORE_WEIGHTS } from "../lib/constants";
import type {
  Issue,
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
