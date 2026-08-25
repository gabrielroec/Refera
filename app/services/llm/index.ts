import { GeminiProvider } from "./gemini";
import { OpenAIProvider } from "./openai";
import type { LLMProvider } from "./provider";

export * from "./provider";

let cached: LLMProvider | null = null;

/**
 * Returns the single configured LLM provider.
 *
 * MVP rule: exactly one provider runs at a time, selected by LLM_PROVIDER.
 * Schemas passed to generateJSON are standard JSON Schema; each provider
 * adapts them to its own dialect internally.
 */
export function getLLM(): LLMProvider {
  if (cached) return cached;

  const provider = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
  // Grounding (web search) is what makes simulations reflect the real web.
  const grounding = (process.env.LLM_GROUNDING ?? process.env.GEMINI_GROUNDING ?? "true") !== "false";

  // The "fast" sibling handles extraction/classification: same family, a
  // fraction of the latency and price, and on OpenAI a separate rate-limit
  // bucket — so analysis calls never compete with simulations for quota.
  if (provider === "openai") {
    cached = new OpenAIProvider(
      process.env.OPENAI_MODEL || "gpt-5-mini",
      process.env.OPENAI_API_KEY || "",
      grounding,
      process.env.OPENAI_FAST_MODEL || "gpt-5-nano",
    );
  } else {
    cached = new GeminiProvider(
      process.env.GEMINI_MODEL || "gemini-3.6-flash",
      process.env.GEMINI_API_KEY || "",
      grounding,
      process.env.GEMINI_FAST_MODEL,
    );
  }
  return cached;
}
