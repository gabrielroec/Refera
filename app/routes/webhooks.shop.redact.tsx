import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * GDPR: 48 hours after the app was uninstalled, erase everything for this store.
 *
 * Unlike the customer topics, this one has real work to do. Every row Refera
 * holds hangs off `Shop` with `onDelete: Cascade` — the product mirror, every
 * scan, and through those every snapshot, simulation and generated fix — so
 * deleting the shop deletes all of it. Sessions are keyed by domain rather than
 * by shop id, so they are removed separately.
 *
 * `deleteMany` rather than `delete`: the topic can arrive more than once, and
 * `app/uninstalled` may already have cleaned up part of this. A redaction that
 * throws because there was nothing left to redact would be retried by Shopify
 * for four hours and then counted as a failure.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  const [sessions, shops] = await db.$transaction([
    db.session.deleteMany({ where: { shop } }),
    db.shop.deleteMany({ where: { domain: shop } }),
  ]);

  console.log(
    `Received ${topic} for ${shop}: deleted ${shops.count} shop, ${sessions.count} sessions`,
  );

  return new Response();
};
