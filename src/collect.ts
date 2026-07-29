#!/usr/bin/env node
/**
 * Collection CLI — fetches every source in `sources.ts`, dedupes against
 * `data/state.json`, and writes newly-seen signals to `data/raw/{date}.json`.
 *
 * This is stage 1 only (collection). AI enrichment / digest formatting are
 * separate, later stages — see 待办事项.md in the Obsidian knowledge base.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { getAdapter } from "./collectors/index.js";
import { createSafeFetcher } from "./fetcher.js";
import { sources } from "./sources.js";
import { loadState, markIfNew, saveState } from "./state.js";
import { canonicalizeUrl } from "./url.js";
import type { CollectedSignal } from "./types.js";

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

  const dateStr = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Singapore" }).format(new Date());
  const outPath = `data/raw/${dateStr}.json`;
  await mkdir("data/raw", { recursive: true });
  await writeFile(outPath, `${JSON.stringify({ collectedAt: new Date().toISOString(), signals: newSignals }, null, 2)}\n`, "utf8");
  await saveState(state);

  console.log(`\n信源  抓到  新增  错误`);
  for (const s of summaries) {
    console.log(`${s.name.padEnd(28)} ${String(s.fetched).padStart(4)} ${String(s.new).padStart(4)}  ${s.error ?? ""}`);
  }
  console.log(`\n共 ${newSignals.length} 条新内容，写入 ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
