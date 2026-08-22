import prisma from "../db.server";
import {
  MAX_PRODUCTS_PER_SCAN,
  MAX_PRODUCTS_WITH_FIXES,
  QUESTIONS_PER_SCAN,
  RUNS_PER_QUESTION,
} from "../lib/constants";
import type { AdminGraphQLClient } from "../lib/graphql";
import { generateFixesForProduct } from "./fixer.server";
import { detectIssues, fetchProducts, fetchShopInfo } from "./scanner.server";
import { computeScore, scoreProduct } from "./scorer.server";
import {
  buildStoreContext,
  detectNiche,
  generateQuestions,
  runSimulation,
} from "./simulator.server";
import type { Issue, ScannedProduct, SimulationResult } from "../types";

/** Progress callback so the Trigger.dev task can emit structured logs. */
type Log = (message: string, data?: Record<string, unknown>) => void;

const noopLog: Log = () => {};

/**
 * Runs one complete scan end to end.
 *
 * Written as a single sequential function on purpose: every phase depends on
 * the previous one, and the Gemini free tier punishes parallelism. It is
 * designed to be called from a Trigger.dev task, never from a request handler —
 * the LLM phases alone exceed any serverless timeout.
 *
 * Failure policy: the scan is marked `failed` with the error message, but
 * whatever was already persisted (snapshots, completed simulations) is kept, so
 * a partial result is still inspectable.
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
    data: { status: "running", startedAt: new Date(), error: null },
  });

  try {
    // -- Phase 1: catalogue -------------------------------------------------
    log("Fetching shop info");
    const shopInfo = await fetchShopInfo(admin);

    log("Fetching products", { limit: MAX_PRODUCTS_PER_SCAN });
    const products = await fetchProducts(admin, MAX_PRODUCTS_PER_SCAN);
    log("Products fetched", { count: products.length });

    if (products.length === 0) {
      throw new Error(
        "This store has no products to scan. Add products and run the scan again.",
      );
    }

    const issuesByProduct: Issue[][] = products.map(detectIssues);

    // Persisted before the slow phases so the dashboard has something to show
    // even if a later phase fails.
    const snapshotIds = await persistSnapshots(
      scanId,
      products,
      issuesByProduct,
    );

    const issuesFound = issuesByProduct.reduce((sum, i) => sum + i.length, 0);
    await prisma.scan.update({
      where: { id: scanId },
      data: { productsScanned: products.length, issuesFound },
    });

    // -- Phase 2: understand the store --------------------------------------
    log("Detecting niche");
    const { niche, language } = await detectNiche(products, shopInfo.name);
    log("Niche detected", { niche, language });

    await prisma.shop.update({
      where: { id: scan.shopId },
      data: {
        niche,
        name: shopInfo.name,
        currencyCode: shopInfo.currencyCode,
        primaryLocale: language,
      },
    });

    const store = buildStoreContext(
      shopInfo.domain,
      shopInfo.name,
      niche,
      shopInfo.currencyCode,
      language,
      products,
    );

    // -- Phase 3: simulations ------------------------------------------------
    log("Generating questions", { count: QUESTIONS_PER_SCAN });
    const questions = await generateQuestions(store, QUESTIONS_PER_SCAN);

    const simulations: SimulationResult[] = [];
    for (const [index, question] of questions.entries()) {
      log(`Simulating ${index + 1}/${questions.length}`, {
        question,
        runs: RUNS_PER_QUESTION,
      });

      const result = await runSimulation(question, store, RUNS_PER_QUESTION);
      simulations.push(result);

      // Written per question rather than in one batch: a scan that dies on
      // question 7 still shows the first six on the dashboard.
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
    }

    // -- Phase 4: score ------------------------------------------------------
    const breakdown = computeScore(issuesByProduct, simulations);
    log("Score computed", {
      total: breakdown.total,
      data: breakdown.dataScore,
      visibility: breakdown.visibilityScore,
    });

    await prisma.scan.update({
      where: { id: scanId },
      data: {
        score: breakdown.total,
        scoreBreakdown: breakdown as unknown as object,
      },
    });

    // -- Phase 5: fixes ------------------------------------------------------
    // Worst products first, so the capped budget goes where it matters most.
    const ranked = products
      .map((product, index) => ({
        product,
        issues: issuesByProduct[index],
        snapshotId: snapshotIds[index],
        score: scoreProduct(issuesByProduct[index]),
      }))
      .filter((entry) => entry.issues.some((i) => i.fixable))
      .sort((a, b) => a.score - b.score)
      .slice(0, MAX_PRODUCTS_WITH_FIXES);

    log("Generating fixes", { products: ranked.length });

    for (const entry of ranked) {
      const fixes = await generateFixesForProduct(
        admin,
        entry.product,
        store,
        entry.issues,
      );

      if (fixes.length === 0) continue;

      await prisma.fix.createMany({
        data: fixes.map((fix) => ({
          productSnapshotId: entry.snapshotId,
          type: fix.type,
          issueCode: fix.issueCode,
          rationale: fix.rationale,
          before: fix.before as unknown as object,
          after: fix.after as unknown as object,
        })),
      });
    }

    await prisma.scan.update({
      where: { id: scanId },
      data: { status: "done", finishedAt: new Date() },
    });
    log("Scan complete", { scanId, score: breakdown.total });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: "failed", error: message, finishedAt: new Date() },
    });
    throw error;
  }
}

/**
 * Inserts snapshots and returns their ids in the same order as `products`, so
 * the fix phase can map a product back to its row without a second query.
 */
async function persistSnapshots(
  scanId: string,
  products: ScannedProduct[],
  issuesByProduct: Issue[][],
): Promise<string[]> {
  const ids: string[] = [];

  for (const [index, product] of products.entries()) {
    const row = await prisma.productSnapshot.create({
      data: {
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
        metafields: product.metafields as unknown as object[],
        issues: issuesByProduct[index] as unknown as object[],
      },
      select: { id: true },
    });
    ids.push(row.id);
  }

  return ids;
}
