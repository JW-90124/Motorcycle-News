/**
 * Shared confidence/heat scoring for a batch of signals — factored out of
 * digest.ts so weekly-digest.ts can reuse the exact same formulas rather
 * than re-deriving them. See domain/scoring.ts for the formulas themselves
 * and domain/clustering.ts for how independentSourceCount is derived.
 */

import { clusterSignals, independentSourceCount } from "./clustering.js";
import { scoreConfidence, scoreHeat } from "./scoring.js";
import { sources } from "../sources.js";
import type { CollectedSignal } from "../types.js";

export type RawSignal = CollectedSignal & { sourceSlug: string; sourceName: string };

export interface ScoredSignal {
  signal: RawSignal;
  confidence: number;
  heat: number;
  clusterSize: number;
}

/**
 * `contextSignals` — recent prior-day signals used only to detect
 * cross-day corroboration (same event covered by a different source a
 * couple of days ago), never scored or returned themselves. Without this,
 * clustering only ever saw one collection run's signals at a time, so two
 * sources covering the same event a day or two apart never corroborated
 * each other — found 2026-08-07: the user pointed out publish-time lag
 * between sources means same-event coverage often lands in different
 * collection runs, not just the same one.
 */
export function scoreSignals(signals: RawSignal[], contextSignals: RawSignal[] = []): ScoredSignal[] {
  const pool = contextSignals.length > 0 ? [...signals, ...contextSignals] : signals;
  const clusters = clusterSignals(pool);
  const clusterSizeBySignal = new Map<RawSignal, number>();
  for (const cluster of clusters) {
    const size = independentSourceCount(cluster);
    for (const member of cluster) clusterSizeBySignal.set(member, size);
  }

  const sourceBySlug = new Map(sources.map((source) => [source.slug, source]));

  return signals.map((signal) => {
    const source = sourceBySlug.get(signal.sourceSlug);
    const clusterSize = clusterSizeBySignal.get(signal) ?? 1;
    const dateKnown = signal.rawMeta.dateInferred !== true;
    const ageHours = dateKnown ? (Date.now() - new Date(signal.publishedAt).getTime()) / 3_600_000 : Infinity;

    const confidence = scoreConfidence({
      authorityScore: source?.authorityScore ?? 50,
      isPrimary: source?.isPrimary ?? false,
      independentSourceCount: clusterSize,
    });
    const heat = scoreHeat({
      category: signal.category,
      independentSourceCount: clusterSize,
      titleAndSummary: `${signal.title} ${signal.summary}`,
      ageHours,
      dateKnown,
    });

    return { signal, confidence, heat, clusterSize };
  });
}
