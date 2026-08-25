import prisma from "../db.server";
import { ISSUE_DEFINITIONS } from "../lib/issues";
import { computeIssueGroups, type IssueGroup } from "./scorer.server";
import { rescueStuckScan } from "./scan-state.server";
import type { Issue, IssueCode, ScoreBreakdown } from "../types";

/**
 * Read models for the three dashboard screens.
 *
 * Each screen asks for exactly what it renders. The old single loader pulled
 * every product with every fix payload — half a megabyte — because one page
 * showed everything; with the overview / issues / review split, no screen
 * needs that again.
 */

export interface ShopScanContext {
  shopId: string;
  scanId: string | null;
}

async function latestScanId(shopId: string): Promise<string | null> {
  const scan = await prisma.scan.findFirst({
    where: { shopId, status: "done" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return scan?.id ?? null;
}

// ---------------------------------------------------------------------------
// Overview (/app)
// ---------------------------------------------------------------------------

export interface OverviewData {
  scan: {
    id: string;
    score: number | null;
    breakdown: ScoreBreakdown | null;
    productsScanned: number;
    issuesFound: number;
    finishedAt: Date | null;
  } | null;
  /** The three issue types worth the most points, for "start here". */
  topIssues: IssueGroup[];
  totalIssueTypes: number;
  readyFixes: number;
  appearances: number;
  totalRuns: number;
  /** Distinct brands cited across every simulation, most-cited first. */
  competitors: string[];
}

export async function loadOverview(shopId: string): Promise<OverviewData> {
  const scan = await prisma.scan.findFirst({
    where: { shopId, status: "done" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      score: true,
      scoreBreakdown: true,
      productsScanned: true,
      issuesFound: true,
      finishedAt: true,
    },
  });

  if (!scan) {
    return {
      scan: null,
      topIssues: [],
      totalIssueTypes: 0,
      readyFixes: 0,
      appearances: 0,
      totalRuns: 0,
      competitors: [],
    };
  }

  const groups = await loadIssueGroups(scan.id);
  const simulations = await prisma.simulation.findMany({
    where: { scanId: scan.id },
    select: { appearanceCount: true, runCount: true, competitors: true },
  });

  const tally = new Map<string, number>();
  for (const sim of simulations) {
    for (const name of sim.competitors) {
      tally.set(name, (tally.get(name) ?? 0) + 1);
    }
  }

  return {
    scan: {
      id: scan.id,
      score: scan.score,
      breakdown: scan.scoreBreakdown as unknown as ScoreBreakdown | null,
      productsScanned: scan.productsScanned,
      issuesFound: scan.issuesFound,
      finishedAt: scan.finishedAt,
    },
    topIssues: groups.filter((g) => g.scoreImpact > 0).slice(0, 3),
    totalIssueTypes: groups.length,
    readyFixes: groups.reduce((sum, g) => sum + g.readyFixes, 0),
    appearances: simulations.reduce((sum, s) => sum + s.appearanceCount, 0),
    totalRuns: simulations.reduce((sum, s) => sum + s.runCount, 0),
    competitors: [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name),
  };
}

// ---------------------------------------------------------------------------
// Issues (/app/issues)
// ---------------------------------------------------------------------------

/**
 * Every issue type in the latest scan, ranked by score impact.
 *
 * Reads only the issues column and a fix tally — never fix payloads — so the
 * cost is one small row per product regardless of how many fixes exist.
 */
export async function loadIssueGroups(scanId: string): Promise<IssueGroup[]> {
  const snapshots = await prisma.productSnapshot.findMany({
    where: { scanId },
    select: {
      issues: true,
      fixes: {
        where: { status: { in: ["suggested", "approved"] } },
        select: { issueCode: true },
      },
    },
  });

  return computeIssueGroups(
    snapshots.map((snapshot) => {
      const fixesByIssue: Partial<Record<IssueCode, number>> = {};
      for (const fix of snapshot.fixes) {
        if (!fix.issueCode) continue;
        const code = fix.issueCode as IssueCode;
        fixesByIssue[code] = (fixesByIssue[code] ?? 0) + 1;
      }
      return { issues: snapshot.issues as unknown as Issue[], fixesByIssue };
    }),
  );
}

/**
 * The fixable issues of the latest scan, shaped for the section navigation.
 *
 * Loaded once by the /app/issues layout and shared with both the list and the
 * review queue, so navigating between them costs no extra query.
 */
export async function loadIssueNav(shopId: string): Promise<IssueSibling[]> {
  const scanId = await latestScanId(shopId);
  if (!scanId) return [];

  return (await loadIssueGroups(scanId))
    .filter((group) => group.fixable)
    .map((group) => ({
      slug: group.slug,
      label: group.label,
      scoreImpact: group.scoreImpact,
      pending: group.readyFixes,
      current: false,
    }));
}

export async function loadIssuesScreen(shopId: string): Promise<{
  scanId: string | null;
  groups: IssueGroup[];
  passed: string[];
}> {
  const scanId = await latestScanId(shopId);
  if (!scanId) return { scanId: null, groups: [], passed: [] };

  const groups = await loadIssueGroups(scanId);
  const found = new Set(groups.map((g) => g.code));
  const passed = (Object.keys(ISSUE_DEFINITIONS) as IssueCode[])
    .filter((code) => !found.has(code))
    .map((code) => ISSUE_DEFINITIONS[code].label);

  return { scanId, groups, passed };
}

// ---------------------------------------------------------------------------
// Review queue (/app/issues/:slug)
// ---------------------------------------------------------------------------

export interface QueueItem {
  fixId: string;
  snapshotId: string;
  productTitle: string;
  /** Thumbnail of the product, when it has one. */
  imageUrl: string | null;
  type: "description" | "metafield" | "taxonomy";
  rationale: string | null;
  status: "suggested" | "approved" | "applied" | "rejected";
  error: string | null;
  /** Short plain-text preview of the change, for the card. */
  before: string;
  after: string;
  /** True when the full text was cut for the preview. */
  truncated: boolean;
}

/** How much of a change the card shows before it needs the full view. */
const PREVIEW_LENGTH = 220;

/**
 * Plain-text rendering of a fix payload.
 *
 * HTML is stripped rather than injected: these strings are model output, and
 * the card is not a place to render markup.
 */
function previewPayload(
  type: QueueItem["type"],
  payload: unknown,
): { text: string; truncated: boolean } {
  let text: string;
  if (type === "description") {
    const html = (payload as { descriptionHtml?: string }).descriptionHtml ?? "";
    text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  } else if (type === "metafield") {
    const mf = payload as { namespace?: string; key?: string; value?: string };
    text = mf.value ? `${mf.namespace}.${mf.key} = ${mf.value}` : "";
  } else {
    text = (payload as { category?: string | null }).category ?? "";
  }

  if (!text) return { text: "(empty)", truncated: false };
  return text.length > PREVIEW_LENGTH
    ? { text: `${text.slice(0, PREVIEW_LENGTH).trimEnd()}…`, truncated: true }
    : { text, truncated: false };
}

/** One entry in the switcher shown above the queue. */
export interface IssueSibling {
  slug: string;
  label: string;
  scoreImpact: number;
  /** Suggestions still awaiting a decision, so a cleared issue reads as done. */
  pending: number;
  current: boolean;
}

/** Where this issue sits among the others, so the queue can say so. */
export interface QueuePlacement {
  /** 1-based position among fixable issues, ranked by score impact. */
  position: number;
  total: number;
  scoreImpact: number;
  productCount: number;
  /** The next fixable issue to work through, if any. */
  next: { slug: string; label: string; scoreImpact: number } | null;
}

/** A suggestion the merchant already acted on. */
export interface DecidedItem {
  fixId: string;
  productTitle: string;
  imageUrl: string | null;
  /** What was written to the store, or what was turned down. */
  summary: string;
  appliedAt: string | null;
  /** Set when the write to Shopify failed and can be retried. */
  error: string | null;
}

export interface QueueData {
  scanId: string | null;
  /** Products carrying this issue that have no fix generated yet. */
  awaitingGeneration: Array<{ snapshotId: string; title: string; fixStatus: string }>;
  pending: QueueItem[];
  /** Kept as lists, not counts: a merchant needs to see what they changed. */
  applied: DecidedItem[];
  dismissed: DecidedItem[];
  placement: QueuePlacement | null;
}

export async function loadReviewQueue(
  shopId: string,
  code: IssueCode,
): Promise<QueueData> {
  const scanId = await latestScanId(shopId);
  if (!scanId) {
    return {
      scanId: null,
      awaitingGeneration: [],
      pending: [],
      applied: [],
      dismissed: [],
      placement: null,
    };
  }

  const snapshots = await prisma.productSnapshot.findMany({
    where: { scanId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      title: true,
      imageUrl: true,
      issues: true,
      fixStatus: true,
      fixes: {
        where: { issueCode: code },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          type: true,
          status: true,
          rationale: true,
          error: true,
          before: true,
          after: true,
          appliedAt: true,
        },
      },
    },
  });

  const affected = snapshots.filter((s) =>
    (s.issues as unknown as Issue[]).some((i) => i.code === code),
  );

  const pending: QueueItem[] = [];
  const applied: DecidedItem[] = [];
  const dismissed: DecidedItem[] = [];
  const awaitingGeneration: QueueData["awaitingGeneration"] = [];

  for (const snapshot of affected) {
    if (snapshot.fixes.length === 0) {
      awaitingGeneration.push({
        snapshotId: snapshot.id,
        title: snapshot.title,
        fixStatus: snapshot.fixStatus,
      });
      continue;
    }
    for (const fix of snapshot.fixes) {
      const decided = {
        fixId: fix.id,
        productTitle: snapshot.title,
        imageUrl: snapshot.imageUrl,
        summary: previewPayload(fix.type, fix.after).text,
        appliedAt: fix.appliedAt?.toISOString() ?? null,
        error: fix.error,
      };
      if (fix.status === "applied") applied.push(decided);
      else if (fix.status === "rejected") dismissed.push(decided);
      else {
        const before = previewPayload(fix.type, fix.before);
        const after = previewPayload(fix.type, fix.after);
        pending.push({
          fixId: fix.id,
          snapshotId: snapshot.id,
          productTitle: snapshot.title,
          imageUrl: snapshot.imageUrl,
          type: fix.type,
          rationale: fix.rationale,
          status: fix.status,
          error: fix.error,
          before: before.text,
          after: after.text,
          truncated: after.truncated,
        });
      }
    }
  }

  // Placement tells the merchant where this issue sits in the run and what to
  // work on next — without it, every drill-down looks like the same page.
  const groups = (await loadIssueGroups(scanId)).filter((g) => g.fixable);
  const index = groups.findIndex((g) => g.code === code);
  const self = index >= 0 ? groups[index] : null;
  const next = groups[index + 1] ?? null;

  const placement: QueuePlacement | null = self
    ? {
        position: index + 1,
        total: groups.length,
        scoreImpact: self.scoreImpact,
        productCount: self.productCount,
        next: next
          ? { slug: next.slug, label: next.label, scoreImpact: next.scoreImpact }
          : null,
      }
    : null;

  return { scanId, awaitingGeneration, pending, applied, dismissed, placement };
}

// ---------------------------------------------------------------------------
// Apply progress
// ---------------------------------------------------------------------------

export interface ApplyProgress {
  /** Fixes still queued or being written right now. */
  inFlight: number;
  applied: number;
  failed: number;
  /** The product currently being written, as far as the statuses show. */
  currentTitle: string | null;
}

/**
 * Live state of an apply run, derived from the fixes themselves.
 *
 * No separate job table: a fix is `approved` until Shopify accepts it and
 * `applied` after, so counting statuses gives real progress with nothing extra
 * to keep in sync. The first still-approved fix is the one being written.
 */
export async function loadApplyProgress(
  shopId: string,
  fixIds: string[],
): Promise<ApplyProgress> {
  if (fixIds.length === 0) {
    return { inFlight: 0, applied: 0, failed: 0, currentTitle: null };
  }

  const fixes = await prisma.fix.findMany({
    where: { id: { in: fixIds }, productSnapshot: { scan: { shopId } } },
    orderBy: { createdAt: "asc" },
    select: {
      status: true,
      error: true,
      productSnapshot: { select: { title: true } },
    },
  });

  const applied = fixes.filter((f) => f.status === "applied").length;
  const failed = fixes.filter((f) => f.status === "approved" && f.error).length;
  const pending = fixes.filter((f) => f.status === "approved" && !f.error);

  return {
    inFlight: pending.length,
    applied,
    failed,
    currentTitle: pending[0]?.productSnapshot.title ?? null,
  };
}

// ---------------------------------------------------------------------------
// AI answers (/app/answers)
// ---------------------------------------------------------------------------

export interface AnswerRow {
  id: string;
  question: string;
  appearanceCount: number;
  runCount: number;
  competitors: string[];
  /** The most relevant sentence from one of the answers, when captured. */
  excerpt: string | null;
  grounded: boolean;
  model: string;
}

export interface AnswersData {
  answers: AnswerRow[];
  appearances: number;
  totalRuns: number;
  /** Every brand cited, most frequently cited first. */
  leaderboard: Array<{ name: string; mentions: number }>;
}

/**
 * The simulations behind the visibility half of the score.
 *
 * This is the evidence screen: the exact questions asked, how often the store
 * surfaced, and who was recommended instead.
 */
export async function loadAnswers(shopId: string): Promise<AnswersData> {
  const scanId = await latestScanId(shopId);
  if (!scanId) {
    return { answers: [], appearances: 0, totalRuns: 0, leaderboard: [] };
  }

  const simulations = await prisma.simulation.findMany({
    where: { scanId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      question: true,
      appearanceCount: true,
      runCount: true,
      competitors: true,
      grounded: true,
      model: true,
      executions: true,
    },
  });

  const tally = new Map<string, number>();
  for (const sim of simulations) {
    for (const name of sim.competitors) {
      tally.set(name, (tally.get(name) ?? 0) + 1);
    }
  }

  return {
    answers: simulations.map((sim) => {
      const runs = (sim.executions as unknown as Array<{ excerpt?: string | null }>) ?? [];
      return {
        id: sim.id,
        question: sim.question,
        appearanceCount: sim.appearanceCount,
        runCount: sim.runCount,
        competitors: sim.competitors,
        excerpt: runs.find((r) => r.excerpt)?.excerpt ?? null,
        grounded: sim.grounded,
        model: sim.model,
      };
    }),
    appearances: simulations.reduce((sum, s) => sum + s.appearanceCount, 0),
    totalRuns: simulations.reduce((sum, s) => sum + s.runCount, 0),
    leaderboard: [...tally.entries()]
      .map(([name, mentions]) => ({ name, mentions }))
      .sort((a, b) => b.mentions - a.mentions),
  };
}

// ---------------------------------------------------------------------------
// Shared lifecycle
// ---------------------------------------------------------------------------

/** The latest scan of any status, plus a rescue if it is provably stuck. */
export async function loadLatestScanState(shopId: string) {
  const scan = await prisma.scan.findFirst({
    where: { shopId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      phase: true,
      error: true,
      startedAt: true,
      createdAt: true,
    },
  });
  if (!scan) return null;

  const rescued = await rescueStuckScan(scan);
  return rescued ? { ...scan, ...rescued, phase: "finished" as const } : scan;
}
