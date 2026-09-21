/**
 * DeepSeek JSON-completion client — ported near-verbatim from agent-pulse's
 * `src/ai/deepseek.ts` (MIT licensed). Invalid JSON completions share the
 * bounded retry/backoff budget used for transient request failures.
 */

import { z } from "zod";

export interface JsonCompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface JsonCompletionResult {
  value: unknown;
  usage: ModelUsage;
  model: string;
}

export interface JsonModelClient {
  completeJson(request: JsonCompletionRequest): Promise<JsonCompletionResult>;
}

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

const responseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({ content: z.string() }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export class DeepSeekError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DeepSeekError";
  }
}

export class DeepSeekClient implements JsonModelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly request: typeof fetch;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(options: DeepSeekClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(/\/$/, "");
    this.model = options.model ?? "deepseek-chat";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.request = options.fetch ?? fetch;
    this.wait =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async completeJson(request: JsonCompletionRequest): Promise<JsonCompletionResult> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.request(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
            response_format: { type: "json_object" },
            temperature: request.temperature ?? 0.1,
            max_tokens: request.maxTokens ?? 1_800,
            stream: false,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt < this.maxAttempts) {
          await this.wait(backoffMilliseconds(attempt));
          continue;
        }
        throw new DeepSeekError(
          `DeepSeek request failed after ${attempt} attempts: ${safeNetworkError(error)}`,
          "network_error",
        );
      }

      if (!response.ok) {
        const code = await safeApiErrorCode(response);
        if (isRetryable(response.status) && attempt < this.maxAttempts) {
          await this.wait(retryDelayMilliseconds(response, attempt));
          continue;
        }
        throw new DeepSeekError(
          `DeepSeek request failed with HTTP ${response.status}${code ? ` (${code})` : ""}`,
          code ?? `http_${response.status}`,
          response.status,
        );
      }

      let payload: z.infer<typeof responseSchema>;
      // Read as text first and log a slice on failure — an "invalid
      // response envelope" error used to give no way to tell an actual
      // malformed response apart from, say, an unexpected error body,
      // without reproducing locally. Found 2026-09-13 diagnosing a stuck
      // pipeline: this is what made the real cause (truncation from an
      // oversized backlog, not the envelope itself) visible at all.
      const bodyText = await response.text();
      try {
        payload = responseSchema.parse(JSON.parse(bodyText));
      } catch {
        console.error(`DeepSeek response envelope mismatch, raw body (first 500 chars): ${bodyText.slice(0, 500)}`);
        throw new DeepSeekError(
          "DeepSeek returned an invalid response envelope",
          "invalid_response",
        );
      }
      const choice = payload.choices[0];
      if (!choice)
        throw new DeepSeekError("DeepSeek returned no completion choice", "empty_choice");
      if (choice.finish_reason === "length") {
        throw new DeepSeekError("DeepSeek JSON completion was truncated", "truncated_response");
      }
      let value: unknown;
      try {
        value = JSON.parse(choice.message.content);
      } catch {
        if (attempt < this.maxAttempts) {
          console.warn(
            `DeepSeek returned invalid JSON content (attempt ${attempt}/${this.maxAttempts}); retrying.`,
          );
          await this.wait(backoffMilliseconds(attempt));
          continue;
        }
        throw new DeepSeekError(
          `DeepSeek returned invalid JSON content after ${attempt} attempts`,
          "invalid_json",
        );
      }
      const promptTokens = payload.usage?.prompt_tokens ?? 0;
      const completionTokens = payload.usage?.completion_tokens ?? 0;
      return {
        value,
        model: payload.model ?? this.model,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: payload.usage?.total_tokens ?? promptTokens + completionTokens,
        },
      };
    }
    throw new DeepSeekError("DeepSeek retry loop exhausted", "retry_exhausted");
  }
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function backoffMilliseconds(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** (attempt - 1) + Math.round(Math.random() * 250));
}

function retryDelayMilliseconds(response: Response, attempt: number): number {
  const value = response.headers.get("retry-after");
  if (!value) return backoffMilliseconds(attempt);
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(30_000, Math.max(0, date - Date.now()))
    : backoffMilliseconds(attempt);
}

async function safeApiErrorCode(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { error?: { code?: unknown; type?: unknown } };
    const value = payload.error?.code ?? payload.error?.type;
    return typeof value === "string" ? value.slice(0, 80) : null;
  } catch {
    return null;
  }
}

function safeNetworkError(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "network error";
}
