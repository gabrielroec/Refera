import { GeminiProvider } from "./gemini";
import type { LLMProvider } from "./provider";

export * from "./provider";

let cached: LLMProvider | null = null;

/**
 * Returns the single configured LLM provider.
 *
 * MVP rule: exactly one provider runs at a time. To swap models, change
 * GEMINI_MODEL; to swap vendors, add a branch here — nothing else in the
 * codebase imports a concrete provider.
 */
export function getLLM(): LLMProvider {
  if (cached) return cached;

  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const apiKey = process.env.GEMINI_API_KEY || "";
  // Grounding is what makes simulations reflect the real web; default on.
  const grounding = (process.env.GEMINI_GROUNDING ?? "true") !== "false";

  cached = new GeminiProvider(model, apiKey, grounding);
  return cached;
}
