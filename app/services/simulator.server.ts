import { QUESTIONS_PER_SCAN, RUNS_PER_QUESTION } from "../lib/constants";
import { getLLM, LLMError } from "./llm";
import type {
  ScannedProduct,
  SimulationExecution,
  SimulationResult,
  StoreContext,
} from "../types";

// ---------------------------------------------------------------------------
// Step 1 — understand the store
// ---------------------------------------------------------------------------

const NICHE_SCHEMA = {
  type: "OBJECT",
  properties: {
    niche: { type: "STRING" },
    language: { type: "STRING" },
  },
  required: ["niche", "language"],
} as const;

/**
 * Infers what the store actually sells, and in which language it writes.
 *
 * The language matters: a Brazilian store should be simulated with Portuguese
 * questions, because that is what its buyers would type into an assistant.
 */
export async function detectNiche(
  products: ScannedProduct[],
  shopName: string | null,
): Promise<{ niche: string; language: string }> {
  const llm = getLLM();
  const sample = products
    .slice(0, 30)
    .map((p) => `- ${p.title}${p.productType ? ` (${p.productType})` : ""}`)
    .join("\n");

  return llm.generateJSON<{ niche: string; language: string }>({
    schema: NICHE_SCHEMA as unknown as object,
    temperature: 0.1,
    system:
      "You classify e-commerce catalogues. Answer only with the requested JSON.",
    prompt: `Store name: ${shopName ?? "unknown"}

Product titles:
${sample}

Return:
- "niche": one short English phrase describing what this store sells, specific enough to write buyer questions for (e.g. "handmade leather bags for women", not "retail").
- "language": the BCP-47 tag of the language the product titles are written in (e.g. "pt-BR", "en-US").`,
  });
}

// ---------------------------------------------------------------------------
// Step 2 — generate buyer-intent questions
// ---------------------------------------------------------------------------

const QUESTIONS_SCHEMA = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: { type: "STRING" },
    },
  },
  required: ["questions"],
} as const;

/**
 * Writes the questions a real shopper would ask an AI assistant.
 *
 * Deliberately does NOT mention the store: the whole point is to find out
 * whether the store surfaces unprompted.
 */
export async function generateQuestions(
  store: StoreContext,
  count: number = QUESTIONS_PER_SCAN,
): Promise<string[]> {
  const llm = getLLM();

  const { questions } = await llm.generateJSON<{ questions: string[] }>({
    schema: QUESTIONS_SCHEMA as unknown as object,
    temperature: 0.9,
    system:
      "You simulate how real shoppers talk to AI assistants. Answer only with the requested JSON.",
    prompt: `A store sells: ${store.niche}
Sample products: ${store.sampleTitles.slice(0, 10).join("; ")}
Currency: ${store.currencyCode ?? "USD"}
Write the questions in this language: ${store.language ?? "en-US"}

Write exactly ${count} distinct questions a shopper would type into ChatGPT or Gemini when looking to BUY something in this category.

Rules:
- Never mention the store's name or domain. We are testing whether it appears on its own.
- Mix intents: budget-bounded ("best X under <price> in ${store.currencyCode ?? "USD"}"), comparison, use-case specific, and "where do I buy".
- Make them sound like a person typing, not a search query.
- Each question must be answerable by recommending specific brands or shops.`,
  });

  return questions.slice(0, count);
}

// ---------------------------------------------------------------------------
// Step 3 — run a question and analyse the answer
// ---------------------------------------------------------------------------

const ANALYSIS_SCHEMA = {
  type: "OBJECT",
  properties: {
    appeared: { type: "BOOLEAN" },
    position: { type: "INTEGER" },
    competitors: { type: "ARRAY", items: { type: "STRING" } },
    excerpt: { type: "STRING" },
  },
  required: ["appeared", "competitors", "excerpt"],
} as const;

interface RawAnalysis {
  appeared: boolean;
  position?: number;
  competitors: string[];
  excerpt: string;
}

/**
 * Reads a simulated answer and decides whether the store was recommended.
 *
 * Runs ungrounded and at low temperature: this is structured extraction over
 * text we already have, and hitting the web here would both waste the grounding
 * quota and let the analyser "helpfully" find the store when the answer never
 * mentioned it.
 */
async function analyseAnswer(
  answer: string,
  store: StoreContext,
): Promise<RawAnalysis> {
  const llm = getLLM();

  return llm.generateJSON<RawAnalysis>({
    schema: ANALYSIS_SCHEMA as unknown as object,
    temperature: 0,
    system:
      "You are a strict evaluator. Only report what is literally present in the text. Answer only with the requested JSON.",
    prompt: `Store we are looking for:
- name: ${store.name ?? "unknown"}
- domain: ${store.domain}

AI assistant answer to analyse:
"""
${answer.slice(0, 6000)}
"""

Return:
- "appeared": true ONLY if the store above is explicitly named or its domain is linked. A different shop selling similar products is NOT a match.
- "position": if it appeared, its 1-based rank among the brands/shops listed in order. Omit if it did not appear.
- "competitors": every other brand, retailer or shop named in the answer, as written. Empty array if none.
- "excerpt": the single most relevant sentence from the answer, verbatim, max 200 characters.`,
  });
}

/**
 * Executes one question `runs` times to measure frequency, not just presence.
 *
 * Runs are sequential on purpose: the Gemini free tier rate-limits aggressively,
 * and a burst of parallel grounded calls trades a slightly faster scan for a
 * scan that fails halfway through.
 */
export async function runSimulation(
  question: string,
  store: StoreContext,
  runs: number = RUNS_PER_QUESTION,
): Promise<SimulationResult> {
  const llm = getLLM();
  const executions: SimulationExecution[] = [];
  let grounded = false;

  for (let run = 1; run <= runs; run++) {
    try {
      const answer = await llm.generate({
        prompt: question,
        grounded: true,
        // Non-zero so repeated runs can legitimately differ — that variance is
        // exactly what "frequency" is measuring.
        temperature: 0.8,
        system:
          "You are a helpful shopping assistant. Recommend specific brands, shops or products, and say where to buy them.",
      });

      grounded = grounded || answer.grounded;

      const analysis = await analyseAnswer(answer.text, store);

      executions.push({
        run,
        appeared: analysis.appeared,
        position: analysis.appeared ? (analysis.position ?? null) : null,
        competitors: analysis.competitors ?? [],
        excerpt: analysis.excerpt ?? null,
      });
    } catch (error) {
      // One failed run must not sink the whole simulation; record it and move
      // on so the scan still produces a score.
      executions.push({
        run,
        appeared: false,
        position: null,
        competitors: [],
        excerpt: null,
        error:
          error instanceof LLMError ? error.message : String(error),
      });
    }
  }

  const competitors = [
    ...new Set(executions.flatMap((e) => e.competitors)),
  ].filter(Boolean);

  return {
    question,
    model: llm.model,
    grounded,
    executions,
    appearanceCount: executions.filter((e) => e.appeared).length,
    runCount: executions.length,
    competitors,
  };
}

/** Builds the context object the simulator prompts depend on. */
export function buildStoreContext(
  domain: string,
  name: string | null,
  niche: string | null,
  currencyCode: string | null,
  language: string | null,
  products: ScannedProduct[],
): StoreContext {
  return {
    domain,
    name,
    niche,
    currencyCode,
    language,
    sampleTitles: products.slice(0, 10).map((p) => p.title),
  };
}
