import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { Prisma } from "@prisma/client";
import { tasks } from "@trigger.dev/sdk";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ensureShop, getPlanState } from "../services/billing.server";
import { loadReviewQueue } from "../services/dashboard.server";
import { ApplyProgress } from "../components/apply-progress";
import { IssueNav } from "../components/issue-nav";
import { useIssuesContext } from "./app.issues";
import type { applyFixesTask } from "../../trigger/apply-fixes";
import { ISSUE_DEFINITIONS, issueCodeFromSlug } from "../lib/issues";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const code = issueCodeFromSlug(params.slug ?? "");
  if (!code) throw new Response("Unknown issue", { status: 404 });

  const shop = await ensureShop(session.shop);
  const [plan, queue] = await Promise.all([
    getPlanState(shop.id),
    loadReviewQueue(shop.id, code),
  ]);

  return { definition: ISSUE_DEFINITIONS[code], slug: params.slug!, plan, ...queue };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const code = issueCodeFromSlug(params.slug ?? "");
  if (!code) return { ok: false as const, error: "Unknown issue." };

  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  /** Fixes this shop may still act on, for this issue type. */
  const actionable: Prisma.FixWhereInput = {
    productSnapshot: { scan: { shopId: shop.id } },
    issueCode: code,
    status: { in: ["suggested", "approved"] },
  };

  /** Ids the card list submits, one or many. */
  const requestedIds = String(form.get("fixIds") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (intent === "restore") {
    if (requestedIds.length === 0) {
      return { ok: false as const, error: "Nothing selected." };
    }
    // Only a dismissal can be undone; an applied fix already changed the
    // store, and putting it "back in the queue" would misrepresent that.
    const { count } = await prisma.fix.updateMany({
      where: {
        productSnapshot: { scan: { shopId: shop.id } },
        issueCode: code,
        id: { in: requestedIds },
        status: "rejected",
      },
      data: { status: "suggested" },
    });
    return count > 0
      ? { ok: true as const, message: "Back in the list" }
      : { ok: false as const, error: "That suggestion is no longer available." };
  }

  if (intent === "reject") {
    if (requestedIds.length === 0) {
      return { ok: false as const, error: "Nothing selected." };
    }
    const { count } = await prisma.fix.updateMany({
      where: { ...actionable, id: { in: requestedIds } },
      data: { status: "rejected" },
    });
    return count > 0
      ? {
          ok: true as const,
          message: count === 1 ? "Suggestion dismissed" : `${count} dismissed`,
        }
      : { ok: false as const, error: "Those suggestions are no longer available." };
  }

  if (intent === "apply" || intent === "apply-all") {
    const plan = await getPlanState(shop.id);
    if (!plan.canApplyFixes) {
      return {
        ok: false as const,
        error: "Applying fixes to your store is part of a paid plan.",
      };
    }
    if (intent === "apply" && requestedIds.length === 0) {
      return { ok: false as const, error: "Nothing selected." };
    }

    const fixes = await prisma.fix.findMany({
      where:
        intent === "apply"
          ? { ...actionable, id: { in: requestedIds } }
          : actionable,
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (fixes.length === 0) {
      return { ok: false as const, error: "Nothing left to apply." };
    }

    const fixIds = fixes.map((fix) => fix.id);

    // Marked approved up front so the progress feed can count what is still
    // outstanding, and so a second click cannot queue the same fix twice.
    await prisma.fix.updateMany({
      where: { id: { in: fixIds } },
      data: { status: "approved", error: null },
    });

    try {
      await tasks.trigger<typeof applyFixesTask>("apply-fixes", {
        fixIds,
        shopDomain: session.shop,
      });
    } catch (error) {
      await prisma.fix.updateMany({
        where: { id: { in: fixIds }, status: "approved", appliedAt: null },
        data: { status: "suggested" },
      });
      return {
        ok: false as const,
        error: `Could not start applying: ${String(error)}`,
      };
    }

    // The ids let the client follow this run and show real progress.
    return { ok: true as const, applyingIds: fixIds };
  }

  return { ok: false as const, error: "Unknown action." };
};

type LoaderData = Awaited<ReturnType<typeof loader>>;

/** How many cards render before "show more". */
const PAGE_SIZE = 12;

/**
 * Every suggestion for one issue type, as cards.
 *
 * Shown all at once rather than one at a time: a merchant deciding on 22
 * product descriptions needs to see the shape of what is being proposed, pick
 * where to start, and act on several without stepping through a queue. Long
 * lists page in on request so the first paint stays small.
 */
export default function IssueReview() {
  const {
    definition,
    slug,
    plan,
    pending,
    applied,
    dismissed,
    awaitingGeneration,
    placement,
  } = useLoaderData<typeof loader>();
  const { siblings } = useIssuesContext();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState(PAGE_SIZE);

  const total = pending.length + applied.length + dismissed.length;

  /**
   * The apply run whose progress modal is on screen.
   *
   * Derived from the action result rather than copied into state by an effect:
   * the only thing worth remembering is which run the merchant already closed.
   */
  const startedRun =
    fetcher.data?.ok && "applyingIds" in fetcher.data && Array.isArray(fetcher.data.applyingIds)
      ? fetcher.data.applyingIds
      : null;
  const [closedRun, setClosedRun] = useState<string | null>(null);
  const activeRun =
    startedRun && closedRun !== startedRun.join(",") ? startedRun : null;

  // Toast the outcomes that finish immediately (dismiss, restore). Applying is
  // a job, so it reports through the modal instead.
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data === handled.current) return;
    handled.current = fetcher.data;
    const result = fetcher.data;
    if (!result.ok) {
      shopify.toast.show(result.error, { isError: true });
    } else if ("applyingIds" in result) {
      // Applying is a job — the modal reports it, so there is no toast here.
    } else if ("message" in result && typeof result.message === "string") {
      shopify.toast.show(result.message);
      revalidator.revalidate();
    }
  }, [fetcher.state, fetcher.data, shopify, revalidator]);

  const busy = fetcher.state !== "idle";

  const act = (intent: string, fixIds?: string[]) => {
    const body: Record<string, string> = { intent };
    if (fixIds?.length) body.fixIds = fixIds.join(",");
    // Cleared here rather than in an effect on the response: the selection
    // belongs to this submission, and clearing it from an effect is what
    // triggers a cascading render.
    setSelected(new Set());
    fetcher.submit(body, { method: "POST" });
  };

  const toggle = (fixId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fixId)) next.delete(fixId);
      else next.add(fixId);
      return next;
    });

  const allVisibleSelected =
    pending.length > 0 && pending.slice(0, visible).every((p) => selected.has(p.fixId));

  return (
    <s-page heading={definition.label}>
      {/*
        First child on purpose: applying changes `pending`, which flips a
        ternary further down and remounts everything after it. Keeping the
        panel above that boundary preserves its instance across a run.
      */}
      {activeRun && (
        <ApplyProgress
          key="apply-progress"
          fixIds={activeRun}
          onDismiss={() => setClosedRun(activeRun.join(","))}
          onFinished={() => revalidator.revalidate()}
        />
      )}

      <s-button slot="breadcrumb-actions" href="/app/issues" variant="tertiary">
        Issues
      </s-button>
      {plan.canApplyFixes && pending.length > 0 && (
        <s-button
          slot="primary-action"
          onClick={() => act("apply-all")}
          {...(busy ? { disabled: true } : {})}
        >
          Apply all {pending.length}
        </s-button>
      )}

      <s-section>
        <IssueNav siblings={siblings} current={slug} />
      </s-section>

      <s-section>
        <s-stack direction="block" gap="small">
          {placement && (
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-badge tone="critical">+{placement.scoreImpact} pts</s-badge>
              <s-text color="subdued">
                Issue {placement.position} of {placement.total} ·{" "}
                {placement.productCount} product
                {placement.productCount === 1 ? "" : "s"} affected
              </s-text>
            </s-stack>
          )}
          <s-paragraph color="subdued">{definition.why}</s-paragraph>
          {(applied.length > 0 || dismissed.length > 0) && (
            <s-text color="subdued">
              {applied.length} applied · {dismissed.length} dismissed ·{" "}
              {pending.length} left
            </s-text>
          )}
        </s-stack>
      </s-section>

      {pending.length === 0 ? (
        <s-section heading={total > 0 ? "All reviewed" : undefined}>
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {total > 0
                ? "Every suggestion for this issue has been reviewed."
                : "No suggestions for this issue yet."}
            </s-paragraph>
            <s-stack direction="inline" gap="small-300">
              {placement?.next ? (
                <s-button variant="primary" href={`/app/issues/${placement.next.slug}`}>
                  Next: {placement.next.label} (+{placement.next.scoreImpact} pts)
                </s-button>
              ) : (
                <s-button variant="primary" href="/app">
                  Back to overview
                </s-button>
              )}
              <s-button href="/app/issues" variant="tertiary">
                All issues
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      ) : (
        <>
          {plan.canApplyFixes && (
            <s-section>
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-checkbox
                  label="Select all shown"
                  checked={allVisibleSelected}
                  onChange={() =>
                    setSelected(
                      allVisibleSelected
                        ? new Set()
                        : new Set(pending.slice(0, visible).map((p) => p.fixId)),
                    )
                  }
                />
                {selected.size > 0 && (
                  <>
                    <s-button
                      variant="primary"
                      onClick={() => act("apply", [...selected])}
                      {...(busy ? { disabled: true } : {})}
                    >
                      Apply {selected.size} selected
                    </s-button>
                    <s-button
                      onClick={() => act("reject", [...selected])}
                      {...(busy ? { disabled: true } : {})}
                    >
                      Dismiss {selected.size}
                    </s-button>
                  </>
                )}
              </s-stack>
            </s-section>
          )}

          <s-grid
            gridTemplateColumns="repeat(auto-fit, minmax(340px, 1fr))"
            gap="base"
          >
            {pending.slice(0, visible).map((item) => (
              <SuggestionCard
                key={item.fixId}
                item={item}
                canApply={plan.canApplyFixes}
                selected={selected.has(item.fixId)}
                onToggle={() => toggle(item.fixId)}
                busy={busy}
                onApply={() => act("apply", [item.fixId])}
                onReject={() => act("reject", [item.fixId])}
              />
            ))}
          </s-grid>

          {pending.length > visible && (
            <s-section>
              <s-button
                onClick={() => setVisible((v) => v + PAGE_SIZE)}
                variant="tertiary"
              >
                Show {Math.min(PAGE_SIZE, pending.length - visible)} more of{" "}
                {pending.length - visible}
              </s-button>
            </s-section>
          )}
        </>
      )}

      {applied.length > 0 && (
        <DecidedSection
          heading={`Applied to your store (${applied.length})`}
          items={applied}
          tone="success"
          busy={busy}
          onRestore={undefined}
        />
      )}

      {dismissed.length > 0 && (
        <DecidedSection
          heading={`Dismissed (${dismissed.length})`}
          items={dismissed}
          tone="neutral"
          busy={busy}
          onRestore={(fixId) => act("restore", [fixId])}
        />
      )}

      {awaitingGeneration.length > 0 && (
        <s-section heading={`${awaitingGeneration.length} more waiting`}>
          <s-paragraph color="subdued">
            These products have the issue but no suggestion yet. The next scan
            generates them.
          </s-paragraph>
        </s-section>
      )}

      {!plan.canApplyFixes && (
        <s-section>
          <s-banner tone="info" heading="Applying is part of a paid plan">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Reviewing every suggestion and its diff is free. Writing them
                back to your store is part of a paid plan.
              </s-paragraph>
              <s-box>
                <s-button href="/app/plans">See plans</s-button>
              </s-box>
            </s-stack>
          </s-banner>
        </s-section>
      )}
    </s-page>
  );
}

/**
 * What has already been decided, kept on the page.
 *
 * A suggestion that simply vanishes when acted on gives no sense of progress
 * and no way to check what was written to the store. Dismissed items can be
 * put back; applied ones stay as a record.
 */
function DecidedSection({
  heading,
  items,
  tone,
  busy,
  onRestore,
}: {
  heading: string;
  items: LoaderData["applied"];
  tone: "success" | "neutral";
  busy: boolean;
  onRestore?: (fixId: string) => void;
}) {
  return (
    <s-section heading={heading}>
      <s-stack direction="block" gap="small">
        {items.map((item) => (
          <s-box key={item.fixId} padding="base" borderRadius="base" background="subdued">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <Thumbnail url={item.imageUrl} title={item.productTitle} />
              <s-stack direction="block" gap="small-500">
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-badge tone={tone === "success" ? "success" : undefined}>
                    {tone === "success" ? "Applied" : "Dismissed"}
                  </s-badge>
                  <s-text type="strong">{item.productTitle}</s-text>
                </s-stack>
                <s-text color="subdued">{item.summary}</s-text>
                {item.appliedAt && (
                  <s-text color="subdued">
                    {new Date(item.appliedAt).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </s-text>
                )}
                {item.error && (
                  <s-text color="subdued">Last error: {item.error}</s-text>
                )}
              </s-stack>
              {onRestore && (
                <s-button
                  variant="tertiary"
                  onClick={() => onRestore(item.fixId)}
                  {...(busy ? { disabled: true } : {})}
                >
                  Put back
                </s-button>
              )}
            </s-stack>
          </s-box>
        ))}
      </s-stack>
    </s-section>
  );
}

/**
 * Product thumbnail, with a placeholder that occupies the same box.
 *
 * The placeholder matters: Built for Shopify rejects lists where some items
 * carry an image and others carry nothing, and snapshots taken before
 * thumbnails were captured have no URL at all.
 */
function Thumbnail({ url, title }: { url: string | null; title: string }) {
  const box = {
    width: 40,
    height: 40,
    flex: "0 0 auto",
    borderRadius: "var(--s-border-radius-base, 8px)",
    overflow: "hidden",
  } as const;

  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={40}
        height={40}
        loading="lazy"
        style={{ ...box, objectFit: "cover" }}
      />
    );
  }

  return (
    <div
      style={{
        ...box,
        background: "var(--s-color-bg-fill-secondary, #f1f1f1)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      role="img"
      aria-label={`${title} has no image`}
    >
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5v-11Zm1.5 0v8.19l2.72-2.72a.75.75 0 0 1 1.06 0l1.97 1.97 2.47-2.47a.75.75 0 0 1 1.06 0l1.72 1.72V4.5h-11Z"
          fill="var(--s-color-text-secondary, #8a8a8a)"
        />
        <circle cx="7.5" cy="7.5" r="1.25" fill="var(--s-color-text-secondary, #8a8a8a)" />
      </svg>
    </div>
  );
}

/**
 * One suggestion. The preview is generated server-side and already plain text,
 * so the card renders without fetching anything.
 */
function SuggestionCard({
  item,
  canApply,
  selected,
  onToggle,
  busy,
  onApply,
  onReject,
}: {
  item: LoaderData["pending"][number];
  canApply: boolean;
  selected: boolean;
  onToggle: () => void;
  busy: boolean;
  onApply: () => void;
  onReject: () => void;
}) {
  return (
    <s-section>
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          {canApply && (
            <s-checkbox
              accessibilityLabel={`Select ${item.productTitle}`}
              checked={selected}
              onChange={onToggle}
            />
          )}
          <Thumbnail url={item.imageUrl} title={item.productTitle} />
          <s-text type="strong">{item.productTitle}</s-text>
        </s-stack>

        {item.rationale && (
          <s-text color="subdued">{item.rationale}</s-text>
        )}

        <s-box padding="base" borderRadius="base" background="subdued">
          <s-stack direction="block" gap="small-500">
            <s-text color="subdued">Now</s-text>
            <s-text color="subdued">{item.before}</s-text>
          </s-stack>
        </s-box>

        <s-box padding="base" borderRadius="base" background="subdued">
          <s-stack direction="block" gap="small-500">
            <s-text type="strong">Suggested</s-text>
            <s-text>{item.after}</s-text>
          </s-stack>
        </s-box>

        {item.error && (
          <s-banner tone="critical" heading="Last attempt failed">
            <s-paragraph>{item.error}</s-paragraph>
          </s-banner>
        )}

        <s-stack direction="inline" gap="small-300">
          {canApply && (
            <s-button
              variant="primary"
              onClick={onApply}
              {...(busy ? { disabled: true } : {})}
            >
              Apply
            </s-button>
          )}
          <s-button onClick={onReject} {...(busy ? { disabled: true } : {})}>
            Dismiss
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

export function ErrorBoundary() {
  // Pass the real error through: replacing it with a label hides the actual
  // cause (a Prisma validation error once surfaced here as a bare string).
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
