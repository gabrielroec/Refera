import prisma from "../db.server";
import { mapWithConcurrency } from "../lib/concurrency";
import {
  FIX_CONCURRENCY,
  FIX_PROMPT_VERSION,
  MAX_PRODUCTS_WITH_FIXES,
  QUESTIONS_MAX_AGE_MS,
  QUESTIONS_PER_SCAN,
  RUNS_PER_QUESTION,
  SIMULATION_CONCURRENCY,
} from "../lib/constants";
import type { AdminGraphQLClient } from "../lib/graphql";
import { stableHash } from "../lib/hash";
import { loadCatalogue, type CatalogueProduct } from "./catalogue.server";
import { generateAndStoreFixes } from "./fixer.server";
import { detectIssues, fetchShopInfo } from "./scanner.server";
import { computeScore, scoreProduct } from "./scorer.server";
import {
  buildStoreContext,
  detectNiche,
  generateQuestions,
  runSimulation,
} from "./simulator.server";
import type { Issue, SimulationResult, StoreContext } from "../types";

/** Progress callback so the Trigger.dev task can emit structured logs. */
type Log = (message: string, data?: Record<string, unknown>) => void;

const noopLog: Log = () => {};

interface SnapshotEntry {
  id: string;
  product: CatalogueProduct;
  issues: Issue[];
  /** True when fixes were inherited from an earlier scan of identical content. */
  carried: boolean;
}

/**
 * Runs one complete scan end to end.
 *
 * Shape of the work:
 *   1. catalogue  — from the local mirror (milliseconds) or the Admin API
 *   2. snapshots  — one batch insert; fixes inherited where content is unchanged
 *   3. context    — niche/language (fast model), questions pinned per store
 *   4. simulate ∥ fix — both phases fan out and run concurrently; neither
 *      depends on the other (fixes follow issues, not the score)
 *   5. score      — written as soon as simulations land, before fixes finish
 *
 * Every unit of work persists its own result the moment it completes, so the
 * dashboard fills in progressively and a failure keeps everything done so far.
 * Designed for a Trigger.dev task, never a request handler.
 */
export async function runScanPipeline(
  scanId: string,
  admin: AdminGraphQLClient,
  log: Log = noopLog,
): Promise<void> {
  const scan = await prisma.scan.findUnique({
    where: { id: scanId },
    include: { shop: true },
  });
  if (!scan) throw new Error(`Scan ${scanId} not found`);

  await prisma.scan.update({
    where: { id: scanId },
    data: {
      status: "running",
      phase: "catalogue",
      startedAt: new Date(),
      error: null,
    },
  });

  try {
    // -- 1. catalogue ---------------------------------------------------------
    const [shopInfo, products] = await Promise.all([
      fetchShopInfo(admin),
      loadCatalogue(scan.shopId, admin, log),
    ]);

    if (products.length === 0) {
      throw new Error(
        "This store has no active products to scan. Add products and run the scan again.",
      );
    }

    // -- 2. snapshots + carry-forward ------------------------------------------
    await prisma.scan.update({ where: { id: scanId }, data: { phase: "analysing" } });
    const entries = await persistSnapshots(scan.shopId, scanId, products);

    const issuesByProduct = entries.map((e) => e.issues);
    const issuesFound = issuesByProduct.reduce((sum, i) => sum + i.length, 0);
    await prisma.scan.update({
      where: { id: scanId },
      data: { productsScanned: entries.length, issuesFound, phase: "questions" },
    });
    log("Catalogue analysed", {
      products: entries.length,
      issues: issuesFound,
      carriedForward: entries.filter((e) => e.carried).length,
    });

    // -- 3. store context + questions -----------------------------------------
    const { store, questions } = await resolveStoreContext(
      scan.shopId,
      shopInfo,
      products,
      log,
    );

    // -- 4. simulate ∥ fix ------------------------------------------------------
    await prisma.scan.update({ where: { id: scanId }, data: { phase: "simulating" } });
    const [simulations] = await Promise.all([
      simulateAll(scanId, questions, store, log),
      generateEagerFixes(admin, entries, store, log),
    ]);

    await prisma.scan.update({
      where: { id: scanId },
      data: { status: "done", phase: "finished", finishedAt: new Date() },
    });
    log("Scan complete", {
      scanId,
      appearances: simulations.reduce((s, r) => s + r.appearanceCount, 0),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.scan.update({
      where: { id: scanId },
      data: {
        status: "failed",
        phase: "finished",
        error: message,
        finishedAt: new Date(),
      },
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 2. snapshots
// ---------------------------------------------------------------------------

/**
 * Inserts every snapshot in one statement and inherits fixes from the last
 * finished scan for products whose content hash is unchanged.
 *
 * Inherited fixes keep their review status (suggested / rejected), so a
 * merchant who rejected a suggestion is not nagged with it again. Applied
 * fixes are never inherited: applying one changes the product, which changes
 * the hash.
 */
async function persistSnapshots(
  shopId: string,
  scanId: string,
  products: CatalogueProduct[],
): Promise<SnapshotEntry[]> {
  const issuesByProduct = products.map(detectIssues);

  const previous = await prisma.productSnapshot.findMany({
    where: {
      scan: { shopId, status: "done", id: { not: scanId } },
      productId: { in: products.map((p) => p.productId) },
      contentHash: { in: products.map((p) => p.contentHash) },
      fixStatus: "done",
      fixesVersion: FIX_PROMPT_VERSION,
    },
    orderBy: { createdAt: "desc" },
    include: { fixes: { where: { status: { in: ["suggested", "rejected"] } } } },
  });
  // Newest matching snapshot per product wins.
  const reusable = new Map<string, (typeof previous)[number]>();
  for (const snap of previous) {
    const key = `${snap.productId}:${snap.contentHash}`;
    if (!reusable.has(key)) reusable.set(key, snap);
  }

  const rows = await prisma.productSnapshot.createManyAndReturn({
    data: products.map((product, index) => {
      const source = reusable.get(`${product.productId}:${product.contentHash}`);
      return {
        scanId,
        productId: product.productId,
        handle: product.handle,
        title: product.title,
        description: product.description,
        category: product.category,
        categoryId: product.categoryId,
        productType: product.productType,
        vendor: product.vendor,
        tags: product.tags,
        imageCount: product.imageCount,
        hasAltText: product.hasAltText,
        imageUrl: product.imageUrl,
        metafields: product.metafields as unknown as object[],
        issues: issuesByProduct[index] as unknown as object[],
        contentHash: product.contentHash,
        carriedFromId: source?.id ?? null,
        fixStatus: source ? ("done" as const) : ("pending" as const),
        fixesVersion: source ? FIX_PROMPT_VERSION : null,
      };
    }),
    select: { id: true, productId: true, carriedFromId: true },
  });

  const carriedFixes = rows.flatMap((row) => {
    if (!row.carriedFromId) return [];
    const source = previous.find((s) => s.id === row.carriedFromId);
    return (source?.fixes ?? []).map((fix) => ({
      productSnapshotId: row.id,
      type: fix.type,
      status: fix.status,
      issueCode: fix.issueCode,
      rationale: fix.rationale,
      before: fix.before as object,
      after: fix.after as object,
    }));
  });
  if (carriedFixes.length > 0) {
    await prisma.fix.createMany({ data: carriedFixes });
  }

  const byProductId = new Map(rows.map((r) => [r.productId, r]));
  return products.map((product, index) => {
    const row = byProductId.get(product.productId)!;
    return {
      id: row.id,
      product,
      issues: issuesByProduct[index],
      carried: row.carriedFromId !== null,
    };
  });
}

// ---------------------------------------------------------------------------
// 3. store context + questions
// ---------------------------------------------------------------------------

/**
 * Resolves the niche, language and the buyer questions for this scan.
 *
 * All three are pinned per store and reused while the pin is fresh: the
 * niche is free text from a model and drifts slightly between calls, so
 * re-deriving it would silently regenerate the questions every scan. Stable
 * questions are what make consecutive scores comparable — the merchant sees
 * whether applied fixes moved the needle on the *same* questions. They are
 * always re-executed, never their answers: frequency is what we measure.
 * A currency change (the only input that comes from outside) invalidates the pin.
 */
async function resolveStoreContext(
  shopId: string,
  shopInfo: {
    name: string;
    domain: string;
    primaryDomain: string | null;
    currencyCode: string;
  },
  products: CatalogueProduct[],
  log: Log,
): Promise<{ store: StoreContext; questions: string[] }> {
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: {
      niche: true,
      primaryLocale: true,
      simulationQuestions: true,
      storeContextHash: true,
      questionsGeneratedAt: true,
    },
  });

  const pinned = Array.isArray(shop.simulationQuestions)
    ? (shop.simulationQuestions as unknown[]).filter(
        (q): q is string => typeof q === "string",
      )
    : [];
  const fresh =
    shop.questionsGeneratedAt !== null &&
    Date.now() - shop.questionsGeneratedAt.getTime() < QUESTIONS_MAX_AGE_MS;
  const currencyHash = stableHash({ currencyCode: shopInfo.currencyCode });

  if (
    fresh &&
    shop.niche &&
    shop.primaryLocale &&
    pinned.length >= QUESTIONS_PER_SCAN &&
    shop.storeContextHash === currencyHash
  ) {
    const store = buildStoreContext(
      shopInfo.domain,
      shopInfo.primaryDomain,
      shopInfo.name,
      shop.niche,
      shopInfo.currencyCode,
      shop.primaryLocale,
      products,
    );
    log("Reusing pinned niche and questions", { niche: shop.niche });
    return { store, questions: pinned.slice(0, QUESTIONS_PER_SCAN) };
  }

  const { niche, language } = await detectNiche(products, shopInfo.name);
  const store = buildStoreContext(
    shopInfo.domain,
    shopInfo.primaryDomain,
    shopInfo.name,
    niche,
    shopInfo.currencyCode,
    language,
    products,
  );
  const questions = await generateQuestions(store, QUESTIONS_PER_SCAN);

  await prisma.shop.update({
    where: { id: shopId },
    data: {
      niche,
      name: shopInfo.name,
      currencyCode: shopInfo.currencyCode,
      primaryLocale: language,
      simulationQuestions: questions,
      storeContextHash: currencyHash,
      questionsGeneratedAt: new Date(),
    },
  });
  log("Niche and questions generated", { niche, count: questions.length });
  return { store, questions };
}

// ---------------------------------------------------------------------------
// 4a. simulations
// ---------------------------------------------------------------------------

/**
 * Runs every question concurrently (each question runs its executions
 * concurrently too) and writes each result the moment it lands. Scores the
 * scan as soon as the last one is in — without waiting for fixes.
 */
async function simulateAll(
  scanId: string,
  questions: string[],
  store: StoreContext,
  log: Log,
): Promise<SimulationResult[]> {
  const simulations = await mapWithConcurrency(
    questions,
    SIMULATION_CONCURRENCY,
    async (question) => {
      const result = await runSimulation(question, store, RUNS_PER_QUESTION);
      await prisma.simulation.create({
        data: {
          scanId,
          question: result.question,
          model: result.model,
          grounded: result.grounded,
          executions: result.executions as unknown as object[],
          appearanceCount: result.appearanceCount,
          runCount: result.runCount,
          competitors: result.competitors,
        },
      });
      log("Simulation done", {
        question,
        appeared: `${result.appearanceCount}/${result.runCount}`,
      });
      return result;
    },
  );

  const snapshots = await prisma.productSnapshot.findMany({
    where: { scanId },
    select: { issues: true },
  });
  const breakdown = computeScore(
    snapshots.map((s) => s.issues as unknown as Issue[]),
    simulations,
  );
  await prisma.scan.update({
    where: { id: scanId },
    data: { score: breakdown.total, scoreBreakdown: breakdown as unknown as object },
  });
  log("Score computed", {
    total: breakdown.total,
    data: breakdown.dataScore,
    visibility: breakdown.visibilityScore,
  });
  // Simulations are done; whatever remains is fix generation.
  await prisma.scan.updateMany({
    where: { id: scanId, status: "running" },
    data: { phase: "fixing" },
  });

  return simulations;
}

// ---------------------------------------------------------------------------
// 4b. fixes
// ---------------------------------------------------------------------------

/**
 * Generates fixes for the worst products that did not inherit any, in
 * parallel. Products beyond the cap stay `pending` and can be requested from
 * the dashboard.
 */
async function generateEagerFixes(
  admin: AdminGraphQLClient,
  entries: SnapshotEntry[],
  store: StoreContext,
  log: Log,
): Promise<void> {
  const ranked = entries
    .filter((e) => !e.carried && e.issues.some((i) => i.fixable))
    .sort((a, b) => scoreProduct(a.issues) - scoreProduct(b.issues))
    .slice(0, MAX_PRODUCTS_WITH_FIXES);

  log("Generating fixes", { products: ranked.length });

  await mapWithConcurrency(ranked, FIX_CONCURRENCY, async (entry) => {
    const count = await generateAndStoreFixes(admin, entry, store);
    log("Fixes generated", { product: entry.product.title, count });
  });
}
