import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { config as loadEnvFile } from "dotenv";

/**
 * Must match `application_url` in shopify.app.toml. Not a secret, and not taken
 * from .env: locally that variable is http://localhost:3000, and a worker
 * deployed to production pointing at a laptop is worse than one that fails.
 */
const PRODUCTION_APP_URL = "https://refera-eight.vercel.app";

export default defineConfig({
  // Set TRIGGER_PROJECT_REF in .env (and in Vercel) after creating the
  // project at cloud.trigger.dev.
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_replace_me",
  dirs: ["./trigger"],
  runtime: "node",
  // One hour. On the Gemini free tier the 30 grounded simulation calls alone
  // can take 25+ minutes of rate-limit backoff, so 30 minutes was not enough
  // (a real run died at exactly 1800s). The ceiling still exists so a hung run
  // cannot burn the free tier indefinitely.
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 1,
    },
  },
  build: {
    extensions: [
      // Generates the Prisma client inside the deploy image.
      prismaExtension({
        mode: "legacy",
        schema: "prisma/schema.prisma",
      }),

      /**
       * Copies this machine's environment into the Trigger.dev environment at
       * deploy time.
       *
       * The worker needs the same credentials the web app does — it reads the
       * catalogue through the Shopify Admin API, calls OpenAI, and writes to the
       * same database — but Trigger does not inherit anything from Vercel, and a
       * deploy indexes tasks by *importing* them, so a missing SHOPIFY_APP_URL
       * fails the build rather than the first run.
       *
       * Names are listed rather than sweeping process.env, so nothing unrelated
       * to the worker is ever published. Values are read straight from .env and
       * never printed.
       *
       * The variable this most needs to keep identical on both sides is
       * DATABASE_URL: if the worker and the dashboard ever point at different
       * databases, scans are written where nobody reads them, and nothing on
       * screen says so.
       */
      syncEnvVars(() => {
        loadEnvFile({ path: ".env", override: false, quiet: true });

        const NEEDED = [
          "DATABASE_URL",
          "DIRECT_URL",
          "SHOPIFY_API_KEY",
          "SHOPIFY_API_SECRET",
          "SCOPES",
          "LLM_PROVIDER",
          "LLM_GROUNDING",
          "OPENAI_API_KEY",
          "OPENAI_MODEL",
          "OPENAI_FAST_MODEL",
        ];

        // OPENAI_FAST_MODEL is the one name allowed to be absent: the provider
        // falls back to the standard model. Everything else missing means the
        // worker would deploy and then fail at runtime, so fail here instead —
        // silently shipping a worker without DATABASE_URL is the whole reason
        // this list is explicit.
        const OPTIONAL = new Set(["OPENAI_FAST_MODEL", "LLM_GROUNDING"]);

        const missing = NEEDED.filter(
          (name) => !process.env[name] && !OPTIONAL.has(name),
        );
        if (missing.length > 0) {
          throw new Error(
            `Cannot deploy: ${missing.join(", ")} missing from .env. ` +
              "The worker needs these at runtime and does not inherit them from Vercel.",
          );
        }

        const synced = NEEDED.flatMap((name) => {
          const value = process.env[name];
          return value ? [{ name, value }] : [];
        });

        synced.push({ name: "SHOPIFY_APP_URL", value: PRODUCTION_APP_URL });

        return synced;
      }),
    ],
  },
});
