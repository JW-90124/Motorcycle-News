/**
 * Adapter for motogp.com and worldsbk.com news — both run on the same
 * Dorna/Pulselive platform, so one adapter serves both.
 *
 * Why this exists: the generic web-scraper returned zero real articles for
 * either site for the entire life of the project. These pages are
 * server-rendered and full of real articles, but use no <article>, JSON-LD or
 * card class names the generic heuristics recognise, so it fell through to
 * "any link with text" and collected navigation buttons ("View MotoGP™"),
 * sponsor logos (Tissot, Michelin, Pirelli, Brembo) and social-media links —
 * the same 20/18 links every run, so "new content" was permanently zero.
 * Found 2026-10-09 when the source-health warning (added 2026-10-06) kept
 * flagging both after 13 consecutive empty runs and the user asked why.
 *
 * Reliable anchors on these pages: an article link always matches
 * /en/news/YYYY/MM/DD/slug/id (which also gives a real publish date), and the
 * headline sits in an element whose class contains "title".
 */

import type { CollectedSignal } from "../types.js";
import type { SourceAdapter } from "./types.js";
import { decodeEntities, stripHtml } from "./web-scraper.js";

const ARTICLE_LINK =
  /<a\b[^>]*href="((?:https?:\/\/[^"/]+)?\/en\/news\/(20\d\d)\/(\d\d)\/(\d\d)\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
const TITLE_ELEMENT = /<(?:h[1-6]|div|span|p)\b[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/(?:h[1-6]|div|span|p)>/i;
const MIN_TITLE_CHARS = 12;
const MAX_ITEMS = 30;

export const dornaNewsAdapter: SourceAdapter = {
  kind: "dorna-news",
  async collect(source, context) {
    const { body, status } = await context.fetchText(source.config.url, source.config.headers);
    if (status === 304) return [];
    if (!body || body.length < 5_000) throw new Error("Dorna news: response body too small or empty");

    const found = new Map<string, CollectedSignal>();
    for (const match of body.matchAll(ARTICLE_LINK)) {
      const [, href, year, month, day, inner] = match;
      if (!href || !inner) continue;
      const url = new URL(href, source.config.url).toString();
      if (found.has(url)) continue;

      const titleHtml = inner.match(TITLE_ELEMENT)?.[1];
      const attrTitle = match[0].match(/data-type="([^"]+)"/)?.[1];
      const title = stripHtml(decodeEntities(titleHtml ?? (attrTitle && !/news$/i.test(attrTitle) ? attrTitle : "")));
      // Image-only anchors and "Read Now"-style buttons have no headline of their own;
      // the same article's text-bearing anchor elsewhere on the page will supply it.
      if (title.length < MIN_TITLE_CHARS) continue;

      found.set(url, {
        externalId: url,
        url,
        title,
        summary: title,
        language: source.language,
        // The URL carries the publish date but not the time of day.
        publishedAt: `${year}-${month}-${day}T12:00:00.000Z`,
        category: source.config.category ?? "racing",
        tags: [],
        metrics: { platforms: ["web"] },
        // "web-scraper" so downstream treats it like any other scraped article page.
        rawMeta: { adapter: "web-scraper", source: "dorna-news", dateInferred: false },
      });
    }

    const results = [...found.values()]
      .sort((a, b) => (a.publishedAt === b.publishedAt ? b.url.localeCompare(a.url) : b.publishedAt.localeCompare(a.publishedAt)))
      .slice(0, source.config.take ?? MAX_ITEMS);
    if (results.length === 0) throw new Error("Dorna news: no article links found — page structure may have changed");
    return results;
  },
};
