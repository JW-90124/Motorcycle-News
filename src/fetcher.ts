/**
 * Safe HTTP fetcher — ported near-verbatim from agent-pulse's
 * `src/collectors/fetcher.ts` (MIT licensed, https://github.com/barretlee/agent-pulse).
 *
 * Kept as-is: SSRF protection (re-validated on every redirect hop, blocks
 * private/loopback/link-local IP ranges and credentials-in-URL), response
 * body size cap, retry with jittered exponential backoff honoring
 * `retry-after`, and credential redaction in error messages.
 *
 * Simplified: dropped the `AppConfig`/env-schema dependency in favor of
 * plain constants — this project doesn't have agent-pulse's wider config
 * surface, and a fixed timeout/user-agent is enough for ~15 sources polled
 * a few times a week.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "motorcycle-news/0.1 (+private research tool)";

export interface FetchResult {
  body: string;
  status: number;
  headers: Headers;
  attemptCount: number;
  responseBytes: number;
  finalUrl: string;
  transport?: "direct" | "env-proxy";
}

export type FetchErrorType =
  | "network"
  | "timeout"
  | "rate_limit"
  | "upstream"
  | "permanent_http"
  | "security";

export class FetchError extends Error {
  constructor(
    message: string,
    readonly type: FetchErrorType,
    readonly retryable: boolean,
    readonly status: number | null = null,
    readonly code: string | null = null,
    readonly attemptCount = 1,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

export interface FetchPolicy {
  timeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
}

interface FetcherDependencies {
  fetchImpl?: typeof fetch;
  proxyFetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  validateUrl?: (url: string) => Promise<void>;
  useEnvProxy?: boolean;
}

export function createSafeFetcher(dependencies: FetcherDependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const proxyFetchImpl =
    dependencies.proxyFetchImpl ??
    (dependencies.fetchImpl || dependencies.useEnvProxy === false
      ? undefined
      : createEnvironmentProxyFetch());
  const sleep =
    dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = dependencies.random ?? Math.random;
  const validateUrl = dependencies.validateUrl ?? assertPublicHttpUrl;

  return async (
    urlValue: string,
    headers: Record<string, string> = {},
    policy: FetchPolicy = {},
  ): Promise<FetchResult> => {
    const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = clamp(policy.maxRetries ?? 2, 0, 5);
    const baseBackoffMs = clamp(policy.baseBackoffMs ?? 500, 50, 30_000);
    let lastError: FetchError | undefined;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      try {
        const result = await fetchWithRedirects(urlValue, headers, timeoutMs, fetchImpl, validateUrl);
        return { ...result, attemptCount: attempt, transport: "direct" as const };
      } catch (error) {
        let classified = classifyError(error, attempt);
        if (proxyFetchImpl && ["network", "timeout"].includes(classified.type)) {
          try {
            const result = await fetchWithRedirects(
              urlValue,
              headers,
              timeoutMs,
              proxyFetchImpl,
              validateUrl,
            );
            return { ...result, attemptCount: attempt, transport: "env-proxy" as const };
          } catch (proxyError) {
            classified = classifyError(proxyError, attempt);
          }
        }
        lastError = classified;
        if (!classified.retryable || attempt > maxRetries) throw classified;
        const retryAfter = classified.status === 429 ? retryAfterMs(error) : null;
        const backoff = Math.min(30_000, baseBackoffMs * 2 ** (attempt - 1));
        await sleep(retryAfter ?? Math.floor(random() * backoff));
      }
    }
    throw lastError ?? new FetchError("Request failed", "network", true);
  };
}

function createEnvironmentProxyFetch(): typeof fetch | undefined {
  if (!hasEnvironmentProxy()) return undefined;
  const dispatcher = new EnvHttpProxyAgent();
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      { ...(init ?? {}), dispatcher } as Parameters<typeof undiciFetch>[1],
    ) as unknown as Promise<Response>) as typeof fetch;
}

function hasEnvironmentProxy(): boolean {
  return Boolean(
    process.env.http_proxy ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.HTTPS_PROXY,
  );
}

async function fetchWithRedirects(
  initialUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  validateUrl: (url: string) => Promise<void>,
): Promise<Omit<FetchResult, "attemptCount">> {
  let currentUrl = initialUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    try {
      await validateUrl(currentUrl);
    } catch (error) {
      throw new FetchError(message(error), "security", false, null, "URL_BLOCKED");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(currentUrl, {
        headers: {
          accept:
            "application/json, application/rss+xml, application/atom+xml, text/html;q=0.9, */*;q=0.5",
          "user-agent": headers["user-agent"] ?? headers["User-Agent"] ?? USER_AGENT,
          ...headers,
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new FetchError("Redirect is missing Location", "upstream", true);
        if (redirects === MAX_REDIRECTS)
          throw new FetchError("Too many redirects", "permanent_http", false, response.status);
        await response.body?.cancel();
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (response.status === 304) {
        return { body: "", status: response.status, headers: response.headers, responseBytes: 0, finalUrl: currentUrl };
      }
      if (!response.ok) throw httpError(response, currentUrl);
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > MAX_BODY_BYTES)
        throw new FetchError(`Response exceeds ${MAX_BODY_BYTES} bytes`, "security", false, response.status, "BODY_TOO_LARGE");
      const { body, bytes } = await readLimitedBody(response, MAX_BODY_BYTES);
      return { body, status: response.status, headers: response.headers, responseBytes: bytes, finalUrl: currentUrl };
    } catch (error) {
      if (error instanceof FetchError) throw error;
      if (isAbort(error))
        throw new FetchError(`Request timed out after ${timeoutMs}ms`, "timeout", true, null, "TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new FetchError("Too many redirects", "permanent_http", false);
}

async function readLimitedBody(response: Response, limit: number): Promise<{ body: string; bytes: number }> {
  if (!response.body) return { body: "", bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new FetchError(`Response exceeds ${limit} bytes`, "security", false, response.status, "BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { body: new TextDecoder().decode(Buffer.concat(chunks)), bytes };
}

function httpError(response: Response, url: string): FetchError {
  const status = response.status;
  const type: FetchErrorType =
    status === 429 ? "rate_limit" : [408, 425].includes(status) || status >= 500 ? "upstream" : "permanent_http";
  const error = new FetchError(`HTTP ${status} for ${url}`, type, type !== "permanent_http", status, `HTTP_${status}`);
  Object.defineProperty(error, "retryAfter", { value: response.headers.get("retry-after") });
  return error;
}

function classifyError(error: unknown, attemptCount: number): FetchError {
  if (error instanceof FetchError) {
    return new FetchError(error.message, error.type, error.retryable, error.status, error.code, attemptCount);
  }
  return new FetchError(message(error), "network", true, null, errorCode(error), attemptCount);
}

function retryAfterMs(error: unknown): number | null {
  const value = (error as { retryAfter?: string | null }).retryAfter;
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return clamp(seconds * 1_000, 0, 30_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : clamp(date - Date.now(), 0, 30_000);
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : null;
}

function message(error: unknown): string {
  let value = error instanceof Error ? error.message : String(error);
  for (const proxy of [process.env.http_proxy, process.env.https_proxy, process.env.HTTP_PROXY, process.env.HTTPS_PROXY]) {
    if (proxy) value = value.replaceAll(proxy, "[proxy]");
  }
  return value.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[credentials]@");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export async function assertPublicHttpUrl(value: string): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) sources are allowed");
  if (url.username || url.password) throw new Error("Credentials in source URLs are not allowed");

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("Local source URLs are blocked");
  const addresses = isIP(hostname)
    ? [hostname]
    : await lookup(hostname, { all: true })
        .then((results) => results.map((r) => r.address))
        .catch(() => []);
  if (addresses.length === 0) throw new Error(`Cannot resolve source hostname: ${hostname}`);
  if (addresses.some(isPrivateAddress)) throw new Error(`Private source address blocked: ${hostname}`);
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a = -1, b = -1] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}
