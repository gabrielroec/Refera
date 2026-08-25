import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop, getPlanState } from "../services/billing.server";
import { loadOverview } from "../services/dashboard.server";
import {
  COMPARISON,
  FREE_PLAN,
  PAID_FIXES,
  PAID_PLANS,
  answersFor,
  isBooleanRow,
  recommendedPlan,
  scansLabel,
  type PaidPlan,
  type PaidPlanId,
} from "../lib/plans";
import styles from "../styles/plans.module.css";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [plan, overview] = await Promise.all([
    getPlanState(shop.id),
    loadOverview(shop.id),
  ]);

  return {
    plan: plan.planHandle,
    hasUsedFreeScan: plan.hasUsedFreeScan,
    appearances: overview.appearances,
    totalRuns: overview.totalRuns,
    highSeverityIssueTypes: overview.topIssues.filter((g) => g.severity === "high")
      .length,
  };
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Plans.
 *
 * Built in plain React rather than Polaris components, so the cards can carry
 * their own motion and spacing. `s-page` stays as the shell — it is what puts
 * the title and breadcrumb into the admin's own frame — but everything inside
 * is ours.
 *
 * Nothing on this screen is a number we made up. The headline is the shop's own
 * scan result; the quotas come from `lib/plans.ts`, which reads `constants.ts`;
 * the recommendation is computed from this shop's data and can genuinely land
 * on Starter. There is no "Most popular" badge, no countdown, no strikethrough
 * price and no revenue-loss estimate — Refera has not launched, so a popularity
 * claim would be a fabrication, and an app whose product is measuring reality
 * cannot afford to be caught inventing a figure on its own pricing page.
 *
 * NOTE: the header `primary-action` slot is deliberately empty. Built for
 * Shopify allows one primary button per page, and on this page it belongs to
 * the recommended plan.
 */
export default function Plans() {
  const {
    plan,
    hasUsedFreeScan,
    appearances,
    totalRuns,
    highSeverityIssueTypes,
  } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();

  const recommended = recommendedPlan(appearances, totalRuns, highSeverityIssueTypes);
  // With no scan to reason from there is no recommendation to make, but the
  // page still needs exactly one primary button.
  const featured: PaidPlanId = recommended ?? "growth";

  const choose = (chosen: PaidPlan) => {
    // Billing is not connected yet. A Choose button that silently does nothing
    // is worse than no button, so say so plainly.
    shopify.toast.show(
      `${chosen.name} is not purchasable yet — billing is not connected.`,
    );
  };

  return (
    <s-page heading="Plans">
      <s-button slot="breadcrumb-actions" href="/app" variant="tertiary">
        Overview
      </s-button>

      <s-section>
        <div className={styles.intro}>
          <p className={styles.subhead}>
            {totalRuns === 0 ? (
              "See how often AI assistants recommend your store, and fix what's holding it back."
            ) : (
              <>
                <span className={styles.measured}>
                  Your store came up in {appearances} of {totalRuns} AI answers.
                </span>{" "}
                A paid plan keeps checking, and gives you the fix for every
                product instead of five samples.
              </>
            )}
          </p>

          {plan === "free" && (
            <div className={styles.currentPlan}>
              <span className={styles.currentPlanLabel}>You&rsquo;re on Free</span>
              <span className={styles.currentPlanDetail}>
                — {FREE_PLAN.scansLabel}
                {hasUsedFreeScan ? " (used)" : ""} · {FREE_PLAN.productsLabel} ·{" "}
                {FREE_PLAN.questions} questions per scan (
                {answersFor(FREE_PLAN.questions)} answers) · {FREE_PLAN.fixesLabel}
              </span>
            </div>
          )}
        </div>

        <div className={styles.grid}>
          {PAID_PLANS.map((tier) => (
            <PlanCard
              key={tier.id}
              tier={tier}
              featured={tier.id === featured}
              recommended={tier.id === recommended}
              current={plan === tier.id}
              onChoose={() => choose(tier)}
            />
          ))}
        </div>
      </s-section>

      <s-section heading="Compare plans">
        <ComparisonTable featured={featured} />
      </s-section>

      <s-section>
        <p className={styles.footnote}>
          Prices in USD, billed monthly through Shopify. A scan reads your
          catalogue and asks each question {answersFor(1)} times, so
          &ldquo;answers&rdquo; is questions &times; {answersFor(1)}. Nothing in
          your store changes without your approval on any plan.
        </p>
      </s-section>
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

/**
 * One plan.
 *
 * Every card renders the same seven slots in the same order, including the ones
 * it has nothing to put in, so a merchant can trace a label straight across
 * three columns. That alignment is the whole point of the grid; a card that
 * skips its badge slot pushes its own price 24px out of line with its
 * neighbours.
 */
function PlanCard({
  tier,
  featured,
  recommended,
  current,
  onChoose,
}: {
  tier: PaidPlan;
  featured: boolean;
  recommended: boolean;
  current: boolean;
  onChoose: () => void;
}) {
  const rows: [string, string][] = [
    ["Scans", scansLabel(tier)],
    [
      "Questions per scan",
      `${tier.questions} (${answersFor(tier.questions)} answers)`,
    ],
    ["Fixes", PAID_FIXES],
    ["Competitor tracking", tier.competitors ? "Included" : "Not included"],
  ];

  return (
    <article
      className={`${styles.card}${featured ? ` ${styles.featured}` : ""}`}
      aria-label={`${tier.name} plan`}
    >
      <div className={styles.badgeSlot}>
        {recommended && (
          <span className={styles.badge}>Recommended for your store</span>
        )}
      </div>

      <h3 className={styles.name}>{tier.name}</h3>
      <p className={styles.positioning}>{tier.positioning}</p>

      <div className={styles.priceBlock}>
        <span className={styles.price}>
          ${tier.priceUsd}
          <span className={styles.priceUnit}>/month</span>
        </span>
        <span className={styles.priceCaption}>
          {tier.additionalStores.startsWith("$")
            ? `Plus ${tier.additionalStores.toLowerCase()}`
            : "One store"}
        </span>
      </div>

      <button
        type="button"
        className={`${styles.cta} ${featured ? styles.ctaPrimary : styles.ctaSecondary}`}
        onClick={onChoose}
        disabled={current}
      >
        {current ? "Current plan" : `Choose ${tier.name}`}
      </button>
      <p className={styles.ctaCaption}>You&rsquo;ll approve the charge with Shopify.</p>

      <p className={styles.carryForward}>{tier.carryForward}</p>
      <ul className={styles.rows}>
        {rows.map(([label, value]) => (
          <li key={label} className={styles.row}>
            <span className={styles.rowLabel}>{label}</span>
            <span className={styles.rowValue}>{value}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Comparison table
// ---------------------------------------------------------------------------

const COLUMNS = ["Free", "Starter", "Growth", "Scale"] as const;

function ComparisonTable({ featured }: { featured: PaidPlanId }) {
  // Column 0 is the feature label, so Free is 1 and the paid plans follow.
  const featuredColumn = PAID_PLANS.findIndex((p) => p.id === featured) + 2;

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Feature</th>
            {COLUMNS.map((name, index) => (
              <th
                key={name}
                scope="col"
                className={index + 1 === featuredColumn ? styles.featuredColumn : ""}
              >
                {name}
              </th>
            ))}
          </tr>
        </thead>
        {COMPARISON.map((group) => (
          <tbody key={group.heading}>
            <tr className={styles.groupHeading}>
              <th scope="colgroup" colSpan={5}>
                {group.heading}
              </th>
            </tr>
            {group.rows.map((row) => {
              const cells: (string | boolean)[] = row.values;
              return (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  {cells.map((value, index) => (
                    <td
                      key={`${row.label}-${index}`}
                      className={
                        index + 1 === featuredColumn ? styles.featuredColumn : ""
                      }
                    >
                      {isBooleanRow(row) ? (
                        <Tick included={value as boolean} />
                      ) : (
                        (value as string)
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/**
 * Included / not included.
 *
 * Both states draw a glyph. A table where included cells carry an icon and
 * excluded cells are blank reads as a gap in the data, and mixed
 * icon/no-icon within one group is a documented Built for Shopify rejection
 * reason.
 */
function Tick({ included }: { included: boolean }) {
  return (
    <>
      <svg
        className={`${styles.tick}${included ? "" : ` ${styles.tickExcluded}`}`}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {included ? <path d="M3 8.5 6.5 12 13 4.5" /> : <path d="M4 8h8" />}
      </svg>
      <span className={styles.visuallyHidden}>
        {included ? "Included" : "Not included"}
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
