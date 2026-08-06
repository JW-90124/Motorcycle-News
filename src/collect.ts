#!/usr/bin/env node
/**
 * Collection CLI — fetches every source in `sources.ts`, dedupes against
 * `data/state.json`, and writes newly-seen signals to `data/raw/{date}.json`.
 *
 * This is stage 1 only (collection). AI enrichment / digest formatting are
 * separate, later stages — see 待办事项.md in the Obsidian knowledge base.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fetchArticleExcerpt } from "./collectors/article-excerpt.js";
import { getAdapter } from "./collectors/index.js";
import { createSafeFetcher } from "./fetcher.js";
import { sources } from "./sources.js";
import { loadState, markIfNew, saveState } from "./state.js";
import { canonicalizeUrl } from "./url.js";
import type { CollectedSignal } from "./types.js";

// A web-scraper listing card only ever carries a short teaser (title + a
// one-line deck, sometimes just a date stamp) — found 2026-08-06 when a
// real digest read as barely more than headlines. Only web-scraper signals
// get this treatment: RSS summaries can legitimately already be full
// article content, and lta-coe's summary is a deliberately constructed data
// table, not a teaser — re-fetching its dataset page would replace a clean
// accurate summary with unrelated page chrome.
const ENRICH_CONCURRENCY = 5;

interface SourceRunSummary {
  slug: string;
  name: string;
  fetched: number;
  new: number;
  error?: string;
}

async function main() {
  const fetchText = createSafeFetcher();
  const state = await loadState();

  const newSignals: Array<CollectedSignal & { sourceSlug: string; sourceName: string }> = [];
  const summaries: SourceRunSummary[] = [];

  for (const source of sources) {
    const summary: SourceRunSummary = { slug: source.slug, name: source.name, fetched: 0, new: 0 };
    try {
      const adapter = getAdapter(source.adapter);
      const signals = await adapter.collect(source, { fetchText });
      summary.fetched = signals.length;

      for (const signal of signals) {
        let canonicalUrl: string;
        try {
          canonicalUrl = signal.url ? canonicalizeUrl(signal.url) : "";
        } catch {
          canonicalUrl = signal.url;
        }
        const dedupKey = signal.externalId || canonicalUrl || signal.title;
        if (!dedupKey) continue;
        if (markIfNew(state, source.slug, dedupKey)) {
          newSignals.push({ ...signal, url: canonicalUrl || signal.url, sourceSlug: source.slug, sourceName: source.name });
          summary.new += 1;
        }
      }
    } catch (error) {
      summary.error = error instanceof Error ? error.message : String(error);
    }
    summaries.push(summary);
  }

  const toEnrich = newSignals.filter((signal) => signal.rawMeta.adapter === "web-scraper");
  let enrichedCount = 0;
  for (let i = 0; i < toEnrich.length; i += ENRICH_CONCURRENCY) {
    const batch = toEnrich.slice(i, i + ENRICH_CONCURRENCY);
    await Promise.all(
      batch.map(async (signal) => {
        const excerpt = await fetchArticleExcerpt(signal.url, fetchText);
        // Only replace when it's actually more content than the card
        // teaser already had — found 2026-08-06 on SPEEDWEEK: its article
        // pages don't mark up body copy with <p> tags the way EICMA/
        // Visordown/RideApart do, so the <p>-based extraction grabbed a
        // short, unrelated snippet (a related-article teaser) instead of
        // real body text. A length comparison against the known-correct
        // teaser is a cheap, general guard against exactly that failure
        // mode, without needing a second, riskier extraction strategy for
        // every markup style out there.
        if (excerpt && excerpt.length > signal.summary.length) {
          signal.summary = excerpt;
          enrichedCount += 1;
        }
      }),
    );
  }

  const dateStr = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Singapore" }).format(new Date());
  const outPath = `data/raw/${dateStr}.json`;
  await mkdir("data/raw", { recursive: true });
  await writeFile(outPath, `${JSON.stringify({ collectedAt: new Date().toISOString(), signals: newSignals }, null, 2)}\n`, "utf8");
  await saveState(state);

  console.log(`\n信源  抓到  新增  错误`);
  for (const s of summaries) {
    console.log(`${s.name.padEnd(28)} ${String(s.fetched).padStart(4)} ${String(s.new).padStart(4)}  ${s.error ?? ""}`);
  }
  console.log(
    `\n共 ${newSignals.length} 条新内容，写入 ${outPath}（其中 ${toEnrich.length} 条尝试补充正文，${enrichedCount} 条成功）`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
