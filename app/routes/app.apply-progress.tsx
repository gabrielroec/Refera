import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/billing.server";
import { loadApplyProgress } from "../services/dashboard.server";

/**
 * Live progress of an apply run, polled by the modal.
 *
 * Small on purpose: it answers "how many are done and what is being written
 * right now", and nothing else.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const ids = new URL(request.url).searchParams.get("ids") ?? "";
  const fixIds = ids.split(",").map((id) => id.trim()).filter(Boolean);

  return loadApplyProgress(shop.id, fixIds);
};
