/**
 * Visordown-specific listing adapter. The generic web-scraper stopped working
 * on this site around 2026-09-23 (found 2026-10-06: it returned 4 junk items,
 * the first titled "Go to next page"; zero new articles for two weeks). The
 * redesigned listing renders every article as a Drupal card with a stable
 * shape — `data-timestamp` (unix seconds) and `<a class="title">` /
 * `<div class="description">` — which is far more reliable to read directly
 * than guessing through the generic layered heuristics, and gives a real
 * publish date instead of an inferred one.
 */

import type { CollectedSignal } from "../types.js";
import type { SourceAdapter } from "./types.js";
import { decodeEntities, stripHtml } from "./web-scraper.js";

const TITLE_PATTERN = /<a class="title" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const DESCRIPTION_PATTERN = /class="description">([\s\S]*?)<\/div>/;
// The card's time block sits shortly before its title anchor.
const LOOKBEHIND_CHARS = 1_500;
const MAX_ITEMS = 30;

export const visordownAdapter: SourceAdapter = {
  kind: "visordown",
  async collect(source, context) {
    const { body, status } = await context.fetchText(source.config.url, source.config.headers);
    if (status === 304) return [];
    if (!body || body.length < 1_000) throw new Error("Visordown: response body too small or empty");

    const results: CollectedSignal[] = [];
    const seen = new Set<string>();

    for (const match of body.matchAll(TITLE_PATTERN)) {
      const [, href, rawTitle] = match;
      const index = match.index ?? 0;
      const title = stripHtml(decodeEntities(rawTitle ?? ""));
      if (!href || !title) continue;

      const url = new URL(href, source.config.url).toString();
      if (seen.has(url)) continue;
      seen.add(url);

      const before = body.slice(Math.max(0, index - LOOKBEHIND_CHARS), index);
      const timestamps = [...before.matchAll(/data-timestamp="(\d+)"/g)];
      const seconds = Number(timestamps[timestamps.length - 1]?.[1]);
      const publishedAt = Number.isFinite(seconds) ? new Date(seconds * 1_000).toISOString() : new Date().toISOString();

      const after = body.slice(index + match[0].length, index + match[0].length + 2_000);
      const description = stripHtml(decodeEntities(after.match(DESCRIPTION_PATTERN)?.[1] ?? ""));

      results.push({
        externalId: url,
        url,
        title,
        summary: description || title,
        language: source.language,
        publishedAt,
        category: source.config.category ?? "general",
        tags: [],
        metrics: { platforms: ["web"] },
        // "web-scraper" so collect.ts's article-body enrichment still applies.
        rawMeta: { adapter: "web-scraper", source: "visordown-card", dateInferred: !Number.isFinite(seconds) },
      });
      if (results.length >= (source.config.take ?? MAX_ITEMS)) break;
    }

    if (results.length === 0) throw new Error("Visordown: no article cards found — page structure may have changed again");
    return results;
  },
};
