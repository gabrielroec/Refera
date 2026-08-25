/**
 * Admin GraphQL operations.
 *
 * Every operation here was validated against the 2026-07 Admin schema with the
 * Shopify Dev MCP. Keep them in one file so re-validating after an API version
 * bump is a single sweep.
 *
 * The version is pinned in two places that must agree: `apiVersion` in
 * app/shopify.server.ts (what the client sends) and `api_version` under
 * [webhooks] in shopify.app.toml (what Shopify sends us).
 */

/**
 * Note on `images`: the field is deprecated in favour of `media`, but selecting
 * `media` pulls in six extra required scopes (read_files, read_themes,
 * read_orders, read_draft_orders, read_images, read_quick_sale). For an app
 * whose entire job is reading product copy, asking a merchant for order access
 * is not a trade worth making — so we stay on `images` (read_products only)
 * until it is actually removed.
 */
export const SCAN_PRODUCTS_QUERY = `#graphql
  query ScanProducts($first: Int!, $after: String) {
    products(
      first: $first
      after: $after
      sortKey: UPDATED_AT
      reverse: true
      query: "status:active"
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        descriptionHtml
        productType
        vendor
        tags
        status
        updatedAt
        category { id name fullName }
        seo { title description }
        images(first: 10) { nodes { altText url(transform: {maxWidth: 160, maxHeight: 160}) } }
        metafields(first: 25) { nodes { namespace key type value } }
      }
    }
  }
`;

/** Same selection as the scan query, for refreshing one product on a webhook. */
export const PRODUCT_BY_ID_QUERY = `#graphql
  query ProductById($id: ID!) {
    product(id: $id) {
      id
      handle
      title
      descriptionHtml
      productType
      vendor
      tags
      status
      updatedAt
      category { id name fullName }
      seo { title description }
      images(first: 10) { nodes { altText url(transform: {maxWidth: 160, maxHeight: 160}) } }
      metafields(first: 25) { nodes { namespace key type value } }
    }
  }
`;

export const SHOP_INFO_QUERY = `#graphql
  query ShopInfo {
    shop {
      name
      myshopifyDomain
      primaryDomain { host }
      currencyCode
    }
  }
`;

export const SEARCH_TAXONOMY_QUERY = `#graphql
  query SearchTaxonomy($search: String!) {
    taxonomy {
      categories(search: $search, first: 5) {
        nodes { id name fullName isLeaf isRoot }
      }
    }
  }
`;

export const PRODUCT_UPDATE_MUTATION = `#graphql
  mutation UpdateProduct($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
        descriptionHtml
        category { id fullName }
      }
      userErrors { field message }
    }
  }
`;

export const METAFIELDS_SET_MUTATION = `#graphql
  mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key type value }
      userErrors { field message code }
    }
  }
`;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface AdminGraphQLClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export interface GraphQLUserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

/**
 * Runs an operation and unwraps `data`, turning GraphQL-level errors into
 * thrown exceptions so callers only deal with the happy path.
 */
export async function adminQuery<T>(
  admin: AdminGraphQLClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (body.errors?.length) {
    throw new Error(
      `Admin API error: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!body.data) {
    throw new Error("Admin API returned no data");
  }
  return body.data;
}
