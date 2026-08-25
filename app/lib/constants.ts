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

/**
 * How many of the worst products get fixes generated eagerly during a scan.
 *
 * Fix generation runs in parallel with the simulations, so up to this many
 * products cost no extra wall-clock. Products beyond the cap stay eligible and
 * the merchant can request their fixes on demand from the diagnosis list.
 */
export const MAX_PRODUCTS_WITH_FIXES = 20;

/**
 * Bump whenever a fix prompt changes meaningfully. Fixes carried forward from
 * an earlier scan must have been generated with the current version, or the
 * merchant keeps seeing stale suggestions after a prompt improvement.
 */
export const FIX_PROMPT_VERSION = 1;

/**
 * Concurrency for the LLM phases.
 *
 * Sized against the OpenAI rate limit, deliberately *not* against the question
 * quota. Questions run in parallel and each runs its executions in parallel, so
 * in-flight grounded calls peak at SIMULATION_CONCURRENCY * RUNS_PER_QUESTION
 * (30) plus FIX_CONCURRENCY — one wave, well inside a paid tier's 500 RPM.
 *
 * This used to be `= QUESTIONS_PER_SCAN`, which was harmless only while every
 * shop asked the same ten questions. Per-plan quotas break that: the top tier
 * asks 75, and the same expression would open 225 concurrent grounded calls
 * against that same 500 RPM, with retries switched off in trigger.config.ts.
 * The highest-paying customer would have been the one whose scans time out.
 */
export const SIMULATION_CONCURRENCY = 10;
export const FIX_CONCURRENCY = 10;

/**
 * Ceiling for one grounded simulation call. Grounded answers usually land in
 * 10-20s; the tail reaches minutes, and a phase ends only when its slowest
 * call does, so an outlier is abandoned and recorded as a failed run rather
 * than holding the whole scan.
 */
export const SIMULATION_TIMEOUT_MS = 60_000;

/** Ceiling for one fix-generation call (no web search, so a shorter tail). */
export const FIX_TIMEOUT_MS = 45_000;

/** Product mirror older than this is rebuilt from the Admin API before a scan. */
export const CATALOG_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Pinned simulation questions expire after this long. Reusing questions keeps
 * consecutive scores comparable; expiring them keeps the questions from
 * fossilising as the market (and the store) moves on.
 */
export const QUESTIONS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
