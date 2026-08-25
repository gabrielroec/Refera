import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

/**
 * GDPR: a shopper has asked the merchant for the data we hold about them.
 *
 * Refera holds none. The app reads products, writes product content, and asks
 * AI assistants questions about the catalogue — it never touches orders,
 * customers or checkouts, and its access scopes (`read_products`,
 * `write_products`) could not reach them if it tried.
 *
 * Acknowledging is still mandatory: Shopify requires the endpoint to exist and
 * to verify the HMAC, and an app that fails these is rejected at review.
 * `authenticate.webhook` does the verification and throws a 401 on a bad
 * signature, so reaching the return statement means the request was genuinely
 * Shopify's.
 *
 * If Refera ever stores something keyed to a shopper, this handler has to start
 * returning it to the merchant — the obligation follows the data, not this file.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} for ${shop}: no customer data is stored`);

  return new Response();
};
