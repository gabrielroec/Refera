import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";

import type { loader as applyProgressLoader } from "../routes/app.apply-progress";

type ProgressData = Awaited<ReturnType<typeof applyProgressLoader>>;

/**
 * Live progress while fixes are written to the store.
 *
 * The numbers are real, not a timed animation: each fix flips to `applied` in
 * the database the moment Shopify accepts it, and this polls those statuses —
 * which is how it can name the product being written right now.
 *
 * Deliberately an inline panel rather than an App Bridge modal. The modal
 * version fought its own lifecycle: it lives outside this iframe, so closing
 * it depends on an event round-trip, and any remount of this component
 * reopened it. A panel is plain DOM we own — dismissing it is a state change
 * and nothing can undo that. It scrolls itself into view so it is not missed.
 */
export function ApplyProgress({
  fixIds,
  onDismiss,
  onFinished,
}: {
  fixIds: string[];
  onDismiss: () => void;
  onFinished: () => void;
}) {
  const progress = useFetcher<typeof applyProgressLoader>();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const key = fixIds.join(",");

  const data: ProgressData | undefined = progress.data;
  // Only trust "finished" once the feed has reported, or the panel would
  // resolve in the same frame it appears.
  const finished = data !== undefined && data.inFlight === 0;

  const progressRef = useRef(progress);
  useEffect(() => {
    progressRef.current = progress;
  });

  useEffect(() => {
    if (finished) return;
    const tick = () => {
      if (progressRef.current.state === "idle") {
        progressRef.current.load(`/app/apply-progress?ids=${encodeURIComponent(key)}`);
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [key, finished]);

  // Bring it into view once per run — the merchant may have clicked Apply on a
  // card far down the list.
  useEffect(() => {
    panelRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "nearest",
    });
  }, [key]);

  // Tell the page to refresh once, when the run completes.
  const settledKey = useRef<string | null>(null);
  useEffect(() => {
    if (!finished || settledKey.current === key) return;
    settledKey.current = key;
    onFinished();
  }, [finished, key, onFinished]);

  const total = fixIds.length;
  const applied = data?.applied ?? 0;
  const failed = data?.failed ?? 0;
  const done = applied + failed;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div ref={panelRef}>
      <s-section heading={finished ? "Done" : "Applying to your store"}>
        {/*
          Grouped rather than evenly spaced: the status line and its bar are
          one thought, the caption belongs to the bar, and the button is a
          separate decision. Even gaps made all four read as unrelated rows.
        */}
        <s-stack direction="block" gap="large-100">
          <s-stack direction="block" gap="small">
            <s-stack direction="inline" gap="small" alignItems="center">
              {!finished && <s-spinner accessibilityLabel="Applying" />}
              <s-text type="strong">
                {finished
                  ? `${applied} of ${total} applied`
                  : data?.currentTitle
                    ? `Updating ${data.currentTitle}`
                    : "Starting…"}
              </s-text>
            </s-stack>

            <div
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              style={{
                height: 8,
                borderRadius: 4,
                background: "var(--s-color-border, #e3e3e3)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${percent}%`,
                  height: "100%",
                  borderRadius: 4,
                  background: finished
                    ? "var(--s-color-text-success, #29845a)"
                    : "var(--s-color-text, #303030)",
                  transition: "width 0.4s ease",
                }}
              />
            </div>

            <s-text color="subdued">
              {done} of {total} written
              {failed > 0 && ` · ${failed} failed`}
              {!finished && " · you can leave this page, it keeps going"}
            </s-text>
          </s-stack>

          <s-box>
            <s-button
              variant={finished ? "primary" : "tertiary"}
              onClick={onDismiss}
            >
              {finished ? "Done" : "Hide"}
            </s-button>
          </s-box>
        </s-stack>
      </s-section>
    </div>
  );
}
