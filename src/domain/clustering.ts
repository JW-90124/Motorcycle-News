/**
 * Lightweight cross-source event clustering — same spirit as agent-pulse's
 * `domain/clustering.ts` (MIT licensed), scaled down for ~15 hand-picked
 * sources instead of a large, diverse, high-volume pool. `titleTokens`/
 * `titleSimilarity` are ported near-verbatim (plain Jaccard token overlap on
 * normalized title text — agent-pulse's clustering is regex/token-based
 * throughout, not embeddings, so this genuinely is the same technique, not
 * a simplified stand-in). `eventFingerprint` swaps agent-pulse's AI-model
 * name regex table for a motorcycle brand/model one; `eventFacet` is skipped
 * in favor of reusing this project's existing 6 content categories
 * (racing/local-market/new-models/tech/industry/culture) as the facet, since
 * every signal already carries one.
 *
 * This is a living list — extend BRAND_FINGERPRINTS as real clustering
 * misses turn up (keep it in sync with the Obsidian 车型数据库 whenever that
 * grows real entries; GitHub Actions can't read the local Obsidian vault at
 * runtime, so this table is the machine-usable subset, manually mirrored —
 * same pattern as sources.ts mirroring 信源清单).
 */

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
  "new",
  "news",
]);

export function titleTokens(title: string): Set<string> {
  const tokens = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

export function titleSimilarity(left: string, right: string): number {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Canonical brand/model fingerprint — two titles that resolve to the same
 * fingerprint are almost certainly about the same manufacturer/model line,
 * regardless of phrasing differences across languages/sources.
 */
const BRAND_FINGERPRINTS: Array<[string, RegExp]> = [
  ["honda", /\bhonda\b|本田/],
  ["yamaha", /\byamaha\b|雅马哈/],
  ["kawasaki", /\bkawasaki\b|川崎/],
  ["suzuki", /\bsuzuki\b|铃木/],
  ["ducati", /\bducati\b|杜卡迪/],
  ["bmw-moto", /\bbmw\b.*moto|bmw\s*motorrad|宝马摩托/],
  ["ktm", /\bktm\b/],
  ["triumph", /\btriumph\b|凯旋|英伦凯旋/],
  ["harley-davidson", /harley[-\s]?davidson|哈雷/],
  ["royal-enfield", /royal\s*enfield|皇家恩菲尔德/],
  ["aprilia", /\baprilia\b/],
  ["piaggio-vespa", /\bpiaggio\b|\bvespa\b|比亚乔|维斯帕/],
  ["tvs", /\btvs\b/],
  ["bajaj", /\bbajaj\b/],
  ["cfmoto", /\bcfmoto\b|春风动力|春风\s*\d/],
  ["qjmotor", /qjmotor|钱江摩托|钱江\s*\d/],
  ["loncin", /\bloncin\b|隆鑫/],
  ["zongshen", /zongshen|宗申/],
  ["haojue", /haojue|豪爵/],
  ["dayang", /大长江/],
  ["modenas", /\bmodenas\b/],
  ["motogp", /\bmotogp\b/],
  ["worldsbk", /\bworldsbk\b|world\s*superbike|世界超级摩托车/],
  ["eicma", /\beicma\b/],
];

export function eventFingerprint(title: string): string | null {
  const normalized = title.normalize("NFKC").toLowerCase();
  for (const [brand, pattern] of BRAND_FINGERPRINTS) {
    if (pattern.test(normalized)) return brand;
  }
  return null;
}

export interface ClusterableSignal {
  title: string;
  publishedAt: string;
  category: string;
  sourceSlug: string;
}

/**
 * Whether `candidate` belongs to the same real-world event as `existing`.
 * Mirrors agent-pulse's `belongsToEvent`: an exact fingerprint match (same
 * brand, same category-as-facet) within a wider time window, or fall back to
 * plain title-token similarity within a tighter window.
 */
export function belongsToSameEvent(
  candidate: ClusterableSignal,
  existing: ClusterableSignal,
  threshold = 0.46,
): boolean {
  const hours =
    Math.abs(new Date(candidate.publishedAt).getTime() - new Date(existing.publishedAt).getTime()) /
    3_600_000;
  if (hours > 21 * 24) return false;

  const candidateFingerprint = eventFingerprint(candidate.title);
  const existingFingerprint = eventFingerprint(existing.title);
  if (candidateFingerprint && candidateFingerprint === existingFingerprint) {
    return candidate.category === existing.category && hours <= 21 * 24;
  }
  return hours <= 96 && titleSimilarity(candidate.title, existing.title) >= threshold;
}

/**
 * Groups signals (typically from a single collection run) into clusters of
 * signals judged to be about the same event. Only cross-source membership
 * matters downstream (independentSourceCount) — same-source duplicates
 * clustering together is harmless.
 */
export function clusterSignals<T extends ClusterableSignal>(signals: T[]): T[][] {
  const clusters: T[][] = [];
  for (const signal of signals) {
    const match = clusters.find((cluster) => cluster.some((member) => belongsToSameEvent(signal, member)));
    if (match) match.push(signal);
    else clusters.push([signal]);
  }
  return clusters;
}

export function independentSourceCount<T extends ClusterableSignal>(cluster: T[]): number {
  return new Set(cluster.map((signal) => signal.sourceSlug)).size;
}
