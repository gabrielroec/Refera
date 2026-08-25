import type { IssueCode, IssueSeverity } from "../types";

/**
 * Merchant-facing identity of each issue type.
 *
 * The scanner writes a per-product `message` explaining one product's problem;
 * this is the other view — the problem itself, named once, for the screen that
 * groups every affected product under it.
 */
export interface IssueDefinition {
  /** Short label, used as the row title. */
  label: string;
  /** One sentence on why an AI assistant cares. */
  why: string;
  severity: IssueSeverity;
  /** Whether Refera can generate a fix for it. */
  fixable: boolean;
  /** URL-safe id used in the route: /app/issues/:slug */
  slug: string;
}

export const ISSUE_DEFINITIONS: Record<IssueCode, IssueDefinition> = {
  MISSING_DESCRIPTION: {
    label: "No description",
    why: "AI assistants have nothing to read, so the product cannot be recommended.",
    severity: "high",
    fixable: true,
    slug: "no-description",
  },
  MISSING_CATEGORY: {
    label: "No product category",
    why: "Category is the strongest signal for how AI systems classify a product.",
    severity: "high",
    fixable: true,
    slug: "no-category",
  },
  SHORT_DESCRIPTION: {
    label: "Description too short",
    why: "Thin copy rarely contains the detail a specific shopper question needs.",
    severity: "high",
    fixable: true,
    slug: "short-description",
  },
  FEW_METAFIELDS: {
    label: "Few structured attributes",
    why: "Material, use case and audience are what match a product to a precise question.",
    severity: "medium",
    fixable: true,
    slug: "few-attributes",
  },
  MISSING_IMAGES: {
    label: "No images",
    why: "A product with no image reads as incomplete to shoppers and to crawlers.",
    severity: "medium",
    fixable: false,
    slug: "no-images",
  },
  MISSING_ALT_TEXT: {
    label: "Images without alt text",
    why: "Alt text is one of the few image signals a text model can read.",
    severity: "low",
    fixable: false,
    slug: "no-alt-text",
  },
  MISSING_VENDOR: {
    label: "No vendor set",
    why: "Brand is often the thing an AI answer actually cites.",
    severity: "low",
    fixable: false,
    slug: "no-vendor",
  },
  MISSING_SEO_DESCRIPTION: {
    label: "No SEO description",
    why: "Crawlers that feed AI systems often read this before the body copy.",
    severity: "low",
    fixable: false,
    slug: "no-seo-description",
  },
};

const BY_SLUG = new Map(
  (Object.entries(ISSUE_DEFINITIONS) as Array<[IssueCode, IssueDefinition]>).map(
    ([code, definition]) => [definition.slug, code],
  ),
);

export function issueCodeFromSlug(slug: string): IssueCode | null {
  return BY_SLUG.get(slug) ?? null;
}

/** Severity buckets, in the order the issues screen shows them. */
export const SEVERITY_BUCKETS: Array<{
  severity: IssueSeverity;
  label: string;
  tone: "critical" | "warning" | "neutral";
}> = [
  { severity: "high", label: "Critical", tone: "critical" },
  { severity: "medium", label: "Needs attention", tone: "warning" },
  { severity: "low", label: "Minor", tone: "neutral" },
];
