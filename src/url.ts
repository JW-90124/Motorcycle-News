/**
 * URL canonicalization / dedup key / slug helpers — ported verbatim from
 * agent-pulse's `src/domain/url.ts` (MIT licensed). Extend TRACKING_PARAMS
 * as needed for sites this project actually scrapes.
 *
 * Note: this does NOT strip credentials/secrets from URLs. If this project
 * ever publishes URLs publicly, port `snapshotUrl()`/`assertSnapshotSafe()`
 * from agent-pulse's `src/pipeline/snapshot.ts` instead — see
 * queries/agent-pulse 可复用能力审计.md in the Obsidian knowledge base.
 */

import { createHash } from "node:crypto";

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "source",
  "spm",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
]);

export function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  return url.toString();
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function slugify(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return ascii || `item-${sha256(value).slice(0, 12)}`;
}
