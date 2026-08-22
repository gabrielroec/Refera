/**
 * Provider-agnostic LLM contract.
 *
 * Only one provider runs at a time (MVP rule). Everything downstream — the
 * simulator, the fixer, niche detection — talks to this interface, so swapping
 * Gemini for another model is a one-line change in `./index.ts`.
 */

export interface GenerateOptions {
  prompt: string;
  system?: string;
  /**
   * Enable web-search grounding. Only meaningful for simulations: it is what
   * makes "did this store show up?" reflect reality rather than the model's
   * training data. Providers that cannot ground must fall back and report it.
   */
  grounded?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GenerateResult {
  text: string;
  /** Model identifier actually used, e.g. "gemini-3.6-flash". */
  model: string;
  /** Whether grounding was actually applied (may be false after a fallback). */
  grounded: boolean;
  /** URLs cited by the grounding step, when available. */
  sources: string[];
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;

  /** Free-form generation. */
  generate(options: GenerateOptions): Promise<GenerateResult>;

  /**
   * Generation constrained to JSON matching `schema` (a JSON Schema object).
   * Never grounded — structured extraction should not hit the web.
   */
  generateJSON<T>(
    options: Omit<GenerateOptions, "grounded"> & { schema: object },
  ): Promise<T>;
}

/** Raised when the provider fails after exhausting retries. */
export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "LLMError";
  }
}
