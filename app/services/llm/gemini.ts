import {
  LLMError,
  type GenerateOptions,
  type GenerateResult,
  type LLMProvider,
} from "./provider";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Free tier throws 429 readily; back off and retry rather than failing a scan. */
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1_500;

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
  error?: { code?: number; message?: string; status?: string };
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

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    /** Global default; individual calls can still opt out. */
    private readonly groundingEnabled: boolean,
  ) {
    if (!apiKey) {
      throw new LLMError("GEMINI_API_KEY is not set");
    }
  }

  private async call(
    body: Record<string, unknown>,
  ): Promise<GeminiResponse> {
    let lastError: LLMError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(
          `${API_BASE}/models/${this.model}:generateContent`,
          {
            method: "POST",
            headers: {
              "x-goog-api-key": this.apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          },
        );
      } catch (cause) {
        // Network-level failure — always worth another try.
        lastError = new LLMError(`Network error: ${String(cause)}`, undefined, true);
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

      if (!retryable) throw lastError;
      // Exponential-ish backoff; free-tier 429s usually clear within seconds.
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
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
      response = await this.call(build(grounded));
    } catch (error) {
      // Grounding has its own free-tier quota. If it is exhausted the scan
      // should degrade to ungrounded rather than die — the run is still
      // recorded, just flagged `grounded: false`.
      if (grounded && error instanceof LLMError) {
        grounded = false;
        response = await this.call(build(false));
      } else {
        throw error;
      }
    }

    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      throw new LLMError(`Gemini blocked the prompt: ${blockReason}`);
    }

    return {
      text: extractText(response),
      model: this.model,
      grounded,
      sources: extractSources(response),
    };
  }

  async generateJSON<T>(
    options: Omit<GenerateOptions, "grounded"> & { schema: object },
  ): Promise<T> {
    const response = await this.call({
      contents: [{ role: "user", parts: [{ text: options.prompt }] }],
      ...(options.system
        ? { systemInstruction: { parts: [{ text: options.system }] } }
        : {}),
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        responseMimeType: "application/json",
        responseSchema: options.schema,
        ...(options.maxOutputTokens
          ? { maxOutputTokens: options.maxOutputTokens }
          : {}),
      },
    });

    const text = extractText(response);
    if (!text) {
      throw new LLMError("Gemini returned an empty JSON response");
    }

    try {
      return JSON.parse(stripFences(text)) as T;
    } catch {
      throw new LLMError(`Gemini returned unparseable JSON: ${text.slice(0, 200)}`);
    }
  }
}
