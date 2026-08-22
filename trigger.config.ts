import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

export default defineConfig({
  // Set TRIGGER_PROJECT_REF in .env (and in Vercel) after creating the
  // project at cloud.trigger.dev.
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_replace_me",
  dirs: ["./trigger"],
  runtime: "node",
  // A full scan (catalogue + 30 grounded LLM calls + fixes) stays well under
  // this; the ceiling exists so a hung run cannot burn the free tier.
  maxDuration: 1800,
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
