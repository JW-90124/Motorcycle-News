/**
 * 子推送 candidate scoring — confidence + heat, both deterministic formulas
 * computed from data this project actually has (no LLM judgment call, no
 * social-platform metrics we don't collect). See queries/ in the Obsidian
 * knowledge base for the comparison against agent-pulse's original
 * `domain/scoring.ts` and why each input had to be substituted.
 */

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

/** Baseline "worth turning into a video" weight per content category. */
const CATEGORY_WEIGHT: Record<string, number> = {
  racing: 60,
  "new-models": 60,
  culture: 50,
  "local-market": 45,
  tech: 45,
  industry: 35,
};

const HEAT_KEYWORDS = [
  /首发|首秀|全球首秀|debut/i,
  /停产|discontinued/i,
  /召回|recall/i,
  /破纪录|史上最高|创历史新高|record/i,
  /官宣|announce/i,
  /争议|controversy/i,
];

export interface ConfidenceInput {
  authorityScore: number;
  isPrimary: boolean;
  independentSourceCount: number;
}

export function scoreConfidence(input: ConfidenceInput): number {
  const corroborationBonus = Math.min(input.independentSourceCount - 1, 3) * 10;
  return clamp(input.authorityScore * 0.6 + (input.isPrimary ? 20 : 0) + corroborationBonus);
}

export interface HeatInput {
  category: string;
  independentSourceCount: number;
  titleAndSummary: string;
  ageHours: number;
  dateKnown: boolean;
}

export function scoreHeat(input: HeatInput): number {
  const categoryBaseline = CATEGORY_WEIGHT[input.category] ?? 40;
  const corroborationBonus = Math.min(input.independentSourceCount - 1, 3) * 15;
  const keywordBonus = Math.min(
    HEAT_KEYWORDS.filter((pattern) => pattern.test(input.titleAndSummary)).length * 15,
    30,
  );
  // An inferred/unknown publish date can't earn a freshness bonus — we
  // genuinely don't know if it's recent (see digest.ts's dateInferred handling).
  const freshnessBonus = !input.dateKnown ? 0 : input.ageHours <= 24 ? 15 : input.ageHours <= 72 ? 8 : 0;

  return clamp(categoryBaseline + corroborationBonus + keywordBonus + freshnessBonus);
}
