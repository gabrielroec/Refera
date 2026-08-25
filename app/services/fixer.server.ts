import prisma from "../db.server";
import {
  FIX_PROMPT_VERSION,
  FIX_TIMEOUT_MS,
  REFERA_METAFIELD_NAMESPACE,
} from "../lib/constants";
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

/**
 * One consolidated response per product. Empty string / empty array mean
 * "nothing proposed for this part" — kept required so both providers return a
 * predictable shape without strict-mode gymnastics.
 */
const PRODUCT_FIXES_SCHEMA = {
  type: "object",
  properties: {
    descriptionHtml: {
      type: "string",
      description:
        "Replacement product description as simple HTML, or empty string if not requested",
    },
    descriptionRationale: { type: "string" },
    metafields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: "string" },
        },
        required: ["key", "value"],
      },
    },
    metafieldsRationale: { type: "string" },
    categoryId: {
      type: "string",
      description:
        "The id of the chosen taxonomy category, copied verbatim from the candidate list, or empty string",
    },
    categoryRationale: { type: "string" },
  },
  required: [
    "descriptionHtml",
    "descriptionRationale",
    "metafields",
    "metafieldsRationale",
    "categoryId",
    "categoryRationale",
  ],
} as const;

interface ProductFixesResponse {
  descriptionHtml: string;
  descriptionRationale: string;
  metafields: Array<{ key: string; value: string }>;
  metafieldsRationale: string;
  categoryId: string;
  categoryRationale: string;
}

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

async function searchTaxonomyCandidates(
  admin: AdminGraphQLClient,
  product: ScannedProduct,
) {
  const searchTerm = [product.productType, product.title]
    .filter(Boolean)
    .join(" ")
    .slice(0, 80);

  const data = await adminQuery<TaxonomySearchData>(
    admin,
    SEARCH_TAXONOMY_QUERY,
    { search: searchTerm },
  );
  return data.taxonomy.categories.nodes.filter((c) => !c.isRoot);
}

/**
 * Generates every fix Refera can offer for one product, in a single LLM call.
 *
 * Consolidated on purpose: the earlier shape (one call per issue) made a
 * 20-product fix phase cost ~60 calls, which both burns money and turns
 * rate-limit hiccups into multi-hour scans. One call per product returns the
 * description, the metafields and the taxonomy pick together.
 *
 * Issues that cannot be fixed by generated copy (missing images, alt text,
 * vendor) are reported by the scanner but produce no Fix rows.
 */
export async function generateFixesForProduct(
  admin: AdminGraphQLClient,
  product: ScannedProduct,
  store: StoreContext,
  issues: Issue[],
): Promise<GeneratedFix[]> {
  const wantsDescription = issues.some(
    (i) => i.code === "MISSING_DESCRIPTION" || i.code === "SHORT_DESCRIPTION",
  );
  const wantsMetafields = issues.some((i) => i.code === "FEW_METAFIELDS");
  const wantsCategory = issues.some((i) => i.code === "MISSING_CATEGORY");

  if (!wantsDescription && !wantsMetafields && !wantsCategory) return [];

  let taxonomyCandidates: Awaited<ReturnType<typeof searchTaxonomyCandidates>> = [];
  if (wantsCategory) {
    try {
      taxonomyCandidates = await searchTaxonomyCandidates(admin, product);
    } catch (error) {
      // Taxonomy search failing (expired token, throttling) should not block
      // the description/metafield fixes for this product.
      console.error(
        `[fixer] taxonomy search for ${product.title}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const tasks: string[] = [];
  if (wantsDescription) {
    tasks.push(
      `1. "descriptionHtml": a replacement description as simple HTML (<p>, <ul>, <li>, <strong> only), 200-400 words, in ${store.language ?? "en-US"}. State plainly what the product is, who it is for, and the concrete use case. Include only attributes you can infer from the data given — invent nothing. Write so an AI assistant answering "best <category> for <use case>" could quote it. Also fill "descriptionRationale" (one sentence, English, for the merchant).`,
    );
  }
  if (wantsMetafields) {
    tasks.push(
      `2. "metafields": 3-5 structured attributes that help an AI assistant match this product to a specific question. Keys: snake_case English, generic across the category (e.g. "material", "use_case", "target_audience"). Values: plain text under 200 chars, in ${store.language ?? "en-US"}. Do not duplicate existing metafield keys. Only state what the data supports. Also fill "metafieldsRationale" (one sentence, English).`,
    );
  }
  if (wantsCategory && taxonomyCandidates.length > 0) {
    tasks.push(
      `3. "categoryId": the single best-fitting category id, copied VERBATIM from this list (prefer the most specific clearly-correct one):\n${taxonomyCandidates
        .map((c) => `- ${c.id} => ${c.fullName}`)
        .join("\n")}\nAlso fill "categoryRationale" (one sentence, English).`,
    );
  }

  // The category task drops out when taxonomy search found nothing; if that
  // was the only want, there is nothing left to ask — an LLM call with an
  // empty task list can only return garbage.
  if (tasks.length === 0) return [];

  const llm = getLLM();
  const response = await llm.generateJSON<ProductFixesResponse>({
    schema: PRODUCT_FIXES_SCHEMA as unknown as object,
    temperature: 0.5,
    timeoutMs: FIX_TIMEOUT_MS,
    system:
      "You improve e-commerce product data for AI shopping visibility. Answer only with the requested JSON. For any part not requested below, return an empty string or empty array.",
    prompt: `Store sells: ${store.niche ?? "unknown"}

Product:
- title: ${product.title}
- type: ${product.productType ?? "unknown"}
- vendor: ${product.vendor ?? "unknown"}
- tags: ${product.tags.join(", ") || "none"}
- current description: ${(product.description ?? "(empty)").slice(0, 1500)}
- existing metafields: ${
      product.metafields.map((m) => `${m.namespace}.${m.key}`).join(", ") || "none"
    }

Tasks:
${tasks.join("\n\n")}`,
  });

  const fixes: GeneratedFix[] = [];

  // Non-strict structured output means the schema is guidance, not a
  // guarantee — coerce every field before touching it so one omitted key
  // cannot throw away the fixes that were generated.
  const descriptionHtml =
    typeof response.descriptionHtml === "string" ? response.descriptionHtml : "";
  const categoryId =
    typeof response.categoryId === "string" ? response.categoryId.trim() : "";
  const metafieldItems = Array.isArray(response.metafields)
    ? response.metafields.filter(
        (mf): mf is { key: string; value: string } =>
          typeof mf?.key === "string" && typeof mf?.value === "string",
      )
    : [];

  if (wantsDescription && descriptionHtml.trim()) {
    const before: DescriptionPayload = {
      descriptionHtml: product.descriptionHtml ?? "",
    };
    const after: DescriptionPayload = {
      descriptionHtml,
    };
    fixes.push({
      type: "description",
      issueCode: product.description ? "SHORT_DESCRIPTION" : "MISSING_DESCRIPTION",
      rationale: response.descriptionRationale || "Richer copy for AI assistants to read.",
      before,
      after,
    });
  }

  if (wantsMetafields) {
    // Grows as fixes are accepted, so the model repeating a key within one
    // response cannot produce two Fix rows targeting the same refera.<key>.
    const existingKeys = new Set(product.metafields.map((m) => m.key));
    for (const mf of metafieldItems) {
      if (!mf.key.trim() || !mf.value.trim() || existingKeys.has(mf.key)) continue;
      existingKeys.add(mf.key);
      const before: MetafieldPayload = {
        namespace: REFERA_METAFIELD_NAMESPACE,
        key: mf.key,
        type: "single_line_text_field",
        value: "",
      };
      const after: MetafieldPayload = { ...before, value: mf.value };
      fixes.push({
        type: "metafield",
        issueCode: "FEW_METAFIELDS",
        rationale:
          response.metafieldsRationale || "Structured attributes make the product answerable.",
        before,
        after,
      });
    }
  }

  if (wantsCategory && categoryId) {
    // Refuse near-miss ids rather than writing a category that does not exist.
    const chosen = taxonomyCandidates.find((c) => c.id === categoryId);
    if (chosen) {
      const before: TaxonomyPayload = {
        categoryId: product.categoryId,
        category: product.category,
      };
      const after: TaxonomyPayload = {
        categoryId: chosen.id,
        category: chosen.fullName,
      };
      fixes.push({
        type: "taxonomy",
        issueCode: "MISSING_CATEGORY",
        rationale:
          response.categoryRationale || "A taxonomy category tells AI systems what this is.",
        before,
        after,
      });
    }
  }

  return fixes;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface SnapshotForFixes {
  id: string;
  product: ScannedProduct;
  issues: Issue[];
}

/**
 * Generates fixes for one snapshot and records them, moving the snapshot's
 * fixStatus through queued -> done/failed/skipped.
 *
 * Shared by the scan (eager, worst products first) and the on-demand path
 * (merchant asks for a product beyond the eager cap), so both produce
 * identical rows.
 */
export async function generateAndStoreFixes(
  admin: AdminGraphQLClient,
  snapshot: SnapshotForFixes,
  store: StoreContext,
): Promise<number> {
  if (!snapshot.issues.some((i) => i.fixable)) {
    await prisma.productSnapshot.update({
      where: { id: snapshot.id },
      data: { fixStatus: "skipped", fixesVersion: FIX_PROMPT_VERSION },
    });
    return 0;
  }

  await prisma.productSnapshot.update({
    where: { id: snapshot.id },
    data: { fixStatus: "queued" },
  });

  let fixes: GeneratedFix[];
  try {
    fixes = await generateFixesForProduct(admin, snapshot.product, store, snapshot.issues);
  } catch (error) {
    console.error(
      `[fixer] ${snapshot.product.title}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await prisma.productSnapshot.update({
      where: { id: snapshot.id },
      data: { fixStatus: "failed" },
    });
    return 0;
  }

  await prisma.$transaction([
    ...(fixes.length > 0
      ? [
          prisma.fix.createMany({
            data: fixes.map((fix) => ({
              productSnapshotId: snapshot.id,
              type: fix.type,
              issueCode: fix.issueCode,
              rationale: fix.rationale,
              before: fix.before as unknown as object,
              after: fix.after as unknown as object,
            })),
          }),
        ]
      : []),
    prisma.productSnapshot.update({
      where: { id: snapshot.id },
      data: { fixStatus: "done", fixesVersion: FIX_PROMPT_VERSION },
    }),
  ]);

  return fixes.length;
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
