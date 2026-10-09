/**
 * Fetches an article's own page and pulls its body text out — a second-stage
 * enrichment step, separate from the listing-page card extraction in
 * web-scraper.ts.
 *
 * Why this exists: a listing-page "card" only ever carries a short teaser
 * (title + one-line deck, sometimes just a date stamp) — found 2026-08-06
 * when a user review of a real digest showed 今日头条 and category items
 * reading as barely more than headlines. The actual article body only exists
 * on the article's own page, which the listing-page scrape never visits.
 *
 * Body-scope selection (reworked 2026-10-06): the first version took the
 * first <article> block's paragraphs, which failed on SPEEDWEEK — its real
 * body is NOT inside any <article>; the 29 <article> elements on the page are
 * all "related story" teaser cards of one paragraph each. So two scopes are
 * tried and the one with more paragraph text wins: (1) the largest <article>
 * (sites that wrap the body in one), and (2) the whole page with every
 * <article> block removed (sites where <article> only marks teaser cards).
 * Measured on real pages: SPEEDWEEK went from 226 to 2,088 characters.
 */

import type { FetchResult } from "../fetcher.js";
import { decodeEntities, stripHtml } from "./web-scraper.js";

export const EXCERPT_MAX_CHARS = 6_000;
// Below this, a paragraph is almost always a caption, byline, or nav
// fragment ("Share on Facebook", photo credits) rather than real body copy.
const MIN_PARAGRAPH_CHARS = 40;

function paragraphsOf(html: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripHtml(decodeEntities(match[1] ?? ""));
    if (text.length < MIN_PARAGRAPH_CHARS || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

/** Pure extraction (no network) so it can be unit-tested against fixed HTML. */
export function extractArticleBody(html: string): string | null {
  const articleBlocks = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1] ?? "");
  const largestArticle = articleBlocks
    .map((block) => paragraphsOf(block).join(" "))
    .sort((a, b) => b.length - a.length)[0] ?? "";
  const withoutCards = paragraphsOf(html.replace(/<article\b[^>]*>[\s\S]*?<\/article>/gi, "")).join(" ");

  const best = withoutCards.length > largestArticle.length ? withoutCards : largestArticle;
  const excerpt = best.slice(0, EXCERPT_MAX_CHARS).trim();
  return excerpt.length > 0 ? excerpt : null;
}

export async function fetchArticleExcerpt(
  url: string,
  fetchText: (url: string, headers?: Record<string, string>) => Promise<FetchResult>,
): Promise<string | null> {
  let body: string;
  let status: number;
  try {
    ({ body, status } = await fetchText(url));
  } catch {
    return null;
  }
  if (status !== 200 || !body) return null;
  return extractArticleBody(body);
}

// ---------------------------------------------------------------------------
// Publish-date extraction (added 2026-10-09). Some listing pages carry no date
// at all (两轮视界's channel lists, for one), which left every item flagged
// "date unknown" and treated as stale by the digest. The article's own page
// nearly always states when it was published, so read it from there.
// ---------------------------------------------------------------------------

const MAX_PLAUSIBLE_AGE_DAYS = 5 * 365;

function plausible(date: Date, now: number): boolean {
  const time = date.getTime();
  return Number.isFinite(time) && time <= now + 86_400_000 && time >= now - MAX_PLAUSIBLE_AGE_DAYS * 86_400_000;
}

/** Best-effort publish date (ISO) from an article page, or null. Pure — no network. */
export function extractPublishDate(html: string, now = Date.now()): string | null {
  const candidates: string[] = [];
  // Structured/meta sources first: they describe *this* article, not a sidebar item.
  for (const m of html.matchAll(/<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|og:published_time|publishdate|pubdate|date|datePublished)["'][^>]*content=["']([^"']+)["']/gi)) candidates.push(m[1]!);
  for (const m of html.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["'](?:article:published_time|og:published_time|publishdate|pubdate|date|datePublished)["']/gi)) candidates.push(m[1]!);
  for (const m of html.matchAll(/"datePublished"\s*:\s*"([^"]+)"/g)) candidates.push(m[1]!);
  for (const m of html.matchAll(/<time\b[^>]*datetime=["']([^"']+)["']/gi)) candidates.push(m[1]!);
  for (const raw of candidates) {
    const date = new Date(raw);
    if (plausible(date, now)) return date.toISOString();
  }
  // Last resort, first body timestamp like "2026/3/26 14:56:38" (Chinese CMS pages).
  const stamp = html.match(/\b(20\d\d)[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (stamp) {
    const [, y, mo, d, h, mi] = stamp;
    // Treated as Singapore/China time (UTC+8) — these pages are written for that audience.
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 8, Number(mi)));
    if (plausible(date, now)) return date.toISOString();
  }
  return null;
}

export interface FetchedArticle {
  excerpt: string | null;
  publishedAt: string | null;
}

export async function fetchArticle(
  url: string,
  fetchText: (url: string, headers?: Record<string, string>) => Promise<FetchResult>,
): Promise<FetchedArticle> {
  let body: string;
  let status: number;
  try {
    ({ body, status } = await fetchText(url));
  } catch {
    return { excerpt: null, publishedAt: null };
  }
  if (status !== 200 || !body) return { excerpt: null, publishedAt: null };
  return { excerpt: extractArticleBody(body), publishedAt: extractPublishDate(body) };
}
