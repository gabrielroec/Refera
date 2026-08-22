import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { tasks } from "@trigger.dev/sdk";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ensureShop, getPlanState } from "../services/billing.server";
import { applyFix } from "../services/fixer.server";
import type { scanTask } from "../../trigger/scan";
import type {
  DescriptionPayload,
  Issue,
  MetafieldPayload,
  ScoreBreakdown,
  TaxonomyPayload,
} from "../types";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const plan = await getPlanState(shop.id);

  const scan = await prisma.scan.findFirst({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    include: {
      simulations: { orderBy: { createdAt: "asc" } },
      products: {
        orderBy: { createdAt: "asc" },
        include: {
          fixes: { orderBy: { createdAt: "asc" } },
        },
      },
    },
  });

  return { shopDomain: session.shop, plan, scan };
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "run-scan") {
    const plan = await getPlanState(shop.id);
    if (!plan.canRunScan) {
      return {
        ok: false as const,
        error: plan.scanInProgress
          ? "A scan is already in progress."
          : "The free plan includes one scan. Upgrade to Pro to re-scan.",
      };
    }

    const scan = await prisma.scan.create({
      data: { shopId: shop.id, status: "queued" },
    });

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
      // Most likely TRIGGER_SECRET_KEY missing or the queue being down. Mark
      // the scan failed so the free-scan credit is not consumed.
      await prisma.scan.update({
        where: { id: scan.id },
        data: {
          status: "failed",
          error: `Could not enqueue the scan job: ${String(error)}`,
        },
      });
      return {
        ok: false as const,
        error: "Could not start the scan. Check the job queue configuration.",
      };
    }

    return { ok: true as const };
  }

  if (intent === "reject-fix") {
    const fixId = String(form.get("fixId") ?? "");
    // Guard the shop boundary: a fix can only be rejected by the shop it
    // belongs to.
    const fix = await prisma.fix.findFirst({
      where: {
        id: fixId,
        productSnapshot: { scan: { shopId: shop.id } },
        status: "suggested",
      },
    });
    if (!fix) return { ok: false as const, error: "Fix not found." };

    await prisma.fix.update({
      where: { id: fix.id },
      data: { status: "rejected" },
    });
    return { ok: true as const };
  }

  if (intent === "apply-fix") {
    const plan = await getPlanState(shop.id);
    if (!plan.canApplyFixes) {
      return {
        ok: false as const,
        error: "Applying fixes is a Pro feature.",
      };
    }

    const fixId = String(form.get("fixId") ?? "");
    const fix = await prisma.fix.findFirst({
      where: {
        id: fixId,
        productSnapshot: { scan: { shopId: shop.id } },
        status: "suggested",
      },
      include: { productSnapshot: { select: { productId: true } } },
    });
    if (!fix) return { ok: false as const, error: "Fix not found." };

    // Explicit merchant approval is this click; record it before writing.
    await prisma.fix.update({
      where: { id: fix.id },
      data: { status: "approved" },
    });

    const result = await applyFix(
      admin,
      fix.productSnapshot.productId,
      fix.type,
      fix.after,
    );

    await prisma.fix.update({
      where: { id: fix.id },
      data: result.ok
        ? { status: "applied", appliedAt: new Date(), error: null }
        : { status: "approved", error: result.error },
    });

    return result.ok
      ? { ok: true as const }
      : { ok: false as const, error: `Shopify rejected the change: ${result.error}` };
  }

  return { ok: false as const, error: "Unknown intent." };
};

// ---------------------------------------------------------------------------
// Types shared with the component (loader serialisation shape)
// ---------------------------------------------------------------------------

type LoaderData = Awaited<ReturnType<typeof loader>>;
type ScanData = NonNullable<LoaderData["scan"]>;
type FixRow = ScanData["products"][number]["fixes"][number];
type ProductRow = ScanData["products"][number];

// ---------------------------------------------------------------------------
// Score dial (Polaris has no gauge; small inline SVG)
// ---------------------------------------------------------------------------

function scoreColor(score: number): string {
  if (score < 40) return "#d82c0d";
  if (score < 70) return "#b98900";
  return "#29845a";
}

function ScoreDial({ score }: { score: number }) {
  const radius = 64;
  const circumference = 2 * Math.PI * radius;
  const filled = (score / 100) * circumference;

  return (
    <svg width="160" height="160" viewBox="0 0 160 160" role="img" aria-label={`AI readiness score: ${score} out of 100`}>
      <circle cx="80" cy="80" r={radius} fill="none" stroke="#e3e3e3" strokeWidth="12" />
      <circle
        cx="80"
        cy="80"
        r={radius}
        fill="none"
        stroke={scoreColor(score)}
        strokeWidth="12"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference - filled}`}
        transform="rotate(-90 80 80)"
      />
      <text x="80" y="76" textAnchor="middle" fontSize="36" fontWeight="700" fill="currentColor">
        {score}
      </text>
      <text x="80" y="100" textAnchor="middle" fontSize="12" fill="#616161">
        / 100
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Fix diff rendering
// ---------------------------------------------------------------------------

/** Plain-text view of a payload; HTML is shown as text, never injected. */
function payloadText(type: FixRow["type"], payload: unknown): string {
  if (type === "description") {
    const p = payload as DescriptionPayload;
    return p.descriptionHtml
      ? p.descriptionHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      : "(empty)";
  }
  if (type === "metafield") {
    const p = payload as MetafieldPayload;
    return p.value ? `${p.namespace}.${p.key} = ${p.value}` : "(not set)";
  }
  const p = payload as TaxonomyPayload;
  return p.category ?? "(no category)";
}

const FIX_TYPE_LABEL: Record<FixRow["type"], string> = {
  description: "Description",
  metafield: "Metafield",
  taxonomy: "Category",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const { plan, scan } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const [selectedFix, setSelectedFix] = useState<{
    fix: FixRow;
    product: ProductRow;
  } | null>(null);
  const modalRef = useRef<HTMLElement & { showOverlay: () => void; hideOverlay: () => void }>(null);

  const running = scan?.status === "queued" || scan?.status === "running";

  // Progress polling: revalidate every 4s while a scan is in flight.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(timer);
  }, [running, revalidator]);

  // Surface action results as toasts.
  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show("Done");
    } else {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  // Close the modal after a fix action completes. The revalidated loader data
  // removes the fix from the list; clearing the selection happens on the
  // modal's own hide callback (see FixModal onHide).
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && selectedFix) {
      modalRef.current?.hideOverlay();
    }
  }, [fetcher.state, fetcher.data, selectedFix]);

  const busy = fetcher.state !== "idle";
  const runScan = () => fetcher.submit({ intent: "run-scan" }, { method: "POST" });

  const openFix = (fix: FixRow, product: ProductRow) => {
    setSelectedFix({ fix, product });
    // Defer until the modal content re-renders.
    requestAnimationFrame(() => modalRef.current?.showOverlay());
  };

  return (
    <s-page heading="Refera — AI Visibility">
      {scan?.status === "done" && (
        <s-button
          slot="primary-action"
          onClick={runScan}
          {...(busy || !plan.canRunScan ? { disabled: true } : {})}
        >
          {plan.canRunScan ? "Re-scan" : "Re-scan (Pro)"}
        </s-button>
      )}

      {!scan && <EmptyState onRun={runScan} busy={busy} />}
      {running && <ProgressState scan={scan} />}
      {scan?.status === "failed" && (
        <FailedState error={scan.error} onRetry={runScan} busy={busy} canRun={plan.canRunScan} />
      )}
      {scan?.status === "done" && (
        <Results scan={scan} onOpenFix={openFix} planIsFree={plan.plan === "free"} />
      )}

      <FixModal
        modalRef={modalRef}
        selected={selectedFix}
        canApply={plan.canApplyFixes}
        busy={busy}
        onApply={(fixId) => fetcher.submit({ intent: "apply-fix", fixId }, { method: "POST" })}
        onReject={(fixId) => fetcher.submit({ intent: "reject-fix", fixId }, { method: "POST" })}
        onClosed={() => setSelectedFix(null)}
      />
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
          Refera scans your catalogue, asks ChatGPT-style shopping questions for
          your niche, and measures whether your store shows up in the answers —
          then suggests concrete fixes.
        </s-paragraph>
        <s-paragraph>
          The scan reads up to 50 products and takes a few minutes. Nothing is
          changed in your store without your approval.
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

function ProgressState({ scan }: { scan: ScanData }) {
  const steps: Array<[string, boolean]> = [
    ["Reading your catalogue", scan.productsScanned > 0],
    ["Detecting issues", scan.issuesFound > 0 || scan.simulations.length > 0],
    [
      `Simulating AI shopping questions (${scan.simulations.length}/10)`,
      scan.simulations.length >= 10,
    ],
    ["Scoring and generating fixes", scan.status === "done"],
  ];

  return (
    <s-section heading="Scanning your store…">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small">
          <s-spinner accessibilityLabel="Scan in progress" />
          <s-text>
            This takes a few minutes. You can leave this page — the scan keeps
            running.
          </s-text>
        </s-stack>
        <s-unordered-list>
          {steps.map(([label, done]) => (
            <s-list-item key={label}>
              {done ? "✓ " : "· "}
              {label}
            </s-list-item>
          ))}
        </s-unordered-list>
      </s-stack>
    </s-section>
  );
}

function FailedState({
  error,
  onRetry,
  busy,
  canRun,
}: {
  error: string | null;
  onRetry: () => void;
  busy: boolean;
  canRun: boolean;
}) {
  return (
    <s-section>
      <s-banner tone="critical" heading="The scan failed">
        <s-stack direction="block" gap="base">
          <s-paragraph>{error ?? "Unknown error."}</s-paragraph>
          {canRun && (
            <s-box>
              <s-button onClick={onRetry} {...(busy ? { disabled: true } : {})}>
                Try again
              </s-button>
            </s-box>
          )}
        </s-stack>
      </s-banner>
    </s-section>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function Results({
  scan,
  onOpenFix,
  planIsFree,
}: {
  scan: ScanData;
  onOpenFix: (fix: FixRow, product: ProductRow) => void;
  planIsFree: boolean;
}) {
  const breakdown = scan.scoreBreakdown as unknown as ScoreBreakdown | null;

  const totalRuns = scan.simulations.reduce((sum, s) => sum + s.runCount, 0);
  const appearances = scan.simulations.reduce((sum, s) => sum + s.appearanceCount, 0);

  const suggestedFixes = useMemo(
    () =>
      scan.products.flatMap((product) =>
        product.fixes
          .filter((fix) => fix.status === "suggested" || fix.status === "approved")
          .map((fix) => ({ fix, product })),
      ),
    [scan.products],
  );
  const appliedCount = scan.products.reduce(
    (sum, product) => sum + product.fixes.filter((f) => f.status === "applied").length,
    0,
  );

  return (
    <>
      <s-section heading="AI readiness">
        <s-stack direction="inline" gap="large-200" alignItems="center">
          <ScoreDial score={scan.score ?? 0} />
          <s-stack direction="block" gap="small">
            {breakdown && (
              <>
                <s-text>
                  Catalogue data: <s-text type="strong">{breakdown.dataScore}/100</s-text>
                </s-text>
                <s-text>
                  AI visibility: <s-text type="strong">{breakdown.visibilityScore}/100</s-text>
                </s-text>
              </>
            )}
            <s-text color="subdued">
              Scanned{" "}
              {scan.finishedAt ? new Date(scan.finishedAt).toLocaleString("en-US") : "—"}
            </s-text>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
          <StatCard label="Products scanned" value={String(scan.productsScanned)} />
          <StatCard label="Issues found" value={String(scan.issuesFound)} />
          <StatCard label="AI appearances" value={`${appearances}/${totalRuns} runs`} />
          <StatCard
            label="Fixes available"
            value={String(suggestedFixes.length)}
            hint={appliedCount > 0 ? `${appliedCount} applied` : undefined}
          />
        </s-grid>
      </s-section>

      <s-section heading="AI shopping simulations">
        <s-paragraph color="subdued">
          Each question was asked {scan.simulations[0]?.runCount ?? 3} times to a
          web-grounded AI assistant, without mentioning your store.
        </s-paragraph>
        <s-table>
          <s-table-header-row>
            <s-table-header>Question</s-table-header>
            <s-table-header>Your store</s-table-header>
            <s-table-header>Competitors cited</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {scan.simulations.map((sim) => {
              const appeared = sim.appearanceCount > 0;
              return (
                <s-table-row key={sim.id}>
                  <s-table-cell>{sim.question}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={appeared ? "success" : "critical"}>
                      {appeared
                        ? `Appeared ${sim.appearanceCount}/${sim.runCount}`
                        : "Not mentioned"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {sim.competitors.length > 0 ? sim.competitors.slice(0, 4).join(", ") : "—"}
                    {sim.competitors.length > 4 ? ` +${sim.competitors.length - 4}` : ""}
                  </s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section heading="Suggested fixes">
        {planIsFree && suggestedFixes.length > 0 && (
          <s-banner tone="info" heading="Preview the fixes for free">
            <s-paragraph>
              Review every suggestion and its before/after diff. Applying fixes
              to your store is part of the Pro plan.
            </s-paragraph>
          </s-banner>
        )}

        {suggestedFixes.length === 0 ? (
          <s-paragraph color="subdued">
            {appliedCount > 0
              ? "All suggested fixes have been applied. Run a re-scan to measure the impact."
              : "No fixes to suggest — your catalogue data looks complete."}
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Fix</s-table-header>
              <s-table-header>Why</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {suggestedFixes.map(({ fix, product }) => (
                <s-table-row key={fix.id}>
                  <s-table-cell>{product.title}</s-table-cell>
                  <s-table-cell>
                    <s-badge>{FIX_TYPE_LABEL[fix.type]}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{fix.rationale ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <s-button variant="tertiary" onClick={() => onOpenFix(fix, product)}>
                      Review
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <IssuesSection products={scan.products} />
    </>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {hint && <s-text color="subdued">{hint}</s-text>}
      </s-stack>
    </s-box>
  );
}

/** Per-product diagnosis, collapsed to products that actually have issues. */
function IssuesSection({ products }: { products: ProductRow[] }) {
  const withIssues = products.filter(
    (product) => (product.issues as unknown as Issue[]).length > 0,
  );
  if (withIssues.length === 0) return null;

  return (
    <s-section heading={`Diagnosis by product (${withIssues.length})`}>
      <s-table>
        <s-table-header-row>
          <s-table-header>Product</s-table-header>
          <s-table-header>Issues</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {withIssues.map((product) => {
            const issues = product.issues as unknown as Issue[];
            return (
              <s-table-row key={product.id}>
                <s-table-cell>{product.title}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="block" gap="small-300">
                    {issues.map((issue) => (
                      <s-stack key={issue.code} direction="inline" gap="small-300">
                        <s-badge
                          tone={
                            issue.severity === "high"
                              ? "critical"
                              : issue.severity === "medium"
                                ? "warning"
                                : "neutral"
                          }
                        >
                          {issue.severity}
                        </s-badge>
                        <s-text>{issue.message}</s-text>
                      </s-stack>
                    ))}
                  </s-stack>
                </s-table-cell>
              </s-table-row>
            );
          })}
        </s-table-body>
      </s-table>
    </s-section>
  );
}

// ---------------------------------------------------------------------------
// Fix modal
// ---------------------------------------------------------------------------

function FixModal({
  modalRef,
  selected,
  canApply,
  busy,
  onApply,
  onReject,
  onClosed,
}: {
  modalRef: React.RefObject<
    (HTMLElement & { showOverlay: () => void; hideOverlay: () => void }) | null
  >;
  selected: { fix: FixRow; product: ProductRow } | null;
  canApply: boolean;
  busy: boolean;
  onApply: (fixId: string) => void;
  onReject: (fixId: string) => void;
  onClosed: () => void;
}) {
  const fix = selected?.fix;

  return (
    <s-modal
      ref={modalRef as React.Ref<never>}
      heading={fix ? `${FIX_TYPE_LABEL[fix.type]} — ${selected!.product.title}` : "Fix"}
      size="large"
      onAfterHide={onClosed}
    >
      {fix && (
        <s-stack direction="block" gap="base">
          {fix.rationale && <s-paragraph color="subdued">{fix.rationale}</s-paragraph>}

          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="small-300">
              <s-text type="strong" color="subdued">
                Before
              </s-text>
              <s-text>{payloadText(fix.type, fix.before)}</s-text>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small-300">
              <s-text type="strong">After</s-text>
              <s-text>{payloadText(fix.type, fix.after)}</s-text>
            </s-stack>
          </s-box>

          {fix.error && (
            <s-banner tone="critical" heading="Last apply attempt failed">
              <s-paragraph>{fix.error}</s-paragraph>
            </s-banner>
          )}

          {!canApply && (
            <s-banner tone="info" heading="Applying is a Pro feature">
              <s-paragraph>
                Upgrade to Pro to write this change to your store with one
                click. Your diagnosis and preview stay free.
              </s-paragraph>
            </s-banner>
          )}
        </s-stack>
      )}

      {fix && (
        <s-button
          slot="secondary-actions"
          onClick={() => onReject(fix.id)}
          {...(busy ? { disabled: true } : {})}
        >
          Reject
        </s-button>
      )}
      {fix && canApply && (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => onApply(fix.id)}
          {...(busy ? { disabled: true } : {})}
        >
          Approve &amp; apply
        </s-button>
      )}
    </s-modal>
  );
}

// ---------------------------------------------------------------------------

export function ErrorBoundary() {
  return boundary.error(new Error("Dashboard error"));
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
