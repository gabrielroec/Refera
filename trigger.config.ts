import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";
import { syncVercelEnvVars } from "@trigger.dev/build/extensions/core";

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
       * Pulls this project's Vercel Production variables into Trigger at deploy
       * time, so Vercel is the one place environment lives.
       *
       * Worth the indirection because the failure it prevents is quiet: the web
       * app and the worker read the same DATABASE_URL and the same Shopify
       * credentials, and if the two drift, the worker writes scans to one
       * database while the dashboard reads another — with nothing on screen to
       * say so.
       *
       * The two ids are written here rather than left to environment variables
       * because they are identifiers, not credentials — every Vercel API call
       * still needs the token, so on their own they open nothing. That leaves
       * exactly one secret to configure: VERCEL_ACCESS_TOKEN, in the Trigger.dev
       * environment.
       *
       * Skipped entirely when the build target is `dev`, so local
       * `trigger dev` keeps reading .env.
       */
      syncVercelEnvVars({
        projectId: "prj_IPoZa0mhWwq6GODBeu7ZXQRJvv0E",
        vercelTeamId: "team_nFDwAqY1t0oWIxQ1Vdwfou4e",
      }),
    ],
  },
});
