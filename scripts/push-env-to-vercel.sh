#!/usr/bin/env bash
#
# Copies the values in .env to the Vercel project's Production environment.
#
# Run this yourself. The secrets are read from your .env, printed nowhere, and
# sent straight to Vercel — nothing is echoed and no value is passed as a
# command-line argument, so none of it lands in your shell history.
#
#   nvm use 22          # the Shopify and Vercel CLIs both fail on Node 20
#   npx vercel login
#   npx vercel link --yes --project refera --scope gabrielroecs-projects
#   ./scripts/push-env-to-vercel.sh
#
# SHOPIFY_APP_URL is deliberately skipped: locally it is http://localhost:3000,
# and in production it has to be the deployment's own domain. Set that one after
# the first deploy tells you the domain.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env in $(pwd) — nothing to copy." >&2
  exit 1
fi

# Everything the app reads at runtime, minus the one that must differ in
# production. Listed explicitly rather than sweeping the file, so a stray
# variable never gets published by accident.
VARS=(
  SHOPIFY_API_KEY
  SHOPIFY_API_SECRET
  SCOPES
  DATABASE_URL
  DIRECT_URL
  LLM_PROVIDER
  LLM_GROUNDING
  OPENAI_API_KEY
  OPENAI_MODEL
  OPENAI_FAST_MODEL
  TRIGGER_SECRET_KEY
  TRIGGER_PROJECT_REF
)

for name in "${VARS[@]}"; do
  # Take everything after the first "=", then strip one layer of quotes.
  # `|| true` matters: with `set -o pipefail`, a grep that matches nothing
  # fails the pipeline and `set -e` kills the whole script — silently skipping
  # every variable after the first one that is absent from .env.
  value="$(grep -E "^${name}=" .env 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true)"

  if [ -z "$value" ]; then
    echo "skip   $name  (not set in .env)"
    continue
  fi

  if printf '%s' "$value" | npx vercel env add "$name" production --force >/dev/null 2>&1; then
    echo "pushed $name"
  else
    echo "FAILED $name — set it by hand in the Vercel dashboard" >&2
  fi
done

echo
echo "Done. Two things are still missing on purpose:"
echo "  1. SHOPIFY_APP_URL — set it to the deployment domain, then redeploy."
echo "  2. TRIGGER_SECRET_KEY must be the tr_prod_ key, not tr_dev_."
echo "     A dev key enqueues into a dead environment without throwing, so"
echo "     scans would sit at 'queued' forever with no error on screen."
