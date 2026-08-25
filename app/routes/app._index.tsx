import { useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Link, useFetcher, useLoaderData, useRevalidator, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { tasks } from "@trigger.dev/sdk";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ensureShop, getPlanState } from "../services/billing.server";
import { loadLatestScanState, loadOverview } from "../services/dashboard.server";
import { rescueStuckFixGenerations } from "../services/scan-state.server";
import { AiScaleCard } from "../components/ai-scale-card";
import { ScoreBar, ScoreDial, scoreVerdict } from "../components/score";
import type { scanTask } from "../../trigger/scan";
import type { loader as progressLoader } from "./app.progress";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [plan, latest, overview] = await Promise.all([
    getPlanState(shop.id),
    loadLatestScanState(shop.id),
    loadOverview(shop.id),
    rescueStuckFixGenerations(shop.id),
  ]);

  return { plan, latest, overview };
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * Postgres unique-violation, as Prisma reports it.
 *
 * Matched on the code rather than the message: the message is localised and the
 * constraint name would tie this to one index.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  if (form.get("intent") !== "run-scan") {
    return { ok: false as const, error: "Unknown action." };
  }

  const plan = await getPlanState(shop.id);
  if (!plan.canRunScan) {
    return {
      ok: false as const,
      error:
        plan.blockedReason === "in-progress"
          ? "A scan is already running."
          : plan.blockedReason === "monthly-limit"
            ? `You have used all ${plan.entitlements.scans.limit} scans on your plan this month.`
            : "The free plan includes one scan. Choose a plan to scan again.",
    };
  }

  let scan;
  try {
    scan = await prisma.scan.create({
      data: { shopId: shop.id, status: "queued" },
    });
  } catch (error) {
    // A partial unique index allows one queued-or-running scan per shop, which
    // is what stops a double-clicked button from starting two runs of 30+
    // grounded LLM calls. The gate above catches almost every case; this
    // catches the one it cannot, where two requests pass it at the same moment.
    // Without this the merchant gets a raw 500 instead of the same message the
    // gate would have given them.
    if (isUniqueViolation(error)) {
      return { ok: false as const, error: "A scan is already running." };
    }
    throw error;
  }

  try {
    const handle = await tasks.trigger<typeof scanTask>("scan", {
      scanId: scan.id,
      shopDomain: session.shop,
    });
    await prisma.scan.update({
      where: { id: scan.id },
      data: { jobRunId: handle.id },
    });
  } catch (error) {
    // Most likely the queue is unreachable. Mark it failed so the free scan
    // credit is not consumed by an attempt that never ran.
    await prisma.scan.update({
      where: { id: scan.id },
      data: {
        status: "failed",
        phase: "finished",
        error: `Could not enqueue the scan job: ${String(error)}`,
      },
    });
    return {
      ok: false as const,
      error: "Could not start the scan. Check that the job queue is running.",
    };
  }

  // The id lets the client follow this specific scan: the progress feed may
  // still be reporting the previous one for a moment.
  return { ok: true as const, startedScanId: scan.id };
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type ProgressData = Awaited<ReturnType<typeof progressLoader>>;
type ProgressScan = NonNullable<ProgressData["scan"]>;

/**
 * The overview.
 *
 * Everything that used to live here — a 213-row fix table, a 39-row product
 * table printing 158 inline messages, a full simulations table — moved behind
 * /app/issues. What stays is the score, the three issue types worth the most
 * points, and the counts that lead into them.
 */
export default function Overview() {
  const { plan, latest, overview } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const progress = useFetcher<typeof progressLoader>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const live = progress.data?.scan ?? null;

  const startedScanId =
    fetcher.data && "startedScanId" in fetcher.data ? fetcher.data.startedScanId : null;

  const feedBusy =
    live !== null &&
    (live.status === "queued" || live.status === "running" || live.generatingCount > 0);
  // The feed can still describe the previous scan right after the action
  // returns; until it catches up we are knowingly waiting, not idle.
  const awaitingFeed = startedScanId !== null && live?.id !== startedScanId;
  const loaderBusy = latest?.status === "queued" || latest?.status === "running";
  const polling = feedBusy || awaitingFeed || loaderBusy;

  // The fetcher identity changes every render, so an effect depending on it
  // would rebuild the interval before it ever fires.
  const progressRef = useRef(progress);
  useEffect(() => {
    progressRef.current = progress;
  });

  useEffect(() => {
    if (!polling) return;
    const tick = () => {
      if (progressRef.current.state === "idle") {
        progressRef.current.load("/app/progress");
      }
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => clearInterval(timer);
  }, [polling]);

  const lastSettled = useRef<string | null>(null);
  useEffect(() => {
    if (!startedScanId) return;
    lastSettled.current = null;
    progressRef.current.load("/app/progress");
  }, [startedScanId]);

  // When the feed reports the work is over, pull the real data once.
  useEffect(() => {
    if (!live) return;
    const finished =
      (live.status === "done" || live.status === "failed") && live.generatingCount === 0;
    if (!finished) return;
    if (startedScanId !== null && live.id !== startedScanId) return;

    const key = `${live.id}:${live.status}`;
    if (lastSettled.current === key) return;
    lastSettled.current = key;
    revalidator.revalidate();
  }, [live, startedScanId, revalidator]);

  useEffect(() => {
    if (!fetcher.data || fetcher.data.ok) return;
    shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  const busy = fetcher.state !== "idle";
  const runScan = () => fetcher.submit({ intent: "run-scan" }, { method: "POST" });
  const scan = overview.scan;

  return (
    <s-page heading="Refera">
      {scan && !polling && plan.canRunScan && (
        <s-button
          slot="primary-action"
          onClick={runScan}
          {...(busy ? { disabled: true } : {})}
        >
          Scan again
        </s-button>
      )}

      <AiScaleCard
        appearances={overview.appearances}
        totalRuns={overview.totalRuns}
      />

      {polling && <ProgressState live={live} />}

      {!polling && latest?.status === "failed" && (
        <s-section>
          <s-banner tone="critical" heading="The scan failed">
            <s-stack direction="block" gap="base">
              <s-paragraph>{latest.error ?? "Unknown error."}</s-paragraph>
              {plan.canRunScan && (
                <s-box>
                  <s-button onClick={runScan} {...(busy ? { disabled: true } : {})}>
                    Try again
                  </s-button>
                </s-box>
              )}
            </s-stack>
          </s-banner>
        </s-section>
      )}

      {!scan && !polling && <EmptyState onRun={runScan} busy={busy} />}

      {scan && (
        <>
          {polling && (
            <s-section>
              <s-banner tone="info" heading="Showing your last results">
                <s-paragraph>
                  These are from your previous scan. They will be replaced when
                  the new one finishes.
                </s-paragraph>
              </s-banner>
            </s-section>
          )}

          <s-section heading="AI readiness">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="large-200" alignItems="center">
                <ScoreDial score={scan.score ?? 0} />
                <s-stack direction="block" gap="small-500">
                  <s-text type="strong">{scoreVerdict(scan.score ?? 0)}</s-text>
                  <s-paragraph color="subdued">
                    Half of this is how complete your product data is — the part
                    you can move today. The other half is how often your store
                    actually surfaced in AI answers.
                  </s-paragraph>
                  <s-text color="subdued">
                    {scan.productsScanned} products ·{" "}
                    {scan.finishedAt
                      ? new Date(scan.finishedAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })
                      : "—"}
                  </s-text>
                </s-stack>
              </s-stack>

              {scan.breakdown && (
                <s-grid gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))" gap="base">
                  <ScoreBar
                    label="Catalogue data"
                    score={scan.breakdown.dataScore}
                    caption={`Averaged across ${scan.productsScanned} products · ${scan.issuesFound} issues`}
                  />
                  <ScoreBar
                    label="AI visibility"
                    score={scan.breakdown.visibilityScore}
                    caption={
                      overview.appearances > 0
                        ? `Appeared in ${overview.appearances} of ${overview.totalRuns} answers`
                        : `Not mentioned in any of the ${overview.totalRuns} answers`
                    }
                  />
                </s-grid>
              )}
            </s-stack>
          </s-section>

          {overview.topIssues.length > 0 && (
            <s-section heading="Start here">
              <s-stack direction="block" gap="base">
                <s-text color="subdued">Ranked by what fixing it is worth</s-text>
                <s-stack direction="block" gap="none">
                  {overview.topIssues.map((group) => (
                    <Link
                      key={group.code}
                      to={`/app/issues/${group.slug}`}
                      style={{ textDecoration: "none", color: "inherit", display: "block" }}
                    >
                      <s-box padding="base" borderRadius="base">
                        <s-stack direction="inline" gap="base" alignItems="center">
                          <s-badge tone={group.severity === "high" ? "critical" : "warning"}>
                            +{group.scoreImpact} pts
                          </s-badge>
                          <s-stack direction="block" gap="small-500">
                            <s-text type="strong">
                              {group.productCount} product
                              {group.productCount === 1 ? "" : "s"} —{" "}
                              {group.label.toLowerCase()}
                            </s-text>
                            <s-text color="subdued">
                              {group.readyFixes} fix
                              {group.readyFixes === 1 ? "" : "es"} ready to review
                            </s-text>
                          </s-stack>
                          <s-text color="subdued">›</s-text>
                        </s-stack>
                      </s-box>
                    </Link>
                  ))}
                </s-stack>
                <s-box>
                  <s-button href="/app/issues" variant="tertiary">
                    See all {overview.totalIssueTypes} issue types
                  </s-button>
                </s-box>
              </s-stack>
            </s-section>
          )}

          {overview.competitors.length > 0 && (
            <s-section heading="Who AI recommends instead">
              <s-stack direction="block" gap="base">
                <s-text color="subdued">
                  Across {overview.totalRuns} answers to shopper questions in your
                  category, these brands were named — yours{" "}
                  {overview.appearances > 0
                    ? `${overview.appearances} time${overview.appearances === 1 ? "" : "s"}`
                    : "never"}
                  .
                </s-text>
                <s-stack direction="inline" gap="small-300">
                  {overview.competitors.slice(0, 8).map((name) => (
                    <s-badge key={name}>{name}</s-badge>
                  ))}
                  {overview.competitors.length > 8 && (
                    <s-text color="subdued">
                      +{overview.competitors.length - 8} more
                    </s-text>
                  )}
                </s-stack>
              </s-stack>
            </s-section>
          )}

          {!plan.canRunScan && !polling && (
            <s-section>
              <s-banner tone="info" heading="Scan again with a paid plan">
                <s-stack direction="block" gap="base">
                  <s-paragraph>
                    The free plan includes one scan. A paid plan keeps checking on
                    a schedule, so you can measure whether your fixes moved the
                    score.
                  </s-paragraph>
                  <s-box>
                    <s-button href="/app/plans">See plans</s-button>
                  </s-box>
                </s-stack>
              </s-banner>
            </s-section>
          )}
        </>
      )}
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function EmptyState({ onRun, busy }: { onRun: () => void; busy: boolean }) {
  return (
    <s-section heading="See how AI assistants see your store">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Refera reads your catalogue, asks the questions your buyers would ask
          ChatGPT, and measures whether your store shows up in the answers.
        </s-paragraph>
        <s-paragraph color="subdued">
          The scan reads up to 50 products and takes a couple of minutes.
          Nothing in your store changes without your approval.
        </s-paragraph>
        <s-box>
          <s-button variant="primary" onClick={onRun} {...(busy ? { disabled: true } : {})}>
            Run first scan
          </s-button>
        </s-box>
      </s-stack>
    </s-section>
  );
}

/** The phases a scan moves through, with their share of the bar. */
const PHASES = [
  { key: "catalogue", label: "Reading your catalogue", weight: 15 },
  { key: "analysing", label: "Checking each product", weight: 10 },
  { key: "questions", label: "Working out what your buyers ask", weight: 10 },
  { key: "simulating", label: "Asking AI assistants those questions", weight: 45 },
  { key: "fixing", label: "Writing fixes", weight: 20 },
] as const;

/**
 * Live progress, driven by the lightweight progress feed.
 *
 * Phase-weighted rather than guessed from row counts: the scan reports where
 * it is, and the simulation phase — by far the longest — fills in as answers
 * come back.
 */
function ProgressState({ live }: { live: ProgressScan | null }) {
  const phase = live?.phase ?? "queued";
  const sims = live?.simulationCount ?? 0;
  const fixes = live?.fixCount ?? 0;

  const currentIndex = PHASES.findIndex((p) => p.key === phase);
  let percent = 0;
  PHASES.forEach((p, index) => {
    if (currentIndex < 0) return;
    if (index < currentIndex) {
      percent += p.weight;
    } else if (index === currentIndex) {
      const fraction =
        p.key === "simulating"
          ? Math.min(1, sims / 10)
          : p.key === "fixing"
            ? Math.min(1, fixes / 20)
            : 0.5;
      percent += p.weight * fraction;
    }
  });
  percent = Math.max(2, Math.min(99, Math.round(percent)));

  const heading =
    phase === "queued"
      ? "Starting your scan…"
      : (PHASES.find((p) => p.key === phase)?.label ?? "Finishing up…");

  const detail =
    phase === "simulating"
      ? `${sims} of 10 questions answered`
      : phase === "fixing"
        ? `${fixes} fixes written so far`
        : live && live.productsScanned > 0
          ? `${live.productsScanned} products read`
          : null;

  return (
    <s-section heading="Scanning your store">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-spinner accessibilityLabel="Scan in progress" />
          <s-text type="strong">{heading}</s-text>
        </s-stack>

        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{
            height: 6,
            borderRadius: 3,
            background: "var(--s-color-border, #e3e3e3)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${percent}%`,
              height: "100%",
              borderRadius: 3,
              background: "var(--s-color-text, #303030)",
              transition: "width 0.8s ease",
            }}
          />
        </div>

        <s-text color="subdued">
          {percent}%{detail ? ` · ${detail}` : ""}
        </s-text>

        <s-unordered-list>
          {PHASES.map((p, index) => (
            <s-list-item key={p.key}>
              <s-text color={currentIndex >= index ? undefined : "subdued"}>
                {currentIndex > index ? "✓ " : currentIndex === index ? "→ " : "· "}
                {p.label}
              </s-text>
            </s-list-item>
          ))}
        </s-unordered-list>

        <s-text color="subdued">
          You can leave this page — the scan keeps running.
        </s-text>
      </s-stack>
    </s-section>
  );
}

// ---------------------------------------------------------------------------

export function ErrorBoundary() {
  // Pass the real error through: replacing it with a label hides the actual
  // cause (a Prisma validation error once surfaced here as a bare string).
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
