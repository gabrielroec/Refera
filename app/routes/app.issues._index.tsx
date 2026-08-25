import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/billing.server";
import { loadIssuesScreen } from "../services/dashboard.server";
import { SEVERITY_BUCKETS } from "../lib/issues";
import { IssueNav } from "../components/issue-nav";
import { useIssuesContext } from "./app.issues";
import type { IssueGroup } from "../services/scorer.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  return loadIssuesScreen(shop.id);
};

/**
 * Every issue type in the scan, grouped by severity and ranked by what fixing
 * it is worth.
 *
 * This screen replaces a 39-row product table that printed 158 issue messages
 * inline. One decision here covers every product carrying that issue.
 */
export default function IssuesScreen() {
  const { groups, passed } = useLoaderData<typeof loader>();
  const { siblings } = useIssuesContext();

  return (
    <s-page heading="Issues found">
      <s-button slot="breadcrumb-actions" href="/app" variant="tertiary">
        Refera
      </s-button>

      <s-section>
        <IssueNav siblings={siblings} current="index" />
      </s-section>
      {groups.length === 0 && (
        <s-section>
          <s-paragraph>
            No issues found — or no scan has finished yet.
          </s-paragraph>
        </s-section>
      )}

      {SEVERITY_BUCKETS.map((bucket) => {
        const inBucket = groups.filter((g) => g.severity === bucket.severity);
        if (inBucket.length === 0) return null;
        const affected = inBucket.reduce((sum, g) => sum + g.productCount, 0);

        return (
          <s-section key={bucket.severity} heading={bucket.label}>
            <s-stack direction="block" gap="base">
              <s-badge tone={bucket.tone}>
                {affected} product{affected === 1 ? "" : "s"} affected
              </s-badge>
              <s-stack direction="block" gap="none">
                {inBucket.map((group) => (
                  <IssueRow key={group.code} group={group} />
                ))}
              </s-stack>
            </s-stack>
          </s-section>
        );
      })}

      {passed.length > 0 && (
        <s-section heading={`Passed · ${passed.length} check${passed.length === 1 ? "" : "s"}`}>
          <s-stack direction="inline" gap="small-300">
            {passed.map((label) => (
              <s-badge key={label} tone="success">
                {label}
              </s-badge>
            ))}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

/**
 * One issue type. Fixable rows link into the review queue; the rest state
 * plainly that Refera cannot write the fix, rather than offering a dead end.
 */
function IssueRow({ group }: { group: IssueGroup }) {
  const body = (
    <s-box padding="base" borderRadius="base">
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-stack direction="block" gap="small-500">
          <s-text type="strong">{group.label}</s-text>
          <s-text color="subdued">
            {group.productCount} product{group.productCount === 1 ? "" : "s"}
            {group.fixable
              ? ` · ${group.readyFixes} fix${group.readyFixes === 1 ? "" : "es"} ready`
              : " · Refera can't write this fix"}
          </s-text>
          <s-text color="subdued">{group.why}</s-text>
        </s-stack>
        <s-stack direction="inline" gap="small-300" alignItems="center">
          {group.scoreImpact > 0 && (
            <s-badge tone={group.severity === "high" ? "critical" : "warning"}>
              +{group.scoreImpact} pts
            </s-badge>
          )}
          {group.fixable && <s-text color="subdued">›</s-text>}
        </s-stack>
      </s-stack>
    </s-box>
  );

  if (!group.fixable) return body;

  return (
    <Link
      to={`/app/issues/${group.slug}`}
      style={{ textDecoration: "none", color: "inherit", display: "block" }}
    >
      {body}
    </Link>
  );
}

export function ErrorBoundary() {
  // Pass the real error through: replacing it with a label hides the actual
  // cause (a Prisma validation error once surfaced here as a bare string).
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
