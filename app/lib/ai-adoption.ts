/**
 * Published figures on AI-assisted product discovery.
 *
 * Everything here is real and citable — the globe is a claim about the world,
 * and an invented number would be indefensible in an app whose entire product
 * is measuring what is actually true.
 *
 * Update policy: keep the source, its URL and its date beside every figure,
 * and re-check when they age past a year. If a number cannot be sourced, it
 * does not belong on screen.
 */

/**
 * Product-related messages sent to ChatGPT, per second.
 *
 * Derived, not quoted. OpenAI's own research (NBER w34255, "How People Use
 * ChatGPT") reports 18 billion consumer messages per week as of July 2025, and
 * classifies 2.1% of messages as "Purchasable Products" — inquiries about
 * things available to buy. That gives:
 *
 *   18,000,000,000 × 0.021 = 378,000,000 per week
 *   378,000,000 ÷ (7 × 24 × 60 × 60) = 625 per second
 *
 * Corroborated independently: Stackline measured 84 million US shopping
 * questions per week; against Similarweb's 19.16% US share of ChatGPT traffic
 * that implies ~438M/week globally — within 16% of the figure above, from a
 * completely separate measurement.
 *
 * Deliberately conservative. It counts ChatGPT alone, ignoring Gemini, Copilot
 * and Perplexity entirely, and its inputs are from July 2025, since when
 * ChatGPT has grown from 700M to over 900M weekly users. The real number today
 * is higher.
 */
export const PRODUCT_QUERIES_PER_SECOND = 625;

export interface SourcedFigure {
  /** The figure exactly as it should read on screen. */
  display: string;
  /** Wording shown beside the number. */
  label: string;
  source: string;
  sourceUrl: string;
  asOf: string;
}

/** How many shoppers have already used AI to shop. */
export const AI_ADOPTION: SourcedFigure = {
  display: "39%",
  label:
    "of shoppers have used AI to shop online — and 85% of them said it made the experience better.",
  source: "Adobe Analytics",
  sourceUrl:
    "https://business.adobe.com/blog/ai-traffic-surge-retail-sites-not-machine-readable",
  asOf: "2026",
};

/** How fast this is arriving. */
export const AI_TRAFFIC_GROWTH: SourcedFigure = {
  display: "393%",
  label: "growth in AI-referred traffic to US retail sites, year over year.",
  source: "Adobe Analytics",
  sourceUrl:
    "https://business.adobe.com/resources/sdk/.q3-ai-traffic-trends-report/q3-2026-ai-sourced-traffic-insights.pdf",
  asOf: "Q1 2026",
};

/** Why those visitors are worth having. */
export const AI_CONVERSION: SourcedFigure = {
  display: "42%",
  label: "better conversion from AI-referred visitors than from search traffic.",
  source: "Adobe Analytics",
  sourceUrl:
    "https://www.digitalcommerce360.com/2026/08/19/adobe-ai-referral-traffic-data-july-2026/",
  asOf: "2026",
};

/** One point on the globe: a market where AI assistants are widely used. */
export interface MarketPoint {
  country: string;
  /** Degrees; positive north / east. */
  lat: number;
  lon: number;
  /**
   * Share of global ChatGPT traffic, as a fraction. Drives dot size, so the
   * globe reflects measured distribution rather than decorative scatter.
   */
  share: number;
}

/**
 * Markets weighted by Similarweb's country breakdown of chatgpt.com traffic
 * (July 2026). The five largest are measured directly; the rest are drawn from
 * adjacent months and rounded, and together they sit inside the "other"
 * remainder rather than inflating it.
 *
 * Coordinates are the largest population centre rather than the geographic
 * centroid, so dots land where the users are.
 */
export const MARKETS: MarketPoint[] = [
  { country: "United States", lat: 40.7, lon: -74.0, share: 0.1916 },
  { country: "India", lat: 19.1, lon: 72.9, share: 0.0997 },
  { country: "Brazil", lat: -23.5, lon: -46.6, share: 0.0568 },
  { country: "Japan", lat: 35.7, lon: 139.7, share: 0.0515 },
  { country: "United Kingdom", lat: 51.5, lon: -0.1, share: 0.037 },
  { country: "Indonesia", lat: -6.2, lon: 106.8, share: 0.037 },
  { country: "Germany", lat: 52.5, lon: 13.4, share: 0.0333 },
  { country: "Philippines", lat: 14.6, lon: 121.0, share: 0.03 },
  { country: "Mexico", lat: 19.4, lon: -99.1, share: 0.025 },
  { country: "France", lat: 48.9, lon: 2.4, share: 0.023 },
  { country: "Canada", lat: 43.7, lon: -79.4, share: 0.021 },
  { country: "Vietnam", lat: 10.8, lon: 106.7, share: 0.02 },
  { country: "Turkey", lat: 41.0, lon: 29.0, share: 0.019 },
  { country: "Italy", lat: 41.9, lon: 12.5, share: 0.018 },
  { country: "Spain", lat: 40.4, lon: -3.7, share: 0.017 },
  { country: "South Korea", lat: 37.6, lon: 127.0, share: 0.016 },
  { country: "Nigeria", lat: 6.5, lon: 3.4, share: 0.015 },
  { country: "Poland", lat: 52.2, lon: 21.0, share: 0.013 },
  { country: "Egypt", lat: 30.0, lon: 31.2, share: 0.012 },
  { country: "Argentina", lat: -34.6, lon: -58.4, share: 0.012 },
  { country: "Australia", lat: -33.9, lon: 151.2, share: 0.011 },
  { country: "Thailand", lat: 13.8, lon: 100.5, share: 0.011 },
  { country: "Colombia", lat: 4.7, lon: -74.1, share: 0.01 },
  { country: "South Africa", lat: -26.2, lon: 28.0, share: 0.009 },
  { country: "Netherlands", lat: 52.4, lon: 4.9, share: 0.009 },
  { country: "Saudi Arabia", lat: 24.7, lon: 46.7, share: 0.008 },
];

/** The largest share, for scaling dot sizes relative to the biggest market. */
export const MAX_MARKET_SHARE = Math.max(...MARKETS.map((m) => m.share));
