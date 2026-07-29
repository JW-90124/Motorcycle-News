/**
 * Web scraper adapter for HTML sources without RSS/API — ported near-verbatim
 * from agent-pulse's `src/collectors/web-scraper.ts` (MIT licensed).
 *
 * Best-effort layered extraction: JSON-LD structured data, then <article>
 * blocks, then common list/card class-name patterns, then page-declared
 * RSS/Atom feed discovery, then Open Graph meta tags as a last resort.
 * No AI involved — pure regex/pattern matching, zero marginal cost per run.
 */

import type { CollectedSignal } from "../types.js";
import type { SourceAdapter } from "./types.js";

const MAX_ITEMS = 30;

export const webScraperAdapter: SourceAdapter = {
  kind: "web-scraper",
  async collect(source, context) {
    const { body, status } = await context.fetchText(source.config.url, source.config.headers);
    if (status === 304) return [];

    if (!body || body.length < 100) {
      throw new Error("Web scraper: response body too small or empty");
    }

    const results: CollectedSignal[] = [];

    const jsonLdItems = extractJsonLd(body, source);
    if (jsonLdItems.length > 0) results.push(...jsonLdItems);

    const articleItems = extractArticles(body, source);
    results.push(...articleItems);

    const listItems = extractListItems(body, source);
    results.push(...listItems);

    const feedUrl = discoverFeed(body, source.homepageUrl);
    if (feedUrl && !results.some(hasTrustedPublicationDate)) {
      const { body: feedBody, status: feedStatus } = await context.fetchText(feedUrl);
      if (feedStatus === 200 && feedBody) {
        const feedItems = parseFeed(feedBody, source);
        if (feedItems.some(hasTrustedPublicationDate)) {
          results.splice(0, results.length, ...feedItems);
        }
      }
    }

    const seen = new Set<string>();
    let deduped = results.filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });

    // Repeated boilerplate/nav labels (found 2026-07-29 on MotoGP/WorldSBK:
    // "Tickets & Hospitality"/"Inside WorldSBK" matched at several different
    // URLs each) pass the length filter in extractCardSignal but, unlike
    // real articles, show up identically 2+ times in the same result set —
    // a real news listing essentially never repeats the exact same title.
    const titleCounts = new Map<string, number>();
    for (const item of deduped) {
      const key = item.title.toLowerCase();
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
    deduped = deduped.filter((item) => (titleCounts.get(item.title.toLowerCase()) ?? 0) < 2);

    if (deduped.length === 0) {
      // Some older CMS-driven listing pages (common on legacy .com.cn news
      // portals) don't use semantic <article> tags, JSON-LD, or the
      // post/item/card/entry/story class names the tiers above look for —
      // just plain <a href="..." title="...">. Treat that as a last-resort
      // structural signal before falling back to page-level OG meta.
      deduped.push(...extractTitleAttributeLinks(body, source));
    }

    if (deduped.length === 0) {
      const metaSignal = extractPageMeta(body, source);
      if (metaSignal) deduped.push(metaSignal);
    }

    return deduped.slice(0, source.config.take ?? MAX_ITEMS);
  },
};

function hasTrustedPublicationDate(item: CollectedSignal): boolean {
  return item.rawMeta.dateInferred !== true && Number.isFinite(Date.parse(item.publishedAt));
}

interface SourceLike {
  language: string;
  homepageUrl?: string;
  config: { url: string; category?: string | undefined; take?: number | undefined };
}

function extractJsonLd(body: string, source: SourceLike): CollectedSignal[] {
  const results: CollectedSignal[] = [];
  const ldRegex = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of body.matchAll(ldRegex)) {
    try {
      const data = JSON.parse(match[1] ?? "{}");
      results.push(...normalizeJsonLd(data, source));
    } catch {
      // Skip malformed JSON-LD
    }
  }
  return results;
}

function normalizeJsonLd(data: unknown, source: SourceLike): CollectedSignal[] {
  const items: CollectedSignal[] = [];
  const record = isRecord(data) ? data : {};
  const graph = Array.isArray(record["@graph"]) ? (record["@graph"] as Record<string, unknown>[]) : [record];

  for (const node of graph) {
    if (!isRecord(node)) continue;
    const type = String(node["@type"] ?? "");
    if (type === "BlogPosting" || type === "Article" || type === "NewsArticle" || type === "ListItem") {
      const title = String(node.headline ?? node.name ?? "");
      const mainEntity = isRecord(node.mainEntityOfPage)
        ? String(node.mainEntityOfPage["@id"] ?? node.mainEntityOfPage.url ?? "")
        : String(node.mainEntityOfPage ?? "");
      const url = resolvePublicUrl(String(node.url ?? mainEntity), source.config.url);
      if (!title || !url) continue;
      const date = normalizeDate(String(node.datePublished ?? node.dateCreated ?? ""));
      items.push({
        externalId: String(node.identifier ?? node["@id"] ?? url),
        url,
        title: stripHtml(decodeEntities(title)),
        summary: stripHtml(decodeEntities(String(node.description ?? node.abstract ?? title))).slice(0, 8_000),
        language: source.language,
        publishedAt: date.value,
        category: source.config.category ?? "general",
        tags: Array.isArray(node.keywords) ? node.keywords.filter((k): k is string => typeof k === "string") : [],
        metrics: { platforms: ["web"] },
        rawMeta: { adapter: "web-scraper", source: "json-ld", type, dateInferred: date.inferred },
      });
    }
  }
  return items;
}

function extractArticles(body: string, source: SourceLike): CollectedSignal[] {
  const results: CollectedSignal[] = [];
  const articleRegex = /<article[\s\S]*?>([\s\S]*?)<\/article>/gi;
  for (const match of body.matchAll(articleRegex)) {
    const signal = extractCardSignal(match[1] ?? "", source);
    if (signal) results.push(signal);
  }
  return results;
}

// `(?!s-)` after "item" rejects Tailwind's items-center/items-start/items-end
// alignment utilities — "item" is a substring of "items-", which otherwise
// false-matches on any Tailwind-styled page's layout classes.
const CARD_CLASS = "(?:post|item(?!s-)|card|entry|story|article|blog)";
// Regex can't balance nested tags, so instead of lazy-matching to a closing
// tag (which often stops before reaching a title nested a level or two
// deeper — found 2026-07-29 on Boon Siew Honda, whose real <h5> title sits
// two <div>s in), each card's content is a fixed-size slice taken from where
// its opening tag ends. Slicing independently per match (rather than letting
// the window itself be part of what matchAll consumes) matters on
// densely-packed card lists: an earlier version let one big consumed window
// swallow past a sibling card's own opening tag, silently skipping it (found
// the same day on MODENAS). Slicing lets windows overlap freely — no skips.
const CARD_WINDOW = 1_500;

function extractListItems(body: string, source: SourceLike): CollectedSignal[] {
  const results: CollectedSignal[] = [];

  const openTagPatterns: Array<{ regex: RegExp; hrefGroup?: number }> = [
    { regex: new RegExp(`<li[^>]*class="[^"]*${CARD_CLASS}[^"]*"[^>]*>`, "gi") },
    { regex: new RegExp(`<div[^>]*class="[^"]*${CARD_CLASS}[^"]*"[^>]*>`, "gi") },
    { regex: new RegExp(`<a[^>]*class="[^"]*${CARD_CLASS}[^"]*"[^>]*href="([^"]+)"[^>]*>`, "gi"), hrefGroup: 1 },
    // A plain <a href="..."> wrapping a card-classed <div> (the link has no
    // class of its own — the card styling is on the div it wraps).
    { regex: new RegExp(`<a[^>]+href="([^"]+)"[^>]*>\\s*<div[^>]*class="[^"]*${CARD_CLASS}[^"]*"[^>]*>`, "gi"), hrefGroup: 1 },
  ];

  for (const { regex, hrefGroup } of openTagPatterns) {
    for (const match of body.matchAll(regex)) {
      const tagEnd = (match.index ?? 0) + match[0].length;
      const href = hrefGroup ? match[hrefGroup] : undefined;
      const window = body.slice(tagEnd, tagEnd + CARD_WINDOW);
      const signal = extractCardSignal(window, source, href);
      if (signal) results.push(signal);
    }
    if (results.length >= 5) break;
  }
  return results;
}

// Real headlines observed across sites this session are all 25+ characters;
// nav/UI labels ("Home", "Milestones", "Products") are all under 15. Kept a
// safety margin above the shortest real title seen so far — raised from an
// initial 10 after that was too close to a borderline nav label's length.
const MIN_TITLE_LENGTH = 15;

function extractCardSignal(html: string, source: SourceLike, fallbackHref?: string): CollectedSignal | null {
  const heading = extractFirstHeading(html);
  const title = heading.title;
  // Prefer the href attached to the actual title element (when the title
  // came from an <a class="...title...">) over "the first link anywhere in
  // the window" — found 2026-07-29 on MODENAS: the window's first anchor is
  // a dummy `href="javascript:void(0)"` label ("PRESS RELEASE"), with the
  // real article link two anchors later, on the title element itself.
  const rawLink = fallbackHref ?? heading.href ?? extractFirstLink(html);
  const link = resolvePublicUrl(rawLink, source.config.url);
  // Requiring a real title with reasonable length — not just "has a link" —
  // is what distinguishes a content card from a nav menu item. Found
  // 2026-07-29 on Boon Siew Honda: <li class="menu-item"><a>Products</a></li>
  // has a link and text but nothing article-like, and was wrongly accepted
  // with an empty title (the `title ?? summary` fallback below never
  // actually fired since extractFirstHeading returns "" on a miss, not
  // null/undefined). A minimum length rather than "must be a heading tag" —
  // found the same day that Cycle World's real titles live in a plain
  // `<div class="headline">`, not h1-h6, so requiring a heading tag rejects
  // legitimate content on sites that don't mark up titles semantically; nav
  // labels ("Home", "Cub", "Products") are reliably short, real titles
  // reliably aren't.
  if (!title || !link || title.length < MIN_TITLE_LENGTH) return null;
  // Sponsor logos and social-share footer links (found 2026-07-29 on MotoGP:
  // "TISSOT"/"ESTRELLA GALICIA"/"Facebook"/"Instagram" as "titles" — the
  // length filter alone doesn't catch these, sponsor names can be as long as
  // real headlines). A plain same-host requirement isn't right either:
  // Yamaha's real articles legitimately live on a different domain entirely
  // (news.yamaha-motor.co.jp vs. the global.yamaha-motor.com listing page).
  // What actually distinguishes them is the domain's core brand label —
  // "yamaha-motor" appears in both of Yamaha's domains; "tissotwatches"/
  // "facebook" share nothing with "motogp".
  if (!isLikelySameBrandDomain(link, source.config.url)) return null;

  const date = normalizeDate(extractPublishedDate(html));
  const summary = stripHtml(decodeEntities(extractTextContent(html).slice(0, 500)));

  return {
    externalId: link,
    url: link,
    title: stripHtml(decodeEntities(title || summary.slice(0, 100))),
    summary: summary.slice(0, 8_000),
    language: source.language,
    publishedAt: date.value,
    category: source.config.category ?? "general",
    tags: [],
    metrics: { platforms: ["web"] },
    rawMeta: { adapter: "web-scraper", source: "html-card", dateInferred: date.inferred },
  };
}

function discoverFeed(html: string, homepageUrl: string): string | null {
  const feedLinkMatch = html.match(/<link[^>]+rel="alternate"[^>]+type="application\/(?:rss|atom)\+xml"[^>]+href="([^"]+)"/i);
  if (feedLinkMatch?.[1]) return new URL(feedLinkMatch[1], homepageUrl).toString();
  const altMatch = html.match(/<link[^>]+type="application\/(?:rss|atom)\+xml"[^>]+rel="alternate"[^>]+href="([^"]+)"/i);
  if (altMatch?.[1]) return new URL(altMatch[1], homepageUrl).toString();
  return null;
}

interface FeedItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
}

function parseFeed(xml: string, source: SourceLike): CollectedSignal[] {
  const items: FeedItem[] = [];
  const itemRegex = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi;
  for (const match of xml.matchAll(itemRegex)) {
    const block = match[1] ?? "";
    items.push({
      title: extractXmlTag(block, "title"),
      link: extractXmlLink(block),
      pubDate: extractXmlTag(block, "pubDate") || extractXmlTag(block, "published"),
      description: extractXmlTag(block, "description") || extractXmlTag(block, "summary"),
    });
  }

  return items
    .filter((item) => item.title && item.link)
    .map((item) => ({
      externalId: item.link,
      url: resolvePublicUrl(item.link, source.config.url) ?? "",
      title: stripHtml(decodeEntities(item.title)),
      summary: stripHtml(decodeEntities(item.description || item.title)).slice(0, 8_000),
      language: source.language,
      publishedAt: normalizeDate(item.pubDate).value,
      category: source.config.category ?? "general",
      tags: [],
      metrics: { platforms: ["web", "rss"] },
      rawMeta: { adapter: "web-scraper", source: "discovered-feed", dateInferred: normalizeDate(item.pubDate).inferred },
    }));
}

function extractXmlTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  return regex.exec(xml)?.[1]?.trim() ?? "";
}

function extractXmlLink(xml: string): string {
  const href = xml.match(/<link[^>]+href="([^"]+)"/i);
  return href?.[1] ?? extractXmlTag(xml, "link");
}

function extractTitleAttributeLinks(body: string, source: SourceLike): CollectedSignal[] {
  const results: CollectedSignal[] = [];
  const seen = new Set<string>();
  const linkRegex = /<a[^>]+href="([^"]+)"[^>]*\btitle="([^"]{6,80})"[^>]*>/gi;
  for (const match of body.matchAll(linkRegex)) {
    const link = resolvePublicUrl(match[1] ?? "", source.config.url);
    const title = stripHtml(decodeEntities((match[2] ?? "").trim()));
    if (!link || !title) continue;
    if (link === source.config.url || link === source.homepageUrl) continue;
    if (seen.has(link)) continue;
    seen.add(link);
    results.push({
      externalId: link,
      url: link,
      title,
      // No excerpt is available from a bare title-attribute link — the
      // digest stage will just have less to say for these than for items
      // with a real summary.
      summary: title,
      language: source.language,
      publishedAt: new Date().toISOString(),
      category: source.config.category ?? "general",
      tags: [],
      metrics: { platforms: ["web"] },
      rawMeta: { adapter: "web-scraper", source: "title-attribute-link", dateInferred: true },
    });
  }
  return results;
}

function extractPageMeta(body: string, source: SourceLike): CollectedSignal | null {
  const ogTitle = extractMetaTag(body, "og:title");
  const ogUrl = extractMetaTag(body, "og:url");
  const ogDesc = extractMetaTag(body, "og:description");
  const ogType = extractMetaTag(body, "og:type");
  const publishedValue = extractMetaTag(body, "article:published_time") || extractMetaTag(body, "datePublished");
  const title = ogTitle || extractTagContent(body, "title");

  if (!title || !/article|news/i.test(ogType) || !publishedValue) return null;

  const fallbackUrl = resolvePublicUrl(ogUrl || source.config.url || "", source.config.url);
  if (!fallbackUrl) return null;
  const date = normalizeDate(publishedValue);
  if (date.inferred) return null;

  return {
    externalId: fallbackUrl || "page-meta",
    url: fallbackUrl,
    title: stripHtml(decodeEntities(title)),
    summary: stripHtml(decodeEntities(ogDesc || title)).slice(0, 8_000),
    language: source.language,
    publishedAt: date.value,
    category: source.config.category ?? "general",
    tags: [],
    metrics: { platforms: ["web"] },
    rawMeta: { adapter: "web-scraper", source: "page-meta", dateInferred: false },
  };
}

function extractMetaTag(html: string, property: string): string {
  const regex = new RegExp(`<meta[^>]+(?:property|name)="${property}"[^>]+content="([^"]+)"`, "i");
  const match = html.match(regex);
  if (match?.[1]) return match[1];
  const altRegex = new RegExp(`<meta[^>]+content="([^"]+)"[^>]+(?:property|name)="${property}"`, "i");
  return html.match(altRegex)?.[1] ?? "";
}

function extractFirstLink(html: string): string {
  const match = html.match(/<a[^>]+href="([^"]+)"[^>]*>/i);
  return match?.[1] ?? "";
}

interface HeadingResult {
  title: string;
  /** Set only when the title came from an anchor — its own href, not "the first link anywhere in the card". */
  href?: string;
}

function extractFirstHeading(html: string): HeadingResult {
  for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
    const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (match?.[1]) return { title: stripHtml(match[1]).trim() };
  }
  // Not every site marks up card titles with a heading tag — found on 3
  // different sites the same day (2026-07-29): Cycle World uses
  // <div class="headline">, MODENAS uses <a class="link-title">, Yamaha uses
  // <p class="rwd-news-title">. "headline"/"title" alone are overloaded in
  // UI chrome too (accordion-title, modal-title, nav-title...), so this is
  // deliberately NOT restricted by tag name — MIN_TITLE_LENGTH in
  // extractCardSignal is what actually screens out nav-chrome false
  // positives (nav labels are short; real titles reliably aren't).
  const classMatch = html.match(/<([a-z]+)([^>]*class="[^"]*(?:headline|title)[^"]*"[^>]*)>([\s\S]{0,300}?)<\/\1>/i);
  if (classMatch?.[3]) {
    const href = classMatch[2]?.match(/href="([^"]+)"/i)?.[1];
    return { title: stripHtml(classMatch[3]).trim(), href };
  }
  return { title: "" };
}

function extractPublishedDate(html: string): string {
  const time = html.match(/<time[^>]*datetime=["']([^"']+)["'][^>]*>/i)?.[1];
  if (time) return time;
  const itemProp = html.match(
    /<(?:meta|time)[^>]+(?:itemprop|property|name)=["'](?:datePublished|article:published_time|publishdate)["'][^>]+(?:content|datetime)=["']([^"']+)["']/i,
  )?.[1];
  if (itemProp) return itemProp;
  const itemPropReversed = html.match(
    /<(?:meta|time)[^>]+(?:content|datetime)=["']([^"']+)["'][^>]+(?:itemprop|property|name)=["'](?:datePublished|article:published_time|publishdate)["']/i,
  )?.[1];
  if (itemPropReversed) return itemPropReversed;
  const text = extractTextContent(html);
  const monthName = text.match(
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i,
  )?.[0];
  if (monthName) return monthName;
  // "24 July 2026" — day-first format common in Malaysian/Singaporean English
  // press releases (found 2026-07-29 on Boon Siew Honda's article body text).
  const dayFirstMonthName = text.match(
    /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i,
  )?.[0];
  if (dayFirstMonthName) return dayFirstMonthName;
  const isoDate = text.match(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/)?.[0];
  if (isoDate) return isoDate;
  const chineseDate = text.match(/\b(?:19|20)\d{2}年\d{1,2}月\d{1,2}日\b/)?.[0];
  return chineseDate ?? "";
}

function extractTextContent(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTagContent(html: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  return regex.exec(html)?.[1]?.trim() ?? "";
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;|&#038;|&#x26;/gi, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    // Numeric smart-quote entities — common in press-release copy (found
    // 2026-07-29 on Boon Siew Honda titles) but not covered by the named
    // entities above.
    .replace(/&#8220;|&#x201c;/gi, "“")
    .replace(/&#8221;|&#x201d;/gi, "”")
    .replace(/&#8216;|&#x2018;/gi, "‘")
    .replace(/&#8217;|&#x2019;/gi, "’")
    .replace(/&#8211;|&#x2013;/gi, "–")
    .replace(/&#8212;|&#x2014;/gi, "—");
}

function normalizeDate(value: string): { value: string; inferred: boolean } {
  if (!value) return { value: new Date().toISOString(), inferred: true };
  const chinese = value.match(/((?:19|20)\d{2})年(\d{1,2})月(\d{1,2})日/);
  const normalized = chinese
    ? `${chinese[1]}-${chinese[2]?.padStart(2, "0")}-${chinese[3]?.padStart(2, "0")}`
    : /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$/i.test(
          value.trim(),
        )
      ? `${value.trim()} UTC`
      : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime())
    ? { value: new Date().toISOString(), inferred: true }
    : { value: date.toISOString(), inferred: false };
}

function resolvePublicUrl(value: string, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const TLD_LIKE_LABELS = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

/** The domain label that actually carries the brand/company name, ignoring subdomains and the TLD (including compound ones like .co.jp/.com.my). */
function coreDomainLabel(hostname: string): string {
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length >= 3 && TLD_LIKE_LABELS.has(parts[parts.length - 2] ?? "")) {
    return parts[parts.length - 3] ?? hostname;
  }
  return parts[parts.length - 2] ?? hostname;
}

function isLikelySameBrandDomain(link: string, sourceUrl: string): boolean {
  try {
    const linkLabel = coreDomainLabel(new URL(link).hostname);
    const sourceLabel = coreDomainLabel(new URL(sourceUrl).hostname);
    return linkLabel === sourceLabel || linkLabel.includes(sourceLabel) || sourceLabel.includes(linkLabel);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Short(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}
