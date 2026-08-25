import prisma from "../db.server";
import { CATALOG_SYNC_MAX_AGE_MS, MAX_PRODUCTS_PER_SCAN } from "../lib/constants";
import type { AdminGraphQLClient } from "../lib/graphql";
import {
  fetchProductById,
  fetchProducts,
  productContentHash,
} from "./scanner.server";
import type { ScannedProduct } from "../types";

/**
 * The product mirror: a local, always-fresh copy of the catalogue.
 *
 * Product webhooks keep it current one product at a time; a full rebuild from
 * the Admin API happens on the first scan and whenever the mirror is older
 * than CATALOG_SYNC_MAX_AGE_MS (Shopify does not guarantee webhook delivery,
 * so a periodic reconciliation is the documented safety net).
 *
 * With the mirror in place, the catalogue phase of a scan is one indexed
 * Postgres read instead of paginated API calls.
 */

export interface CatalogueProduct extends ScannedProduct {
  contentHash: string;
}

function withHash(product: ScannedProduct): CatalogueProduct {
  return { ...product, contentHash: productContentHash(product) };
}

function toMirrorRow(shopId: string, product: CatalogueProduct) {
  return {
    shopId,
    productId: product.productId,
    status: product.status,
    data: product as unknown as object,
    contentHash: product.contentHash,
    shopifyUpdatedAt: product.updatedAt ? new Date(product.updatedAt) : null,
  };
}

/** Upserts one product into the mirror (webhook path and full-sync path). */
async function upsertMirror(shopId: string, product: CatalogueProduct) {
  const row = toMirrorRow(shopId, product);
  await prisma.productMirror.upsert({
    where: { shopId_productId: { shopId, productId: product.productId } },
    create: row,
    update: row,
  });
}

/**
 * Rebuilds the mirror from the Admin API.
 *
 * The mirror is replaced wholesale in one transaction: products the API no
 * longer returns disappear with it, and the write costs two round trips to
 * the database instead of one per product — which matters when the database
 * is a continent away.
 */
export async function syncCatalogue(
  shopId: string,
  admin: AdminGraphQLClient,
): Promise<CatalogueProduct[]> {
  const products = (await fetchProducts(admin, MAX_PRODUCTS_PER_SCAN)).map(withHash);

  await prisma.$transaction([
    prisma.productMirror.deleteMany({ where: { shopId } }),
    prisma.productMirror.createMany({
      data: products.map((product) => toMirrorRow(shopId, product)),
      // A product webhook can upsert between our delete and this insert; its
      // row is fresher than ours, so losing the race is the right outcome.
      skipDuplicates: true,
    }),
    prisma.shop.update({
      where: { id: shopId },
      data: { catalogSyncedAt: new Date() },
    }),
  ]);

  return products;
}

/**
 * Returns the catalogue for a scan, from the mirror when it is trustworthy and
 * from the Admin API (rebuilding the mirror) when it is not.
 */
export async function loadCatalogue(
  shopId: string,
  admin: AdminGraphQLClient,
  log: (message: string, data?: Record<string, unknown>) => void,
): Promise<CatalogueProduct[]> {
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { catalogSyncedAt: true },
  });

  const fresh =
    shop.catalogSyncedAt !== null &&
    Date.now() - shop.catalogSyncedAt.getTime() < CATALOG_SYNC_MAX_AGE_MS;

  if (fresh) {
    const rows = await prisma.productMirror.findMany({
      where: { shopId, status: "ACTIVE" },
      orderBy: { shopifyUpdatedAt: "desc" },
      take: MAX_PRODUCTS_PER_SCAN,
      select: { data: true },
    });
    if (rows.length > 0) {
      log("Catalogue loaded from mirror", { count: rows.length });
      return rows.map((r) => r.data as unknown as CatalogueProduct);
    }
  }

  log("Rebuilding catalogue mirror from Admin API");
  const products = await syncCatalogue(shopId, admin);
  log("Catalogue synced", { count: products.length });
  return products;
}

// ---------------------------------------------------------------------------
// Webhook entry points
// ---------------------------------------------------------------------------

/**
 * Refreshes one product after a products/create or products/update webhook.
 *
 * The webhook payload itself is REST-shaped and lacks metafields and the
 * taxonomy category, so the product is re-read through the same GraphQL
 * selection the scan uses — one small query, and the mirror stays exact.
 */
export async function refreshMirroredProduct(
  shopDomain: string,
  admin: AdminGraphQLClient,
  productId: string,
): Promise<void> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true },
  });
  // Webhooks can arrive before the shop row exists (install race) — nothing
  // to mirror yet; the first scan will do a full sync.
  if (!shop) return;

  const product = await fetchProductById(admin, productId);
  if (!product) {
    await removeMirroredProduct(shopDomain, productId);
    return;
  }
  await upsertMirror(shop.id, withHash(product));
}

/** Drops a product from the mirror after a products/delete webhook. */
export async function removeMirroredProduct(
  shopDomain: string,
  productId: string,
): Promise<void> {
  await prisma.productMirror.deleteMany({
    where: { shop: { domain: shopDomain }, productId },
  });
}

/** Builds a product GID from the numeric id webhooks carry. */
export function productGid(numericId: number | string): string {
  return `gid://shopify/Product/${numericId}`;
}
