import {
  QUESTIONS_PER_SCAN,
  RUNS_PER_QUESTION,
  SIMULATION_TIMEOUT_MS,
} from "../lib/constants";
import { getLLM, LLMError, type LLMProvider } from "./llm";
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
  type: "object",
  properties: {
    niche: { type: "string" },
    language: { type: "string" },
  },
  required: ["niche", "language"],
} as const;

/**
 * Infers what the store actually sells, and in which language it writes.
 *
 * The language matters: a Brazilian store should be simulated with Portuguese
 * questions, because that is what its buyers would type into an assistant.
 * Classification work, so it runs on the provider's fast model.
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

  const result = await llm.generateJSON<{ niche?: string; language?: string }>({
    schema: NICHE_SCHEMA as unknown as object,
    model: llm.fastModel,
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

  return {
    niche: typeof result.niche === "string" && result.niche.trim()
      ? result.niche.trim()
      : "general retail products",
    language: typeof result.language === "string" && result.language.trim()
      ? result.language.trim()
      : "en-US",
  };
}

/** Builds the context object the simulator prompts depend on. */
export function buildStoreContext(
  domain: string,
  primaryDomain: string | null,
  name: string | null,
  niche: string | null,
  currencyCode: string | null,
  language: string | null,
  products: ScannedProduct[],
): StoreContext {
  return {
    domain,
    primaryDomain,
    name,
    niche,
    currencyCode,
    language,
    sampleTitles: products.slice(0, 10).map((p) => p.title),
  };
}

// ---------------------------------------------------------------------------
// Step 2 — generate buyer-intent questions
// ---------------------------------------------------------------------------

const QUESTIONS_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: { type: "string" },
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

  const result = await llm.generateJSON<{ questions: string[] }>({
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

  // Non-strict structured output: coerce before trusting the shape, and treat
  // an empty list as a hard error — zero questions means zero simulations,
  // which would silently produce a meaningless score.
  const questions = (Array.isArray(result.questions) ? result.questions : [])
    .filter((q): q is string => typeof q === "string" && q.trim().length > 0);
  if (questions.length === 0) {
    throw new Error("Question generation returned no usable questions");
  }
  return questions.slice(0, count);
}

// ---------------------------------------------------------------------------
// Step 3 — run a question and read the answer
// ---------------------------------------------------------------------------

const ASSISTANT_SYSTEM =
  "You are a helpful shopping assistant. Recommend specific brands, shops or products, and say where to buy them.";

/**
 * What the assistant reports about its own answer. Purely extractive and
 * store-agnostic on purpose: the model is never told which store we are
 * looking for, so it cannot be nudged into mentioning it. Whether the store
 * appeared is decided in code, from the brand list and the answer text.
 */
const GROUNDED_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "Your complete answer to the shopper, exactly as you would say it",
    },
    brands: {
      type: "array",
      items: { type: "string" },
      description:
        "Every brand, shop or retailer you named in the answer, in the order you mentioned them",
    },
    keySentence: {
      type: "string",
      description: "The single sentence from your answer that best sums up your recommendation",
    },
  },
  required: ["answer", "brands", "keySentence"],
} as const;

interface GroundedAnswer {
  answer: string;
  brands: string[];
  keySentence: string;
}

const BRANDS_ONLY_SCHEMA = {
  type: "object",
  properties: {
    brands: { type: "array", items: { type: "string" } },
    keySentence: { type: "string" },
  },
  required: ["brands", "keySentence"],
} as const;

interface AnswerRead {
  answer: string;
  brands: string[];
  /** URLs the web search actually cited — hard evidence for appearance. */
  sources: string[];
  excerpt: string | null;
  grounded: boolean;
  model: string;
}

/**
 * Asks the question and returns the answer together with the brands it named.
 *
 * Providers that can constrain a grounded answer to a schema do it in one
 * call; the others answer first and a fast, ungrounded call lists the brands.
 */
async function askAssistant(
  llm: LLMProvider,
  question: string,
): Promise<AnswerRead> {
  if (llm.supportsGroundedJSON) {
    const result = await llm.generateGroundedJSON<Partial<GroundedAnswer>>({
      prompt: question,
      schema: GROUNDED_ANSWER_SCHEMA as unknown as object,
      temperature: 0.8,
      timeoutMs: SIMULATION_TIMEOUT_MS,
      system: ASSISTANT_SYSTEM,
    });
    const answer =
      typeof result.data.answer === "string" && result.data.answer.trim()
        ? result.data.answer
        : result.text;
    return {
      answer,
      brands: coerceStrings(result.data.brands),
      sources: result.sources,
      excerpt: coerceString(result.data.keySentence),
      grounded: result.grounded,
      model: result.model,
    };
  }

  const answer = await llm.generate({
    prompt: question,
    grounded: true,
    timeoutMs: SIMULATION_TIMEOUT_MS,
    // Non-zero so repeated runs can legitimately differ — that variance is
    // exactly what "frequency" is measuring.
    temperature: 0.8,
    system: ASSISTANT_SYSTEM,
  });

  const read = await llm.generateJSON<Partial<GroundedAnswer>>({
    schema: BRANDS_ONLY_SCHEMA as unknown as object,
    model: llm.fastModel,
    temperature: 0,
    system:
      "You list the brands named in a text. Only report what is literally present. Answer only with the requested JSON.",
    prompt: `Text:
"""
${answer.text.slice(0, 6000)}
"""

Return "brands": every brand, shop or retailer named in the text, in order of appearance, and "keySentence": the single most relevant sentence, verbatim.`,
  });

  return {
    answer: answer.text,
    brands: coerceStrings(read.brands),
    sources: answer.sources,
    excerpt: coerceString(read.keySentence),
    grounded: answer.grounded,
    model: answer.model,
  };
}

function coerceStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
}

function coerceString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : null;
}

// ---------------------------------------------------------------------------
// Appearance detection (deterministic)
// ---------------------------------------------------------------------------

/**
 * Lowercases, strips accents and collapses everything that is not a letter or
 * digit — in any script. Unicode-aware on purpose: an ASCII-only normaliser
 * would erase CJK/Cyrillic/Arabic store names entirely and make them
 * unmatchable forever.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Suffix words that carry no identity: assistants say "Refera", not
 * "Refera Store", so the distinctive part of the name must also be an alias.
 */
const GENERIC_NAME_WORDS = new Set([
  "store", "shop", "shopping", "boutique", "official", "oficial",
  "loja", "tienda", "co", "company", "inc", "llc", "ltd", "ltda",
  "brand", "brasil", "brazil", "online",
]);

/**
 * Names the store can be recognised by: display name, the name minus generic
 * suffix words, the myshopify slug, and the real storefront host with its
 * distinctive label. Product vendors are deliberately not aliases — a store
 * reselling Burton is not "appearing" when Burton is recommended.
 */
function storeAliases(store: StoreContext): string[] {
  const aliases = new Set<string>();

  const addName = (raw: string) => {
    const name = normalise(raw);
    // Very short names ("Co", "Shop") would match everything.
    if (name.length >= 4) aliases.add(name);
  };

  const addHost = (host: string) => {
    const lower = host.toLowerCase().replace(/^www\./, "");
    aliases.add(lower);
    // The registrable label ("lojadamaria" from lojadamaria.com.br) is how a
    // model cites a store without writing the full URL — with and without
    // hyphens, since models write both "loja-da-maria" and "LojaDaMaria".
    const label = lower.split(".")[0];
    if (label.length >= 4) {
      aliases.add(label);
      aliases.add(label.replace(/-/g, ""));
    }
  };

  addHost(store.domain);
  aliases.add(store.domain.toLowerCase().replace(/\.myshopify\.com$/, ""));
  if (store.primaryDomain) addHost(store.primaryDomain);

  if (store.name) {
    const distinctive = normalise(store.name)
      .split(" ")
      .filter(Boolean)
      .filter((w) => !GENERIC_NAME_WORDS.has(w));
    // A name made entirely of generic words ("Store", "Loja Online") gets no
    // name alias at all — it would match every answer; the domain still
    // identifies the store.
    if (distinctive.length > 0) {
      addName(store.name);
      addName(distinctive.join(" "));
      // Concatenated form: assistants write "LojaDaMaria" as one token.
      addName(distinctive.join(""));
    }
  }

  return [...aliases].filter(Boolean);
}

function mentions(haystack: string, alias: string): boolean {
  const h = ` ${normalise(haystack)} `;
  const a = ` ${normalise(alias)} `;
  return a.trim().length > 0 && h.includes(a);
}

export interface Appearance {
  appeared: boolean;
  position: number | null;
  competitors: string[];
}

/**
 * Decides whether the store showed up, from the answer text, the brands the
 * assistant listed, and the URLs the web search actually cited. Pure and
 * LLM-free, so the measurement cannot be nudged and is unit-testable.
 */
export function detectAppearance(
  answer: string,
  brands: string[],
  sources: string[],
  store: StoreContext,
): Appearance {
  const aliases = storeAliases(store);
  const isStore = (brand: string) => aliases.some((a) => mentions(brand, a));

  const storeHosts = [store.domain, store.primaryDomain]
    .filter((h): h is string => Boolean(h))
    .map((h) => h.toLowerCase().replace(/^www\./, ""));
  const citedStore = sources.some((url) => {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      return storeHosts.some((h) => host === h || host.endsWith(`.${h}`));
    } catch {
      return false;
    }
  });

  const firstIndex = brands.findIndex(isStore);
  const inText = aliases.some((a) => mentions(answer, a));

  const competitors = [...new Set(brands.filter((b) => !isStore(b)).map((b) => b.trim()))];

  return {
    appeared: firstIndex >= 0 || inText || citedStore,
    position: firstIndex >= 0 ? firstIndex + 1 : null,
    competitors,
  };
}

// ---------------------------------------------------------------------------
// Step 4 — run a question N times
// ---------------------------------------------------------------------------

async function runOnce(
  llm: LLMProvider,
  question: string,
  store: StoreContext,
  run: number,
): Promise<{ execution: SimulationExecution; grounded: boolean; model: string }> {
  try {
    const read = await askAssistant(llm, question);
    const appearance = detectAppearance(read.answer, read.brands, read.sources, store);
    return {
      execution: {
        run,
        appeared: appearance.appeared,
        position: appearance.position,
        competitors: appearance.competitors,
        excerpt: read.excerpt,
      },
      grounded: read.grounded,
      model: read.model,
    };
  } catch (error) {
    // One failed run must not sink the whole simulation; record it and move
    // on so the scan still produces a score.
    return {
      execution: {
        run,
        appeared: false,
        position: null,
        competitors: [],
        excerpt: null,
        error: error instanceof LLMError ? error.message : String(error),
      },
      grounded: false,
      model: llm.model,
    };
  }
}

/**
 * Executes one question `runs` times, concurrently, to measure frequency
 * rather than mere presence. The runs are independent, so the question
 * costs one call's latency, not the sum.
 */
export async function runSimulation(
  question: string,
  store: StoreContext,
  runs: number = RUNS_PER_QUESTION,
): Promise<SimulationResult> {
  const llm = getLLM();

  const results = await Promise.all(
    Array.from({ length: runs }, (_, i) => runOnce(llm, question, store, i + 1)),
  );

  const executions = results.map((r) => r.execution);
  const competitors = [...new Set(executions.flatMap((e) => e.competitors))];

  return {
    question,
    model: results.find((r) => !r.execution.error)?.model ?? llm.model,
    grounded: results.some((r) => r.grounded),
    executions,
    appearanceCount: executions.filter((e) => e.appeared).length,
    runCount: executions.length,
    competitors,
  };
}
