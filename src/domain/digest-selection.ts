/**
 * Which of a day's signals reach the digest, and at what depth.
 *
 * Replaces a single global "top 70 by score" cut (2026-10-09). A global cut
 * lets one busy direction crowd out the rest: the day MotoGP and WorldSBK's
 * official sites started working, racing alone produced ~40 signals and
 * SPEEDWEEK's interviews — the substantive part — were squeezed out entirely.
 * The user's rule: don't give any one direction too many items, guarantee every
 * section real display, and when something has to be dropped let heat decide.
 *
 * So selection is per direction: each direction ranks its own signals by
 * heat+confidence; the top FULL_PER_CATEGORY are written in full, the next
 * BRIEF_PER_CATEGORY become one-sentence briefs, the rest are left out. A quiet
 * direction is never starved by a loud one, and the total handed to the model
 * is bounded (≤ 6 × 10) whatever size the backlog is — which is also what
 * protects against the 2026-09-13 token-budget outage.
 */

import { eventFingerprint } from "./clustering.js";
import type { ScoredSignal } from "./score-signals.js";

export const FULL_PER_CATEGORY = 5;
export const BRIEF_PER_CATEGORY = 5;

export type Tier = "full" | "brief";

export interface Selected {
  item: ScoredSignal;
  tier: Tier;
}

export const scoreOf = (item: ScoredSignal) => item.heat + item.confidence;

/**
 * Per-direction selection, grouped by the source-assigned category (known
 * before the model runs) in `categoryOrder`, best first within each.
 */
export function selectBalanced(
  scored: ScoredSignal[],
  categoryOrder: string[],
  limits: { full: number; brief: number } = { full: FULL_PER_CATEGORY, brief: BRIEF_PER_CATEGORY },
): Selected[] {
  const byCategory = new Map<string, ScoredSignal[]>();
  for (const item of scored) {
    const bucket = byCategory.get(item.signal.category) ?? [];
    bucket.push(item);
    byCategory.set(item.signal.category, bucket);
  }
  const orderedCategories = [
    ...categoryOrder.filter((category) => byCategory.has(category)),
    ...[...byCategory.keys()].filter((category) => !categoryOrder.includes(category)),
  ];

  const selected: Selected[] = [];
  for (const category of orderedCategories) {
    const ranked = [...(byCategory.get(category) ?? [])].sort((a, b) => scoreOf(b) - scoreOf(a));
    ranked.slice(0, limits.full).forEach((item) => selected.push({ item, tier: "full" }));
    ranked.slice(limits.full, limits.full + limits.brief).forEach((item) => selected.push({ item, tier: "brief" }));
  }
  return selected;
}

/** First sentence of a body, for rendering an overflow item as a one-line brief. */
export function firstSentence(text: string, maxChars = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[。！？!?]/);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > maxChars ? `${sentence.slice(0, maxChars - 1)}…` : sentence;
}

// ---------------------------------------------------------------------------
// Likely-duplicate detection (added 2026-10-09). The model was told to merge
// items reporting the same event but did so unreliably: on a real day the same
// Honda Rebel and Triumph T40 launches each showed up twice (once in full, once
// as a brief). Titles about one launch usually share a model code (CMX500, T40,
// Desmo450) even across languages, which makes that a cheap, high-precision
// signal that does not depend on translation.
// ---------------------------------------------------------------------------

// Codes that appear on many unrelated stories — sharing one says nothing.
const GENERIC_CODES = /^(fp\d|q\d|sp\d|sprint|moto[23e]|wsbk|wssp\d*|wcr|gp\d*|r\d{1,2}|\d+cc|\d+hp|\d+kw|\d+nm|\d+km|\d+kg|\d+mm|\d+s)$/i;

export function modelCodes(title: string): string[] {
  const matches = title.match(/[A-Za-z0-9][A-Za-z0-9-]{2,}/g) ?? [];
  const codes = matches.filter(
    (token) => /[A-Za-z]/.test(token) && /\d/.test(token) && !/^(19|20)\d\d[a-z]?$/i.test(token) && !GENERIC_CODES.test(token),
  );
  return [...new Set(codes.map((code) => code.toLowerCase()))];
}

const SERIES_FINGERPRINTS = new Set(["motogp", "worldsbk", "eicma"]);
// A distinctive word is one that is rare across the day's titles; a word seen in
// more than this many titles is generic ("Introduces", "Motorcycle") not a model name.
const MAX_DOC_FREQUENCY = 3;

function manufacturerOf(title: string): string | null {
  const key = eventFingerprint(title);
  return key && !SERIES_FINGERPRINTS.has(key) ? key : null;
}

function capitalisedWords(title: string): string[] {
  return [...new Set((title.match(/\b[A-Z][a-z]{3,}\b/g) ?? []).map((w) => w.toLowerCase()))];
}

export interface TitleInfo {
  title: string;
  category: string;
}

/**
 * Groups of positions (0-based) that very likely report one product/event: same
 * manufacturer and a shared model code or a shared rare capitalised word (the
 * model name — "Bonneville", "Rebel"). The brand name itself never counts, so
 * "Ducati Multistrada" and "Ducati Desmo450" stay apart. Racing items are
 * excluded: those stories revolve around riders and teams, which recur across
 * many genuinely different events. Size ≥ 2 only.
 */
export function findLikelyDuplicateGroups(items: TitleInfo[]): number[][] {
  const candidates = items.map((item, i) => ({ i, brand: item.category === "racing" ? null : manufacturerOf(item.title) }));
  const docFrequency = new Map<string, number>();
  for (const item of items) for (const word of capitalisedWords(item.title)) docFrequency.set(word, (docFrequency.get(word) ?? 0) + 1);
  const distinctive = (word: string) => (docFrequency.get(word) ?? 0) <= MAX_DOC_FREQUENCY && eventFingerprint(word) === null;
  const tokens = items.map((item) => new Set([...modelCodes(item.title), ...capitalisedWords(item.title).filter(distinctive)]));

  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (const a of candidates) {
    if (!a.brand) continue;
    for (const b of candidates) {
      if (b.i <= a.i || b.brand !== a.brand) continue;
      if ([...tokens[a.i]!].some((token) => tokens[b.i]!.has(token))) parent[find(b.i)] = find(a.i);
    }
  }
  const groups = new Map<number, number[]>();
  items.forEach((_, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  });
  return [...groups.values()].filter((group) => group.length >= 2);
}
