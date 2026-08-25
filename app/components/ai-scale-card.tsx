import { useEffect, useState } from "react";

import { Globe } from "./globe";
import {
  AI_ADOPTION,
  AI_CONVERSION,
  PRODUCT_QUERIES_PER_SECOND,
} from "../lib/ai-adoption";

/**
 * The scale of AI-assisted shopping, next to this store's place in it.
 *
 * Kept to a compact band: this is context, and the merchant's own score is the
 * reason they opened the app. The store's own tile sits in the same row as the
 * global figures on purpose — the world asks 625 times a second, and this
 * store appears in none of it.
 *
 * Every figure is published and sourced on screen, and the one number we derive
 * ourselves says so — a fabricated statistic inside an app whose product is
 * measuring reality would undermine the whole thing.
 */
export function AiScaleCard({
  appearances,
  totalRuns,
}: {
  appearances: number;
  totalRuns: number;
}) {
  const sinceOpened = useElapsedQueries();

  return (
    <s-section>
      <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
        <s-stack direction="block" gap="base">
          <s-grid
            gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))"
            gap="small"
          >
            <Tile
              value={PRODUCT_QUERIES_PER_SECOND.toLocaleString("en-US")}
              unit="/sec"
              caption="product questions reach ChatGPT"
              accent
            />
            <Tile
              value={AI_ADOPTION.display}
              caption="of shoppers have used AI to shop"
            />
            <Tile
              value={AI_CONVERSION.display}
              caption="better conversion than search"
            />
            <Tile
              value={totalRuns === 0 ? "—" : `${appearances}/${totalRuns}`}
              caption="AI answers that mention you"
              critical={totalRuns > 0 && appearances === 0}
            />
          </s-grid>

          <s-stack direction="block" gap="small-500">
            {sinceOpened > 0 && (
              <s-text color="subdued">
                Roughly {sinceOpened.toLocaleString("en-US")} since you opened
                this page.
              </s-text>
            )}
            {/*
              Attribution, not copy: set small and light so it stays available
              without competing. It still names the derived figure as ours —
              that part is not optional.
            */}
            <span
              style={{
                fontSize: "0.72rem",
                lineHeight: 1.5,
                opacity: 0.55,
              }}
            >
              Per-second is our estimate from OpenAI/NBER w34255 · Adobe
              Analytics 2026 · Globe weighted by Similarweb
            </span>
          </s-stack>
        </s-stack>

        <Globe size={260} />
      </s-grid>
    </s-section>
  );
}

/** One figure as a tile: number set large, its meaning beneath. */
function Tile({
  value,
  unit,
  caption,
  accent = false,
  critical = false,
}: {
  value: string;
  unit?: string;
  caption: string;
  accent?: boolean;
  critical?: boolean;
}) {
  const colour = accent
    ? "var(--s-color-text-success, #008060)"
    : critical
      ? "var(--s-color-text-critical, #d82c0d)"
      : undefined;

  return (
    <s-box padding="base" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="small-500">
        <span
          style={{
            fontSize: "1.5rem",
            fontWeight: 650,
            lineHeight: 1.1,
            fontVariantNumeric: "tabular-nums",
            color: colour,
            whiteSpace: "nowrap",
          }}
        >
          {value}
          {unit && (
            <span style={{ fontSize: "0.8rem", fontWeight: 500, opacity: 0.7 }}>
              {unit}
            </span>
          )}
        </span>
        <s-text color="subdued">{caption}</s-text>
      </s-stack>
    </s-box>
  );
}

/**
 * Product questions that have reached ChatGPT since the page opened.
 *
 * Counts from a rate rather than pretending to observe events: the number is
 * an honest extrapolation, and it makes a per-second figure legible as
 * something happening now rather than a statistic the eye slides past.
 */
function useElapsedQueries(): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return seconds * PRODUCT_QUERIES_PER_SECOND;
}
