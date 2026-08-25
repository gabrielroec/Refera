import {
  LLMError,
  type GenerateOptions,
  type GenerateResult,
  type GroundedJSONResult,
  type LLMProvider,
} from "./provider";

/**
 * web_search tool config. "low" context size trims how much retrieved page
 * content the model ingests per call — fewer seconds and tokens, and for a
 * "what would a shopper be told" simulation the headline results are what
 * matter, not deep page text.
 */
const WEB_SEARCH_TOOL = { type: "web_search", search_context_size: "low" };

const API_BASE = "https://api.openai.com/v1";

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2_000;

/**
 * Default ceiling per request. Grounded answers usually land in 10-20s, but
 * the tail reaches minutes; a scan phase ends when its slowest call does, so
 * an outlier is worth abandoning rather than waiting out.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Reasoning-family models (gpt-5*, o*) reject a custom `temperature` and take
 * a `reasoning.effort` knob instead. Everything else is a classic sampler.
 */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model);
}

// ---------------------------------------------------------------------------
// Responses API shapes (the subset we read)
// ---------------------------------------------------------------------------

interface ResponsesOutputText {
  type: "output_text";
  text: string;
  annotations?: Array<{ type?: string; url?: string }>;
}

interface ResponsesOutputItem {
  type: string; // "message" | "web_search_call" | "reasoning" | ...
  content?: Array<ResponsesOutputText | { type: string; refusal?: string }>;
  status?: string;
}

interface ResponsesResult {
  status?: string; // "completed" | "incomplete" | "failed"
  output?: ResponsesOutputItem[];
  incomplete_details?: { reason?: string };
  error?: { code?: string; message?: string } | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function collectText(result: ResponsesResult): string {
  const parts: string[] = [];
  for (const item of result.output ?? []) {
    if (item.type !== "message") continue;
    for (const piece of item.content ?? []) {
      if (piece.type === "output_text") {
        parts.push((piece as ResponsesOutputText).text);
      }
    }
  }
  return parts.join("\n").trim();
}

function collectSources(result: ResponsesResult): string[] {
  const urls: string[] = [];
  for (const item of result.output ?? []) {
    if (item.type !== "message") continue;
    for (const piece of item.content ?? []) {
      if (piece.type !== "output_text") continue;
      for (const a of (piece as ResponsesOutputText).annotations ?? []) {
        if (a.type === "url_citation" && a.url) urls.push(a.url);
      }
    }
  }
  return [...new Set(urls)];
}

function usedWebSearch(result: ResponsesResult): boolean {
  return (result.output ?? []).some((item) => item.type === "web_search_call");
}

function collectRefusal(result: ResponsesResult): string | null {
  for (const item of result.output ?? []) {
    if (item.type !== "message") continue;
    for (const piece of item.content ?? []) {
      if (piece.type === "refusal") {
        return (piece as { refusal?: string }).refusal ?? "refused";
      }
    }
  }
  return null;
}

/**
 * A degraded response (refusal, truncation, empty text) must surface as an
 * error, not as empty text — downstream, an empty simulated answer would be
 * scored as a legitimate "store did not appear" run.
 */
function assertUsable(result: ResponsesResult, text: string): void {
  const refusal = collectRefusal(result);
  if (refusal) throw new LLMError(`OpenAI refused the prompt: ${refusal}`);
  if (result.status && result.status !== "completed") {
    throw new LLMError(
      `OpenAI response ${result.status}${
        result.incomplete_details?.reason
          ? ` (${result.incomplete_details.reason})`
          : ""
      }`,
    );
  }
  if (!text) throw new LLMError("OpenAI returned an empty response");
}

/** Strips ```json fences a model may emit despite the schema constraint. */
function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly supportsGroundedJSON = true;
  readonly fastModel: string;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    /** Global default for simulations; individual calls can still opt out. */
    private readonly groundingEnabled: boolean,
    fastModel?: string,
  ) {
    if (!apiKey) {
      throw new LLMError("OPENAI_API_KEY is not set");
    }
    this.fastModel = fastModel || model;
  }

  private async call(
    body: Record<string, unknown>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<ResponsesResult> {
    let lastError: LLMError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${API_BASE}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        const timedOut = cause instanceof Error && cause.name === "TimeoutError";
        lastError = new LLMError(
          timedOut
            ? `OpenAI call exceeded ${Math.round(timeoutMs / 1000)}s`
            : `Network error: ${String(cause)}`,
          undefined,
          // A retry of a timed-out grounded call usually times out too, and
          // the run is already recorded as an error either way.
          !timedOut,
        );
        if (timedOut) throw lastError;
        await sleep(BASE_BACKOFF_MS * attempt);
        continue;
      }

      const json = (await response.json().catch(() => ({}))) as ResponsesResult & {
        error?: { message?: string };
      };

      if (response.ok) {
        if (json.status === "failed" || json.error) {
          throw new LLMError(
            `OpenAI response failed: ${json.error?.message ?? "unknown error"}`,
          );
        }
        return json;
      }

      const retryable = response.status === 429 || response.status >= 500;
      lastError = new LLMError(
        json.error?.message ?? `OpenAI returned ${response.status}`,
        response.status,
        retryable,
      );
      if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;

      // Paid-tier 429s clear fast; honour Retry-After when present, but cap
      // it — an hour-long server hint would hold the worker hostage.
      const retryAfter = parseFloat(response.headers.get("retry-after") ?? "");
      const waitMs = Number.isFinite(retryAfter)
        ? Math.min(retryAfter * 1000, 120_000) + 500
        : BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(waitMs);
    }

    throw lastError ?? new LLMError("OpenAI call failed");
  }

  private baseBody(options: {
    prompt: string;
    system?: string;
    temperature?: number;
    maxOutputTokens?: number;
    model?: string;
  }): Record<string, unknown> {
    const model = options.model || this.model;
    return {
      model,
      input: options.prompt,
      ...(options.system ? { instructions: options.system } : {}),
      ...(isReasoningModel(model)
        ? // Low effort: these are retrieval/extraction/copywriting calls, not
          // maths — and effort dominates both latency and cost here.
          { reasoning: { effort: "low" } }
        : options.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
      ...(options.maxOutputTokens
        ? { max_output_tokens: options.maxOutputTokens }
        : {}),
    };
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const wantsGrounding = (options.grounded ?? false) && this.groundingEnabled;

    const build = (grounded: boolean) => ({
      ...this.baseBody(options),
      ...(grounded ? { tools: [WEB_SEARCH_TOOL] } : {}),
    });

    let grounded = wantsGrounding;
    let result: ResponsesResult;
    try {
      result = await this.call(build(grounded), options.timeoutMs);
    } catch (error) {
      // web_search may be unavailable for a model/account; degrade to
      // ungrounded rather than failing the scan, mirroring the Gemini path.
      if (grounded && error instanceof LLMError && !error.retryable) {
        grounded = false;
        result = await this.call(build(false), options.timeoutMs);
      } else {
        throw error;
      }
    }

    const text = collectText(result);
    assertUsable(result, text);

    return {
      text,
      model: options.model || this.model,
      grounded: grounded && usedWebSearch(result),
      sources: collectSources(result),
    };
  }

  async generateGroundedJSON<T>(
    options: Omit<GenerateOptions, "grounded"> & { schema: object },
  ): Promise<GroundedJSONResult<T>> {
    const format = {
      type: "json_schema",
      name: "result",
      strict: false,
      schema: options.schema,
    };
    const build = (grounded: boolean) => ({
      ...this.baseBody(options),
      text: { format },
      ...(grounded ? { tools: [WEB_SEARCH_TOOL] } : {}),
    });

    let grounded = this.groundingEnabled;
    let result: ResponsesResult;
    try {
      result = await this.call(build(grounded), options.timeoutMs);
    } catch (error) {
      if (grounded && error instanceof LLMError && !error.retryable) {
        grounded = false;
        result = await this.call(build(false), options.timeoutMs);
      } else {
        throw error;
      }
    }

    const text = collectText(result);
    assertUsable(result, text);

    let data: T;
    try {
      data = JSON.parse(stripFences(text)) as T;
    } catch {
      throw new LLMError(
        `OpenAI returned unparseable grounded JSON: ${text.slice(0, 200)}`,
      );
    }

    return {
      text,
      data,
      model: options.model || this.model,
      grounded: grounded && usedWebSearch(result),
      sources: collectSources(result),
    };
  }

  async generateJSON<T>(
    options: Omit<GenerateOptions, "grounded"> & { schema: object },
  ): Promise<T> {
    const body = {
      ...this.baseBody(options),
      text: {
        format: {
          type: "json_schema",
          name: "result",
          // Non-strict: our schemas use optional fields, which strict mode
          // (all-required + additionalProperties:false) would reject. The
          // price is that conformance is best-effort — callers must treat
          // fields defensively, and we retry once on malformed output.
          strict: false,
          schema: options.schema,
        },
      },
    };

    let lastError: LLMError | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await this.call(body, options.timeoutMs);
      const text = collectText(result);

      if (!text) {
        lastError = new LLMError(
          `OpenAI returned an empty JSON response (status: ${result.status ?? "?"}${
            result.incomplete_details?.reason
              ? `, reason: ${result.incomplete_details.reason}`
              : ""
          })`,
        );
        continue;
      }

      try {
        return JSON.parse(stripFences(text)) as T;
      } catch {
        lastError = new LLMError(
          `OpenAI returned unparseable JSON: ${text.slice(0, 200)}`,
        );
      }
    }
    throw lastError ?? new LLMError("OpenAI JSON generation failed");
  }
}
