import {
  MAX_PRODUCTS_PER_SCAN,
  MIN_DESCRIPTION_LENGTH,
  MIN_METAFIELD_COUNT,
  PRODUCTS_PAGE_SIZE,
} from "../lib/constants";
import {
  adminQuery,
  PRODUCT_BY_ID_QUERY,
  SCAN_PRODUCTS_QUERY,
  SHOP_INFO_QUERY,
  type AdminGraphQLClient,
} from "../lib/graphql";
import { stableHash } from "../lib/hash";
import type { Issue, MetafieldEntry, ScannedProduct } from "../types";

// ---------------------------------------------------------------------------
// Admin API response shapes
// ---------------------------------------------------------------------------

interface ProductNode {
  id: string;
  handle: string | null;
  title: string;
  descriptionHtml: string | null;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  status: string;
  updatedAt: string | null;
  category: { id: string; name: string; fullName: string } | null;
  seo: { title: string | null; description: string | null } | null;
  images: { nodes: Array<{ altText: string | null; url: string | null }> };
  metafields: { nodes: MetafieldEntry[] };
}

interface ScanProductsData {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: ProductNode[];
  };
}

interface ProductByIdData {
  product: ProductNode | null;
}

interface ShopInfoData {
  shop: {
    name: string;
    myshopifyDomain: string;
    primaryDomain: { host: string } | null;
    currencyCode: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts product HTML to the plain text an LLM would actually read.
 *
 * Block-level tags become newlines so that list items and paragraphs do not run
 * together into one unreadable string — which would make short-description
 * detection wrong in both directions.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toScannedProduct(node: ProductNode): ScannedProduct {
  const images = node.images?.nodes ?? [];
  return {
    productId: node.id,
    status: node.status,
    updatedAt: node.updatedAt,
    handle: node.handle,
    title: node.title,
    descriptionHtml: node.descriptionHtml,
    description: htmlToText(node.descriptionHtml) || null,
    category: node.category?.fullName ?? null,
    categoryId: node.category?.id ?? null,
    productType: node.productType || null,
    vendor: node.vendor || null,
    tags: node.tags ?? [],
    imageCount: images.length,
    hasAltText: images.some((i) => Boolean(i.altText?.trim())),
    imageUrl: images.find((i) => i.url)?.url ?? null,
    metafields: node.metafields?.nodes ?? [],
    seoTitle: node.seo?.title || null,
    seoDescription: node.seo?.description || null,
  };
}

/**
 * Hash of exactly the fields the pipeline reasons about.
 *
 * `updatedAt` and `status` are deliberately excluded: inventory edits bump
 * updatedAt without changing anything an AI assistant could read, and that
 * must not invalidate cached analysis.
 */
export function productContentHash(product: ScannedProduct): string {
  return stableHash({
    title: product.title,
    description: product.description,
    categoryId: product.categoryId,
    productType: product.productType,
    vendor: product.vendor,
    tags: [...product.tags].sort(),
    imageCount: product.imageCount,
    hasAltText: product.hasAltText,
    metafields: product.metafields
      .map((m) => ({ namespace: m.namespace, key: m.key, value: m.value }))
      // Binary comparison, not localeCompare: the hash must be identical
      // across processes that may run under different locales (web app on
      // Vercel vs the Trigger.dev worker), or carry-forward silently breaks.
      .sort((a, b) => {
        const ka = `${a.namespace}.${a.key}`;
        const kb = `${b.namespace}.${b.key}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      }),
    seoDescription: product.seoDescription,
  });
}

// ---------------------------------------------------------------------------
// Issue detection
// ---------------------------------------------------------------------------

/**
 * Pure function: given a product, what is wrong with it from an AI-visibility
 * standpoint? Kept side-effect free so it can be unit tested and re-run over
 * historical snapshots without touching the Admin API.
 */
export function detectIssues(product: ScannedProduct): Issue[] {
  const issues: Issue[] = [];
  const description = product.description ?? "";

  if (!description) {
    issues.push({
      code: "MISSING_DESCRIPTION",
      severity: "high",
      message:
        "This product has no description. AI assistants have nothing to read, so it cannot be recommended.",
      field: "descriptionHtml",
      fixable: true,
    });
  } else if (description.length < MIN_DESCRIPTION_LENGTH) {
    issues.push({
      code: "SHORT_DESCRIPTION",
      severity: "high",
      message: `The description is only ${description.length} characters. Aim for ${MIN_DESCRIPTION_LENGTH}+ covering use case, materials and who it is for.`,
      field: "descriptionHtml",
      fixable: true,
    });
  }

  if (!product.categoryId) {
    issues.push({
      code: "MISSING_CATEGORY",
      severity: "high",
      message:
        "No Shopify taxonomy category is set. Category is a strong signal for how AI systems classify the product.",
      field: "category",
      fixable: true,
    });
  }

  if (product.metafields.length < MIN_METAFIELD_COUNT) {
    issues.push({
      code: "FEW_METAFIELDS",
      severity: "medium",
      message: `Only ${product.metafields.length} metafields. Structured attributes (material, size, use case) are what make a product answerable to specific questions.`,
      field: "metafields",
      fixable: true,
    });
  }

  if (product.imageCount === 0) {
    issues.push({
      code: "MISSING_IMAGES",
      severity: "medium",
      message: "This product has no images.",
      field: "images",
      // Refera writes copy, not photography.
      fixable: false,
    });
  } else if (!product.hasAltText) {
    issues.push({
      code: "MISSING_ALT_TEXT",
      severity: "low",
      message:
        "No image has alt text. Alt text is one of the few image signals a text model can read.",
      field: "images",
      fixable: false,
    });
  }

  if (!product.vendor) {
    issues.push({
      code: "MISSING_VENDOR",
      severity: "low",
      message: "No vendor/brand set. Brand is often what gets cited in an AI answer.",
      field: "vendor",
      fixable: false,
    });
  }

  if (!product.seoDescription) {
    issues.push({
      code: "MISSING_SEO_DESCRIPTION",
      severity: "low",
      message:
        "No SEO description. Crawlers that feed AI systems often read this before the body copy.",
      field: "seo.description",
      // No generator exists for this yet (it needs the approved description
      // as input). Advertising it as fixable would let it consume fix-budget
      // slots and never produce a Fix row.
      fixable: false,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ShopInfo {
  name: string;
  domain: string;
  /** The storefront's real host (custom domain when set) — what web search cites. */
  primaryDomain: string | null;
  currencyCode: string;
}

export async function fetchShopInfo(
  admin: AdminGraphQLClient,
): Promise<ShopInfo> {
  const data = await adminQuery<ShopInfoData>(admin, SHOP_INFO_QUERY);
  return {
    name: data.shop.name,
    domain: data.shop.myshopifyDomain,
    primaryDomain: data.shop.primaryDomain?.host ?? null,
    currencyCode: data.shop.currencyCode,
  };
}

/**
 * Pulls up to MAX_PRODUCTS_PER_SCAN active products, newest-updated first.
 *
 * Paginates rather than asking for 50 at once: the Admin API cost budget makes
 * a single large page with nested connections prone to throttling.
 */
export async function fetchProducts(
  admin: AdminGraphQLClient,
  limit: number = MAX_PRODUCTS_PER_SCAN,
): Promise<ScannedProduct[]> {
  const products: ScannedProduct[] = [];
  // A product edited between page fetches can shift past the cursor and come
  // back on a later page; a duplicate would violate the (scanId, productId)
  // unique constraint at persist time and sink the scan.
  const seen = new Set<string>();
  let after: string | null = null;

  while (products.length < limit) {
    const remaining = limit - products.length;
    const data: ScanProductsData = await adminQuery<ScanProductsData>(
      admin,
      SCAN_PRODUCTS_QUERY,
      { first: Math.min(PRODUCTS_PAGE_SIZE, remaining), after },
    );

    for (const node of data.products.nodes) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      products.push(toScannedProduct(node));
    }

    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
    if (!after) break;
  }

  return products.slice(0, limit);
}

/** Fetches one product with the scan selection; null when it no longer exists. */
export async function fetchProductById(
  admin: AdminGraphQLClient,
  productId: string,
): Promise<ScannedProduct | null> {
  const data = await adminQuery<ProductByIdData>(admin, PRODUCT_BY_ID_QUERY, {
    id: productId,
  });
  return data.product ? toScannedProduct(data.product) : null;
}
