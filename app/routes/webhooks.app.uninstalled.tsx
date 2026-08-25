import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Product webhooks stop at uninstall, so the mirror stops being maintained.
  // Clearing the sync timestamp forces a full rebuild on the first scan after
  // a reinstall instead of trusting a mirror frozen at uninstall time.
  await db.shop.updateMany({
    where: { domain: shop },
    data: { catalogSyncedAt: null },
  });

  return new Response();
};
