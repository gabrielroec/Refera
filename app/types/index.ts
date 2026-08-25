/**
 * Shared domain types.
 *
 * Prisma owns the row shapes; this file owns the shapes of everything stored
 * *inside* the Json columns, plus the contracts between services. Anything that
 * crosses a service boundary should be typed here rather than inline.
 */

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export interface MetafieldEntry {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

/** A product as returned by the scanner, before it is persisted. */
export interface ScannedProduct {
  productId: string;
  /** ACTIVE | DRAFT | ARCHIVED — only ACTIVE products are scanned. */
  status: string;
  /** Shopify's updatedAt (ISO), for newest-first ordering of the mirror. */
  updatedAt: string | null;
  handle: string | null;
  title: string;
  /** Raw HTML from the Admin API. */
  descriptionHtml: string | null;
  /** HTML stripped — what an LLM would actually read. */
  description: string | null;
  category: string | null;
  categoryId: string | null;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  imageCount: number;
  hasAltText: boolean;
  /** Thumbnail URL of the first image, when the product has one. */
  imageUrl: string | null;
  metafields: MetafieldEntry[];
  seoTitle: string | null;
  seoDescription: string | null;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export type IssueCode =
  | "MISSING_DESCRIPTION"
  | "SHORT_DESCRIPTION"
  | "MISSING_CATEGORY"
  | "FEW_METAFIELDS"
  | "MISSING_IMAGES"
  | "MISSING_ALT_TEXT"
  | "MISSING_VENDOR"
  | "MISSING_SEO_DESCRIPTION";

export type IssueSeverity = "high" | "medium" | "low";

export interface Issue {
  code: IssueCode;
  severity: IssueSeverity;
  /** Merchant-facing, English (the app UI is English). */
  message: string;
  /** Which product field the issue points at. */
  field: string;
  /** Whether Refera can generate a fix for this issue. */
  fixable: boolean;
}

// ---------------------------------------------------------------------------
// Simulations
// ---------------------------------------------------------------------------

export interface SimulationExecution {
  /** 1-based run index. */
  run: number;
  /** Did the store (or one of its products) show up in the answer? */
  appeared: boolean;
  /**
   * 1-based rank of the store's first mention among the brands listed,
   * or null when it did not appear.
   */
  position: number | null;
  /** Competing brands/stores cited in the answer. */
  competitors: string[];
  /** Short quote from the answer, for the UI. */
  excerpt: string | null;
  /** Set when the LLM call failed; the run still counts toward runCount. */
  error?: string;
}

export interface SimulationResult {
  question: string;
  model: string;
  grounded: boolean;
  executions: SimulationExecution[];
  appearanceCount: number;
  runCount: number;
  competitors: string[];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  /** 0-100: how complete the catalogue data is. */
  dataScore: number;
  /** 0-100: how often the store surfaced in simulated AI answers. */
  visibilityScore: number;
  /** Weighted combination, 0-100. */
  total: number;
  /** Supporting numbers for the dashboard. */
  details: {
    productsScanned: number;
    issuesFound: number;
    totalRuns: number;
    appearances: number;
    /** Distinct competitors seen across every simulation. */
    distinctCompetitors: number;
  };
}

// ---------------------------------------------------------------------------
// Fixes
// ---------------------------------------------------------------------------

export type FixTypeName = "description" | "metafield" | "taxonomy";

export interface DescriptionPayload {
  descriptionHtml: string;
}

export interface MetafieldPayload {
  namespace: string;
  key: string;
  type: string;
  value: string;
}

export interface TaxonomyPayload {
  categoryId: string | null;
  category: string | null;
}

export type FixPayload =
  | DescriptionPayload
  | MetafieldPayload
  | TaxonomyPayload;

/** A fix as produced by the fixer, before it is persisted. */
export interface GeneratedFix {
  type: FixTypeName;
  issueCode: IssueCode | null;
  rationale: string;
  before: FixPayload;
  after: FixPayload;
}

// ---------------------------------------------------------------------------
// Store context
// ---------------------------------------------------------------------------

/** Everything the simulator needs to write believable buyer questions. */
export interface StoreContext {
  /** myshopify domain. */
  domain: string;
  /** The storefront's real host (custom domain when set) — what web search cites. */
  primaryDomain: string | null;
  name: string | null;
  niche: string | null;
  currencyCode: string | null;
  /** BCP-47-ish tag inferred from catalogue text, e.g. "pt-BR". */
  language: string | null;
  /** Sample product titles used to ground question generation. */
  sampleTitles: string[];
}
