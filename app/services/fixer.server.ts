import { REFERA_METAFIELD_NAMESPACE } from "../lib/constants";
import {
  adminQuery,
  METAFIELDS_SET_MUTATION,
  PRODUCT_UPDATE_MUTATION,
  SEARCH_TAXONOMY_QUERY,
  type AdminGraphQLClient,
  type GraphQLUserError,
} from "../lib/graphql";
import { getLLM } from "./llm";
import type {
  DescriptionPayload,
  GeneratedFix,
  Issue,
  MetafieldPayload,
  ScannedProduct,
  StoreContext,
  TaxonomyPayload,
} from "../types";

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const DESCRIPTION_SCHEMA = {
  type: "OBJECT",
  properties: {
    descriptionHtml: { type: "STRING" },
    rationale: { type: "STRING" },
  },
  required: ["descriptionHtml", "rationale"],
} as const;

async function generateDescriptionFix(
  product: ScannedProduct,
  store: StoreContext,
  issue: Issue,
): Promise<GeneratedFix> {
  const llm = getLLM();

  const result = await llm.generateJSON<{
    descriptionHtml: string;
    rationale: string;
  }>({
    schema: DESCRIPTION_SCHEMA as unknown as object,
    temperature: 0.6,
    system:
      "You write e-commerce product copy optimised for AI shopping assistants. Answer only with the requested JSON.",
    prompt: `Store sells: ${store.niche ?? "unknown"}
Write in this language: ${store.language ?? "en-US"}

Product:
- title: ${product.title}
- type: ${product.productType ?? "unknown"}
- vendor: ${product.vendor ?? "unknown"}
- tags: ${product.tags.join(", ") || "none"}
- current description: ${product.description || "(empty)"}

Write a replacement description as simple HTML (<p>, <ul>, <li>, <strong> only).

Requirements:
- 200-400 words.
- State plainly what it is, who it is for, and the concrete use case.
- Include specific attributes (materials, dimensions, care, compatibility) — invent nothing you cannot infer from the title, type and tags. If a fact is unknown, leave it out rather than guessing.
- Write so that an AI assistant answering "best <category> for <use case>" could quote it.
- No marketing fluff, no invented awards, no invented prices.

Also return "rationale": one sentence, in English, telling the merchant why this improves AI visibility.`,
  });

  const before: DescriptionPayload = {
    descriptionHtml: product.descriptionHtml ?? "",
  };
  const after: DescriptionPayload = {
    descriptionHtml: result.descriptionHtml,
  };

  return {
    type: "description",
    issueCode: issue.code,
    rationale: result.rationale,
    before,
    after,
  };
}

const METAFIELDS_SCHEMA = {
  type: "OBJECT",
  properties: {
    metafields: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          key: { type: "STRING" },
          value: { type: "STRING" },
        },
        required: ["key", "value"],
      },
    },
    rationale: { type: "STRING" },
  },
  required: ["metafields", "rationale"],
} as const;

/**
 * Proposes structured attributes for a product.
 *
 * Everything is written under Refera's own namespace as single_line_text_field:
 * the MVP must never collide with a metafield definition the merchant already
 * owns, and inferring a merchant's custom types is not worth the failure modes.
 */
async function generateMetafieldFixes(
  product: ScannedProduct,
  store: StoreContext,
  issue: Issue,
): Promise<GeneratedFix[]> {
  const llm = getLLM();

  const result = await llm.generateJSON<{
    metafields: Array<{ key: string; value: string }>;
    rationale: string;
  }>({
    schema: METAFIELDS_SCHEMA as unknown as object,
    temperature: 0.4,
    system:
      "You extract structured product attributes. Answer only with the requested JSON.",
    prompt: `Store sells: ${store.niche ?? "unknown"}

Product:
- title: ${product.title}
- type: ${product.productType ?? "unknown"}
- description: ${(product.description ?? "(empty)").slice(0, 1500)}
- tags: ${product.tags.join(", ") || "none"}
- existing metafields: ${
      product.metafields.map((m) => `${m.namespace}.${m.key}`).join(", ") ||
      "none"
    }

Propose 3-5 attributes that would help an AI assistant match this product to a specific shopper question.

Rules:
- "key": snake_case, English, generic across the category (e.g. "material", "use_case", "target_audience", "size_range", "care_instructions").
- "value": plain text, under 200 characters, in ${store.language ?? "en-US"}.
- Only state what you can infer from the information given. Do not invent measurements, certifications or prices.
- Do not duplicate an existing metafield key.

Also return "rationale": one sentence in English explaining the benefit to the merchant.`,
  });

  return result.metafields.map((mf) => {
    const before: MetafieldPayload = {
      namespace: REFERA_METAFIELD_NAMESPACE,
      key: mf.key,
      type: "single_line_text_field",
      value: "",
    };
    const after: MetafieldPayload = {
      namespace: REFERA_METAFIELD_NAMESPACE,
      key: mf.key,
      type: "single_line_text_field",
      value: mf.value,
    };
    return {
      type: "metafield" as const,
      issueCode: issue.code,
      rationale: result.rationale,
      before,
      after,
    };
  });
}

const TAXONOMY_PICK_SCHEMA = {
  type: "OBJECT",
  properties: {
    categoryId: { type: "STRING" },
    rationale: { type: "STRING" },
  },
  required: ["categoryId", "rationale"],
} as const;

interface TaxonomySearchData {
  taxonomy: {
    categories: {
      nodes: Array<{
        id: string;
        name: string;
        fullName: string;
        isLeaf: boolean;
        isRoot: boolean;
      }>;
    };
  };
}

/**
 * Picks a Shopify taxonomy category for a product.
 *
 * The candidate list comes from Shopify's own taxonomy search — the LLM only
 * chooses among real categories, so it cannot invent a category ID that would
 * fail at write time.
 */
async function generateTaxonomyFix(
  admin: AdminGraphQLClient,
  product: ScannedProduct,
  issue: Issue,
): Promise<GeneratedFix | null> {
  const searchTerm = [product.productType, product.title]
    .filter(Boolean)
    .join(" ")
    .slice(0, 80);

  const data = await adminQuery<TaxonomySearchData>(
    admin,
    SEARCH_TAXONOMY_QUERY,
    { search: searchTerm },
  );

  const candidates = data.taxonomy.categories.nodes.filter((c) => !c.isRoot);
  if (candidates.length === 0) return null;

  const llm = getLLM();
  const result = await llm.generateJSON<{
    categoryId: string;
    rationale: string;
  }>({
    schema: TAXONOMY_PICK_SCHEMA as unknown as object,
    temperature: 0,
    system:
      "You classify products into a fixed taxonomy. Answer only with the requested JSON.",
    prompt: `Product:
- title: ${product.title}
- type: ${product.productType ?? "unknown"}
- description: ${(product.description ?? "").slice(0, 500)}

Candidate categories:
${candidates.map((c) => `- ${c.id} => ${c.fullName}`).join("\n")}

Return "categoryId": the id of the single best-fitting category, copied verbatim from the list above. Prefer the most specific one that is still clearly correct.
Also return "rationale": one sentence in English for the merchant.`,
  });

  const chosen = candidates.find((c) => c.id === result.categoryId);
  // The model occasionally returns a near-miss id; refuse rather than write a
  // category that does not exist.
  if (!chosen) return null;

  const before: TaxonomyPayload = {
    categoryId: product.categoryId,
    category: product.category,
  };
  const after: TaxonomyPayload = {
    categoryId: chosen.id,
    category: chosen.fullName,
  };

  return {
    type: "taxonomy",
    issueCode: issue.code,
    rationale: result.rationale,
    before,
    after,
  };
}

/**
 * Generates every fix Refera can offer for one product.
 *
 * Issues that are not fixable by copy generation (missing images, missing alt
 * text, missing vendor) are reported by the scanner but produce no Fix rows —
 * suggesting a photograph is outside what this app can honestly deliver.
 */
export async function generateFixesForProduct(
  admin: AdminGraphQLClient,
  product: ScannedProduct,
  store: StoreContext,
  issues: Issue[],
): Promise<GeneratedFix[]> {
  const fixes: GeneratedFix[] = [];

  for (const issue of issues) {
    if (!issue.fixable) continue;

    try {
      switch (issue.code) {
        case "MISSING_DESCRIPTION":
        case "SHORT_DESCRIPTION":
          fixes.push(await generateDescriptionFix(product, store, issue));
          break;
        case "FEW_METAFIELDS":
          fixes.push(...(await generateMetafieldFixes(product, store, issue)));
          break;
        case "MISSING_CATEGORY": {
          const fix = await generateTaxonomyFix(admin, product, issue);
          if (fix) fixes.push(fix);
          break;
        }
        default:
          // MISSING_SEO_DESCRIPTION is flagged but not auto-fixed in the MVP:
          // it needs the final description as input, which may itself be
          // pending approval.
          break;
      }
    } catch {
      // A single failed generation should not abort the product. The issue
      // stays visible in the diagnosis with no fix attached.
      continue;
    }
  }

  return fixes;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

function formatUserErrors(errors: GraphQLUserError[]): string {
  return errors
    .map((e) => `${e.field?.join(".") ?? "?"}: ${e.message}`)
    .join("; ");
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
}

/**
 * Writes one approved fix back to Shopify.
 *
 * Callers must have verified merchant approval first — this function does not
 * check status, and nothing else in the codebase may call it directly from a
 * loader.
 */
export async function applyFix(
  admin: AdminGraphQLClient,
  productId: string,
  type: "description" | "metafield" | "taxonomy",
  after: unknown,
): Promise<ApplyResult> {
  try {
    if (type === "metafield") {
      const payload = after as MetafieldPayload;
      const data = await adminQuery<{
        metafieldsSet: { userErrors: GraphQLUserError[] };
      }>(admin, METAFIELDS_SET_MUTATION, {
        metafields: [
          {
            ownerId: productId,
            namespace: payload.namespace,
            key: payload.key,
            type: payload.type,
            value: payload.value,
          },
        ],
      });

      const errors = data.metafieldsSet.userErrors;
      return errors.length
        ? { ok: false, error: formatUserErrors(errors) }
        : { ok: true };
    }

    const input: Record<string, unknown> = { id: productId };

    if (type === "description") {
      input.descriptionHtml = (after as DescriptionPayload).descriptionHtml;
    } else {
      const payload = after as TaxonomyPayload;
      if (!payload.categoryId) {
        return { ok: false, error: "Fix has no category id" };
      }
      input.category = payload.categoryId;
    }

    const data = await adminQuery<{
      productUpdate: { userErrors: GraphQLUserError[] };
    }>(admin, PRODUCT_UPDATE_MUTATION, { product: input });

    const errors = data.productUpdate.userErrors;
    return errors.length
      ? { ok: false, error: formatUserErrors(errors) }
      : { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
