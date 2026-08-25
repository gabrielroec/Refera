import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

/**
 * GDPR: a shopper's data must be erased.
 *
 * Nothing to erase — see the note in `webhooks.customers.data_request.tsx`.
 * Refera stores products, scans and generated copy, none of which is keyed to a
 * shopper.
 *
 * Shopify sends this up to 10 days after the merchant's request, and requires a
 * 2xx. Returning success for an erasure we did not perform is correct here only
 * because there is genuinely nothing to perform; the moment that changes, so
 * does this handler.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} for ${shop}: no customer data is stored`);

  return new Response();
};
