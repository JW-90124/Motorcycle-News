import { rssAdapter } from "./rss.js";
import { webScraperAdapter } from "./web-scraper.js";
import type { SourceAdapter } from "./types.js";

const adapters = new Map<string, SourceAdapter>([rssAdapter, webScraperAdapter].map((a) => [a.kind, a]));

export function getAdapter(kind: string): SourceAdapter {
  const adapter = adapters.get(kind);
  if (!adapter) throw new Error(`Unknown source adapter: ${kind}`);
  return adapter;
}
