/**
 * MVP limits and scoring weights.
 *
 * These are deliberately centralised: the free/pro gate, the Gemini free-tier
 * quota and the scan wall-clock time all hang off these numbers, so tuning the
 * product means editing this file and nothing else.
 */

/** Hard cap on products pulled per scan (MVP rule). */
export const MAX_PRODUCTS_PER_SCAN = 50;

/** How many buyer-intent questions we generate per scan. */
export const QUESTIONS_PER_SCAN = 10;

/** How many times each question is executed, to measure frequency. */
export const RUNS_PER_QUESTION = 3;

/** Products fetched per Admin API page. */
export const PRODUCTS_PAGE_SIZE = 25;

/**
 * Score weighting. `dataScore` is what the merchant can fix today;
 * `visibilityScore` is the outcome we are actually selling. Kept at 50/50 so a
 * store with a clean catalogue but zero AI presence still reads as "work to do"
 * rather than "perfect".
 */
export const SCORE_WEIGHTS = {
  data: 0.5,
  visibility: 0.5,
} as const;

/** A description shorter than this is treated as too thin for an LLM to use. */
export const MIN_DESCRIPTION_LENGTH = 200;

/** Below this many metafields a product is considered under-annotated. */
export const MIN_METAFIELD_COUNT = 3;

/** Namespace Refera writes its own generated metafields under. */
export const REFERA_METAFIELD_NAMESPACE = "refera";

/** Applying fixes is a Pro feature. Billing itself is stubbed for the MVP. */
export const FEATURE_APPLY_FIXES_REQUIRES_PRO = true;

/**
 * Cap on how many products get LLM-generated fixes per scan.
 *
 * Fix generation is the most expensive phase (one or more calls per issue).
 * Scanning 50 products but only writing fixes for the 20 worst keeps a scan
 * inside a few minutes and inside the Gemini free tier. The remaining products
 * still appear in the diagnosis — they just have no fix attached yet.
 */
export const MAX_PRODUCTS_WITH_FIXES = 20;
