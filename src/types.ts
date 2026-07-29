/**
 * Core data shapes, adapted from agent-pulse's `src/domain/types.ts`.
 *
 * Deliberately simplified for a private single-user tool: no tier/authority
 * score/lifecycle state (that machinery exists to vet untrusted community
 * sources over time — irrelevant when the source list is hand-picked by one
 * person). CollectedSignal keeps the same shape as agent-pulse's version so
 * the ported adapters (rss.ts, web-scraper.ts) work unchanged.
 */

export interface SourceConfig {
  url: string;
  category?: string;
  take?: number;
  dataPath?: string;
}

export interface SignalMetrics {
  platforms?: string[];
}

export interface CollectedSignal {
  externalId?: string;
  url: string;
  title: string;
  summary: string;
  author?: string;
  language: string;
  publishedAt: string;
  category: string;
  tags: string[];
  metrics: SignalMetrics;
  rawMeta: Record<string, unknown>;
}

export interface SourceDescriptor {
  slug: string;
  name: string;
  homepageUrl: string;
  /** Which adapter (by `kind`) collects this source. */
  adapter: string;
  language: string;
  config: SourceConfig;
}
