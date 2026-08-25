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
  /**
   * Per-call model override. Lets cheap extraction/classification calls run
   * on a smaller, faster model while generation stays on the default.
   */
  model?: string;
  /**
   * Abort the call after this many milliseconds. Web-grounded generation has a
   * long tail — a single stuck request would otherwise hold up a whole scan
   * phase, since the phase finishes only when its slowest call does.
   */
  timeoutMs?: number;
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

/** A grounded answer that also carries a structured extraction of itself. */
export interface GroundedJSONResult<T> extends GenerateResult {
  data: T;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  /**
   * Model used when a caller asks for the `fast` tier (extraction,
   * classification). Falls back to `model` when the provider has no cheaper
   * sibling configured.
   */
  readonly fastModel: string;

  /**
   * Whether `generateGroundedJSON` is available. When false, callers must
   * ground first and extract in a second ungrounded call.
   */
  readonly supportsGroundedJSON: boolean;

  /** Free-form generation. */
  generate(options: GenerateOptions): Promise<GenerateResult>;

  /**
   * Generation constrained to JSON matching `schema` (a JSON Schema object).
   * Never grounded — structured extraction should not hit the web.
   */
  generateJSON<T>(
    options: Omit<GenerateOptions, "grounded"> & { schema: object },
  ): Promise<T>;

  /**
   * Web-grounded generation whose output is ALSO constrained to `schema`.
   * Lets one call both answer a shopper's question and report, structurally,
   * what it said — removing a whole extraction round-trip.
   */
  generateGroundedJSON<T>(
    options: Omit<GenerateOptions, "grounded"> & { schema: object },
  ): Promise<GroundedJSONResult<T>>;
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
