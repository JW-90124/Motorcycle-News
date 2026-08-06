/**
 * Fetches an article's own page and pulls a real body excerpt out of it —
 * a second-stage enrichment step, separate from the listing-page card
 * extraction in web-scraper.ts.
 *
 * Why this exists: a listing-page "card" only ever carries a short teaser
 * (title + one-line deck, sometimes just a date stamp) — found 2026-08-06
 * when a user review of a real digest showed 今日头条 and category items
 * reading as barely more than headlines. The card's `summary` genuinely
 * doesn't have more to give; the actual article body only exists on the
 * article's own page, which the listing-page scrape never visits.
 */

import type { FetchResult } from "../fetcher.js";
import { decodeEntities, stripHtml } from "./web-scraper.js";

const EXCERPT_MAX_CHARS = 1_500;
// Below this, a paragraph is almost always a caption, byline, or nav
// fragment ("Share on Facebook", photo credits) rather than real body copy.
const MIN_PARAGRAPH_CHARS = 40;

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

  const articleMatch = body.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const scope = articleMatch?.[1] ?? body;

  const paragraphs: string[] = [];
  let matchedChars = 0;
  const paragraphPattern = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null;
  while (matchedChars < EXCERPT_MAX_CHARS && (match = paragraphPattern.exec(scope))) {
    const text = stripHtml(decodeEntities(match[1] ?? ""));
    if (text.length < MIN_PARAGRAPH_CHARS) continue;
    paragraphs.push(text);
    matchedChars += text.length;
  }

  const excerpt = paragraphs.join(" ").slice(0, EXCERPT_MAX_CHARS).trim();
  return excerpt.length > 0 ? excerpt : null;
}
