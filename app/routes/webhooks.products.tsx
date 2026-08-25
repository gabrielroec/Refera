import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  productGid,
  refreshMirroredProduct,
  removeMirroredProduct,
} from "../services/catalogue.server";

/**
 * products/create, products/update, products/delete.
 *
 * Keeps the product mirror current so a scan never has to page through the
 * Admin API. Shopify retries on non-2xx and may deliver out of order or more
 * than once, so every branch is an idempotent upsert/delete keyed by product
 * id. The handler must answer within 5 seconds — a single product query does.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, admin, payload } = await authenticate.webhook(request);

  const numericId = (payload as { id?: number | string }).id;
  if (numericId === undefined || numericId === null) {
    return new Response();
  }
  const productId = productGid(numericId);

  if (topic === "PRODUCTS_DELETE") {
    await removeMirroredProduct(shop, productId);
    return new Response();
  }

  // `admin` is undefined when the app was uninstalled before delivery; there
  // is nothing left to keep in sync in that case.
  if (admin) {
    await refreshMirroredProduct(shop, admin, productId);
  }

  return new Response();
};
