import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

export default {
  ssr: true,
  // Emits the Vercel build output (serverless function + static assets) on
  // `react-router build` when deployed there. Local `shopify app dev` is
  // unaffected — the preset only changes the production build target.
  presets: process.env.VERCEL ? [vercelPreset()] : [],
} satisfies Config;
