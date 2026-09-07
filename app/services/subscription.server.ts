import prisma from "../db.server";
import { SHOP_ID_QUERY, adminQuery } from "../lib/graphql";
import { unauthenticated } from "../shopify.server";

/**
 * Reconciles `Shop.planHandle` with what Shopify says the merchant pays for.
 *
 * Refera uses Shopify App Pricing: plans, prices and trials live in the
 * Partner Dashboard, Shopify hosts the plan selection page and creates the
 * subscription, and the app only *reads* the result. There are no webhooks
 * for this — the one source of truth is the Partner API's `activeSubscription`
 * query, so the app asks it and caches the answer on the Shop row.
 *
 * Three rules keep a merchant from being wrongly locked out:
 *   - a failed or throttled request never changes the stored plan;
 *   - an unrecognised handle degrades to Free in `entitlementsFor`, not here;
 *   - the Partner API being unconfigured (local dev) leaves the row untouched.
 */

/** Re-verify no more often than this unless something says the plan changed. */
export const PLAN_VERIFY_INTERVAL_MS = 5 * 60 * 1000;

const PARTNER_API_VERSION = "2026-07";

const ACTIVE_SUBSCRIPTION_QUERY = `
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      trialEndsAt
      cancelAtEndOfCycle
      currentBillingCycle { startTime endTime }
      items { handle }
      legacySubscriptionId
    }
  }
`;

interface ActiveSubscription {
  trialEndsAt: string | null;
  cancelAtEndOfCycle: boolean;
  currentBillingCycle: { startTime: string; endTime: string } | null;
  items: { handle: string }[];
  legacySubscriptionId: string | null;
}

interface PartnerApiConfig {
  orgId: string;
  accessToken: string;
  appGid: string;
}

function partnerApiConfig(): PartnerApiConfig | null {
  const orgId = process.env.SHOPIFY_PARTNER_ORG_ID;
  const accessToken = process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN;
  const appGid = process.env.SHOPIFY_APP_GID;
  if (!orgId || !accessToken || !appGid) return null;
  return { orgId, accessToken, appGid };
}

/** True when the app can ask Shopify about subscriptions at all. */
export function billingConfigured(): boolean {
  return partnerApiConfig() !== null;
}

/**
 * The merchant's current App Pricing contract, or null when they have none.
 * Throws on any failure, so a caller never mistakes an outage for "unpaid".
 */
export async function fetchActiveSubscription(
  shopGid: string,
): Promise<ActiveSubscription | null> {
  const config = partnerApiConfig();
  if (!config) throw new Error("Partner API is not configured");

  const response = await fetch(
    `https://partners.shopify.com/${config.orgId}/api/${PARTNER_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": config.accessToken,
      },
      body: JSON.stringify({
        query: ACTIVE_SUBSCRIPTION_QUERY,
        variables: { appId: config.appGid, shopId: shopGid },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  const body = (await response.json().catch(() => null)) as {
    data?: { activeSubscription: ActiveSubscription | null };
    errors?: unknown;
  } | null;

  if (!response.ok || !body || body.errors || !body.data) {
    throw new Error(
      `Partner API request failed: ${JSON.stringify(body?.errors ?? response.status)}`,
    );
  }
  return body.data.activeSubscription;
}

/**
 * Brings the Shop row in line with Shopify, if it is time to.
 *
 * `force` skips the freshness window — used when Shopify has just redirected
 * the merchant back from approving a plan, where a five-minute-old "free" is
 * exactly the wrong answer.
 */
export async function reconcilePlan(
  shop: { id: string; domain: string; planVerifiedAt: Date | null },
  options: { force?: boolean } = {},
): Promise<void> {
  if (!billingConfigured()) return;

  const fresh =
    shop.planVerifiedAt !== null &&
    Date.now() - shop.planVerifiedAt.getTime() < PLAN_VERIFY_INTERVAL_MS;
  if (fresh && !options.force) return;

  try {
    const { admin } = await unauthenticated.admin(shop.domain);
    const { shop: shopInfo } = await adminQuery<{ shop: { id: string } }>(
      admin,
      SHOP_ID_QUERY,
    );
    const subscription = await fetchActiveSubscription(shopInfo.id);

    const handle = subscription?.items[0]?.handle ?? "free";
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        planHandle: handle,
        planStatus: subscription
          ? subscription.trialEndsAt && new Date(subscription.trialEndsAt) > new Date()
            ? "TRIAL"
            : subscription.cancelAtEndOfCycle
              ? "CANCELLING"
              : "ACTIVE"
          : null,
        planCycleEnd: subscription?.currentBillingCycle
          ? new Date(subscription.currentBillingCycle.endTime)
          : null,
        subscriptionGid: subscription?.legacySubscriptionId ?? null,
        planVerifiedAt: new Date(),
      },
    });
  } catch (error) {
    // Leave the stored plan alone: a paying merchant must not lose access
    // because the Partner API blinked. The next request tries again.
    console.warn(`Plan reconcile failed for ${shop.domain}: ${String(error)}`);
  }
}

/**
 * Shopify-hosted plan selection page for this store. Lives outside the app
 * iframe, so callers must redirect with `target: "_top"`.
 */
export function planSelectionUrl(shopDomain: string, appHandle: string): string {
  const storeHandle = shopDomain.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}
