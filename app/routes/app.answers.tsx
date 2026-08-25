import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/billing.server";
import { loadAnswers } from "../services/dashboard.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  return loadAnswers(shop.id);
};

/**
 * The evidence behind the visibility score.
 *
 * The overview reduces this to one number and a row of competitor badges;
 * this screen shows the actual questions, how often the store surfaced in the
 * answers, and who was recommended instead.
 */
export default function AnswersScreen() {
  const { answers, appearances, totalRuns, leaderboard } =
    useLoaderData<typeof loader>();

  if (answers.length === 0) {
    return (
      <s-page heading="AI answers">
        <s-section>
          <s-paragraph>
            No simulations yet. Run a scan to see how AI assistants answer the
            questions your buyers ask.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="AI answers">
      <s-section>
        <s-stack direction="block" gap="small-300">
          <s-paragraph>
            Each question was asked to a web-grounded AI assistant three times,
            without naming your store — so an appearance means it surfaced on
            its own.
          </s-paragraph>
          <s-text type="strong">
            {appearances > 0
              ? `Your store appeared in ${appearances} of ${totalRuns} answers`
              : `Your store was not mentioned in any of the ${totalRuns} answers`}
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Questions your buyers ask">
        <s-stack direction="block" gap="none">
          {answers.map((answer) => {
            const appeared = answer.appearanceCount > 0;
            return (
              <s-box key={answer.id} padding="base" borderRadius="base">
                <s-stack direction="block" gap="small-300">
                  <s-stack direction="inline" gap="small-300" alignItems="start">
                    <s-badge tone={appeared ? "success" : "critical"}>
                      {appeared
                        ? `${answer.appearanceCount}/${answer.runCount}`
                        : "Not mentioned"}
                    </s-badge>
                    <s-text type="strong">{answer.question}</s-text>
                  </s-stack>
                  {answer.excerpt && (
                    <s-text color="subdued">“{answer.excerpt}”</s-text>
                  )}
                  {answer.competitors.length > 0 && (
                    <s-text color="subdued">
                      Recommended: {answer.competitors.slice(0, 6).join(", ")}
                      {answer.competitors.length > 6 &&
                        ` +${answer.competitors.length - 6} more`}
                    </s-text>
                  )}
                </s-stack>
              </s-box>
            );
          })}
        </s-stack>
      </s-section>

      {leaderboard.length > 0 && (
        <s-section heading="Who gets recommended">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Brands named across all {totalRuns} answers, most cited first.
            </s-text>
            <s-stack direction="inline" gap="small-300">
              {leaderboard.slice(0, 15).map((brand) => (
                <s-badge key={brand.name}>
                  {brand.name} · {brand.mentions}
                </s-badge>
              ))}
            </s-stack>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export function ErrorBoundary() {
  // Pass the real error through: replacing it with a label hides the actual
  // cause (a Prisma validation error once surfaced here as a bare string).
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
