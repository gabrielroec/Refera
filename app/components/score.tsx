/**
 * Score presentation, shared by the overview and the issues screen.
 *
 * Colours come from Polaris CSS custom properties rather than hex literals:
 * the admin ships a dark theme, and a baked `#e3e3e3` track is invisible on
 * it. `color-mix` against the token keeps the fills tinted without inventing
 * a second palette.
 */

/** Semantic band for a 0-100 score. Drives colour, label and copy together. */
export type ScoreBand = "critical" | "warning" | "success";

export function scoreBand(score: number): ScoreBand {
  if (score < 40) return "critical";
  if (score < 70) return "warning";
  return "success";
}

const BAND_FILL: Record<ScoreBand, string> = {
  critical: "var(--s-color-text-critical, #d82c0d)",
  warning: "var(--s-color-text-caution, #b98900)",
  success: "var(--s-color-text-success, #29845a)",
};

const BAND_VERDICT: Record<ScoreBand, string> = {
  critical: "A lot to gain here",
  warning: "Some ground to make up",
  success: "Strong AI readiness",
};

export function scoreVerdict(score: number): string {
  return BAND_VERDICT[scoreBand(score)];
}

const TRACK = "var(--s-color-border, #e3e3e3)";

/** The headline dial. Polaris has no gauge component, so this stays custom. */
export function ScoreDial({ score, size = 132 }: { score: number; size?: number }) {
  const stroke = size * 0.075;
  const radius = size / 2 - stroke;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circumference;

  return (
    <div style={{ position: "relative", flex: "0 0 auto", lineHeight: 0 }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`AI readiness score: ${score} out of 100`}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={TRACK}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={BAND_FILL[scoreBand(score)]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 1.1,
        }}
      >
        <span
          style={{
            fontSize: size * 0.26,
            fontWeight: 650,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {score}
        </span>
        <span style={{ fontSize: size * 0.095, opacity: 0.65 }}>of 100</span>
      </div>
    </div>
  );
}

/**
 * A 0-100 sub-score with a bar and a caption saying what it measures.
 *
 * The bar earns its place: "38/100" beside "39 products scanned" reads as a
 * count until something on screen makes it unmistakably a rating.
 */
export function ScoreBar({
  label,
  score,
  caption,
}: {
  label: string;
  score: number;
  caption: string;
}) {
  const band = scoreBand(score);
  return (
    <s-box padding="base" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="small-300">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-text type="strong">{label}</s-text>
          <s-badge tone={band}>{score} / 100</s-badge>
        </s-stack>
        <div
          style={{
            height: 6,
            borderRadius: 3,
            background: TRACK,
            overflow: "hidden",
          }}
          role="img"
          aria-label={`${label}: ${score} out of 100`}
        >
          <div
            style={{
              width: `${Math.max(0, Math.min(100, score))}%`,
              height: "100%",
              borderRadius: 3,
              background: BAND_FILL[band],
            }}
          />
        </div>
        <s-text color="subdued">{caption}</s-text>
      </s-stack>
    </s-box>
  );
}
