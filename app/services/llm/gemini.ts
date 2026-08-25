import {
  LLMError,
  type GenerateOptions,
  type GenerateResult,
  type GroundedJSONResult,
  type LLMProvider,
} from "./provider";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Free tier throws 429 readily; back off and retry rather than failing a scan. */
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_500;
/**
 * The free tier caps requests per minute (currently 20 RPM), so a 429 without
 * a parseable retry hint still needs to wait out a meaningful slice of that
 * one-minute window — exponential backoff in single-digit seconds never
 * recovers.
 */
const RATE_LIMIT_FALLBACK_MS = 30_000;

/** Default ceiling per request; see the OpenAI provider for the rationale. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Google 429s tell you exactly how long to wait, both as a structured
 * RetryInfo detail ("retryDelay": "20.5s") and in the message ("Please retry
 * in 20.5s"). Honouring it beats guessing.
 */
function parseRetryDelayMs(error: {
  message?: string;
  details?: Array<{ ["@type"]?: string; retryDelay?: string }>;
}): number | null {
  const structured = error.details?.find((d) => d.retryDelay)?.retryDelay;
  const fromMessage = error.message?.match(/retry in ([0-9.]+)s/i)?.[1];
  const seconds = parseFloat(structured ?? fromMessage ?? "");
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
  promptFeedback?: { blockReason?: string };
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ ["@type"]?: string; retryDelay?: string }>;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Concatenates the visible text parts of a candidate.
 *
 * Gemini 3.x interleaves reasoning parts (`thought: true`) with the answer;
 * including them would poison both the simulated answer and JSON parsing.
 */
function extractText(response: GeminiResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => p.thought !== true && typeof p.text === "string")
    .map((p) => p.text!.trim())
    .join("\n")
    .trim();
}

function extractSources(response: GeminiResponse): string[] {
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const uris = chunks
    .map((c) => c.web?.uri)
    .filter((u): u is string => Boolean(u));
  return [...new Set(uris)];
}

/** Strips ```json fences some models still emit despite responseMimeType. */
function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Converts a standard JSON Schema into Gemini's OpenAPI-flavoured dialect.
 *
 * Services declare schemas in standard JSON Schema (lowercase types) so every
 * provider can consume them; Gemini is the odd one out, wanting uppercase type
 * enums, `nullable` instead of `["x","null"]` unions, and no `additionalProperties`.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== "object") return schema;

  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === "additionalProperties" || key === "$schema") continue;

    if (key === "type") {
      if (Array.isArray(value)) {
        const nonNull = value.filter((t) => t !== "null");
        out.type = String(nonNull[0] ?? "string").toUpperCase();
        if (value.includes("null")) out.nullable = true;
      } else {
        out.type = String(value).toUpperCase();
      }
      continue;
    }

    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          toGeminiSchema(v),
        ]),
      );
      continue;
    }

    if (key === "items") {
      out.items = toGeminiSchema(value);
      continue;
    }

    out[key] = value;
  }

  return out;
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  /**
   * Gemini cannot combine google_search with a response schema in one call,
   * so callers ground first and extract in a second, ungrounded call.
   */
  readonly supportsGroundedJSON = false;
  readonly fastModel: string;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    /** Global default; individual calls can still opt out. */
    private readonly groundingEnabled: boolean,
    fastModel?: string,
  ) {
    if (!apiKey) {
      throw new LLMError("GEMINI_API_KEY is not set");
    }
    this.fastModel = fastModel || model;
  }

  async generateGroundedJSON<T>(): Promise<GroundedJSONResult<T>> {
    throw new LLMError(
      "Gemini does not support grounded structured output; check supportsGroundedJSON first",
    );
  }

  private async call(
    body: Record<string, unknown>,
    model: string = this.model,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<GeminiResponse> {
    let lastError: LLMError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(
          `${API_BASE}/models/${model}:generateContent`,
          {
            method: "POST",
            headers: {
              "x-goog-api-key": this.apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
      } catch (cause) {
        const timedOut = cause instanceof Error && cause.name === "TimeoutError";
        lastError = new LLMError(
          timedOut
            ? `Gemini call exceeded ${Math.round(timeoutMs / 1000)}s`
            : `Network error: ${String(cause)}`,
          undefined,
          !timedOut,
        );
        if (timedOut) throw lastError;
        await sleep(BASE_BACKOFF_MS * attempt);
        continue;
      }

      const json = (await response.json().catch(() => ({}))) as GeminiResponse;

      if (response.ok) return json;

      const retryable = response.status === 429 || response.status >= 500;
      lastError = new LLMError(
        json.error?.message ?? `Gemini returned ${response.status}`,
        response.status,
        retryable,
      );

      if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;

      if (response.status === 429) {
        // Wait as long as Google asks (plus a beat, capped), or a big slice
        // of the per-minute window when it does not say.
        const hinted = json.error ? parseRetryDelayMs(json.error) : null;
        await sleep(Math.min(hinted ?? RATE_LIMIT_FALLBACK_MS, 120_000) + 1_000);
      } else {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }

    throw lastError ?? new LLMError("Gemini call failed");
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const wantsGrounding = (options.grounded ?? false) && this.groundingEnabled;

    const build = (grounded: boolean) => ({
      contents: [{ role: "user", parts: [{ text: options.prompt }] }],
      ...(options.system
        ? { systemInstruction: { parts: [{ text: options.system }] } }
        : {}),
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        ...(options.maxOutputTokens
          ? { maxOutputTokens: options.maxOutputTokens }
          : {}),
      },
      ...(grounded ? { tools: [{ google_search: {} }] } : {}),
    });

    let grounded = wantsGrounding;
    let response: GeminiResponse;

    try {
      response = await this.call(build(grounded), options.model, options.timeoutMs);
    } catch (error) {
      // Grounding has its own free-tier quota. If it is exhausted the scan
      // should degrade to ungrounded rather than die — the run is still
      // recorded, just flagged `grounded: false`.
      if (grounded && error instanceof LLMError) {
        grounded = false;
        response = await this.call(build(false), options.model, options.timeoutMs);
      } else {
        throw error;
      }
    }

    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      throw new LLMError(`Gemini blocked the prompt: ${blockReason}`);
    }

    const text = extractText(response);
    if (!text) {
      // An empty answer must not flow downstream as a legitimate "store did
      // not appear" run.
      const reason = response.candidates?.[0]?.finishReason;
      throw new LLMError(
        `Gemini returned an empty response${reason ? ` (${reason})` : ""}`,
      );
    }

    return {
      text,
      model: options.model || this.model,
      // Request flag alone is not proof: Gemini can accept the tool and answer
      // from memory. groundingMetadata is only present when search really ran.
      grounded:
        grounded && response.candidates?.[0]?.groundingMetadata != null,
      sources: extractSources(response),
    };
  }

  async generateJSON<T>(
    options: Omit<GenerateOptions, "grounded"> & { schema: object },
  ): Promise<T> {
    const body = {
      contents: [{ role: "user", parts: [{ text: options.prompt }] }],
      ...(options.system
        ? { systemInstruction: { parts: [{ text: options.system }] } }
        : {}),
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(options.schema),
        ...(options.maxOutputTokens
          ? { maxOutputTokens: options.maxOutputTokens }
          : {}),
      },
    };

    // One bounded retry on malformed output: an empty candidate (thought
    // parts eating the budget) or truncated JSON is transient, and a single
    // bad response must not fail a whole scan phase.
    let lastError: LLMError | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await this.call(body, options.model, options.timeoutMs);
      const text = extractText(response);
      if (!text) {
        lastError = new LLMError("Gemini returned an empty JSON response");
        continue;
      }
      try {
        return JSON.parse(stripFences(text)) as T;
      } catch {
        lastError = new LLMError(
          `Gemini returned unparseable JSON: ${text.slice(0, 200)}`,
        );
      }
    }
    throw lastError ?? new LLMError("Gemini JSON generation failed");
  }
}
