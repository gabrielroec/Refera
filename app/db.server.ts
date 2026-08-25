import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

/**
 * Small pool per long-lived process.
 *
 * Session mode gives every pool member a real backend connection, and
 * Supabase's free tier hands out few of them — a worker and a dev server each
 * holding ten was enough to exhaust the project and make every new connection
 * fail. Five is ample: queries take ~275ms while the LLM calls they surround
 * take 10-20s, so the pool is idle almost all the time.
 */
const SESSION_POOL_SIZE = 5;

/**
 * Concurrent queries the background worker can have in flight.
 *
 * The scan's longest phase runs SIMULATION_CONCURRENCY + FIX_CONCURRENCY items
 * under one Promise.all, and each item writes its result. Unlike a serverless
 * instance, the worker is a single long-lived process, so those all contend for
 * one client's pool — at connection_limit=1 they queue behind each other and
 * the slowest ones hit Prisma's default 10s acquire timeout with a P2024 that
 * fails the whole scan.
 */
const WORKER_POOL_SIZE = 10;

/** True inside a deployed Trigger.dev worker. */
function isWorker(): boolean {
  return Boolean(process.env.TRIGGER_DEPLOYMENT_ID);
}

/** True on Vercel or inside a deployed Trigger.dev worker. */
function isDeployed(): boolean {
  return Boolean(process.env.VERCEL) || isWorker();
}

/**
 * Which Supabase connection to use, and why it is worth the branch.
 *
 * Supabase exposes two poolers. Transaction mode (6543) multiplexes many
 * clients onto few connections, which is what a fleet of serverless instances
 * needs — but it cannot hold prepared statements, so Prisma must be told
 * `pgbouncer=true` and then re-parses every statement. Measured from Brazil
 * against us-west-2 that costs ~1040ms per query versus ~210ms on session mode
 * (5432), where prepared statements work normally.
 *
 * So: deployed runtimes take the transaction pooler, because correctness under
 * horizontal scaling beats latency and their round-trip to the database is
 * short anyway. Local development takes session mode, where the round-trip is
 * intercontinental and that 5x is the difference between a snappy app and a
 * sluggish one.
 *
 * Dropping `pgbouncer=true` while staying on 6543 is not an option — verified
 * by test: 49 of 60 concurrent queries fail with prepared-statement errors.
 */
function connectionUrl(): string | undefined {
  const pooled = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;

  if (isDeployed() || !direct) {
    if (!pooled) return undefined;
    const url = new URL(pooled);
    if (!url.searchParams.has("connection_limit")) {
      // One connection per serverless instance, because there are many of them
      // and each handles one request. The worker is the opposite shape — one
      // process running twenty things at once — so it gets a real pool.
      url.searchParams.set("connection_limit", isWorker() ? String(WORKER_POOL_SIZE) : "1");
    }
    if (isWorker() && !url.searchParams.has("pool_timeout")) {
      url.searchParams.set("pool_timeout", "20");
    }
    return url.toString();
  }

  const url = new URL(direct);
  if (!url.searchParams.has("connection_limit")) {
    url.searchParams.set("connection_limit", String(SESSION_POOL_SIZE));
  }
  // Fail fast rather than hanging when the pool is genuinely exhausted.
  if (!url.searchParams.has("pool_timeout")) {
    url.searchParams.set("pool_timeout", "20");
  }
  return url.toString();
}

function createClient(): PrismaClient {
  const url = connectionUrl();
  return new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createClient();
  }
}

const prisma = global.prismaGlobal ?? createClient();

export default prisma;
