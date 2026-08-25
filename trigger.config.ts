import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

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
    // Generates the Prisma client inside the deploy image.
    extensions: [
      prismaExtension({
        mode: "legacy",
        schema: "prisma/schema.prisma",
      }),
    ],
  },
});
