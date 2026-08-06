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

/**
 * "影响范围" (scope of impact) — user's own priority framework 2026-08-04,
 * derived from reviewing a real multi-category digest: across all four
 * content directions, what actually made one story feel more important
 * than another wasn't detail/length, it was how *wide* an impact it had —
 * whole-series/whole-industry news (rule changes, calendar shifts, entire
 * grid shakeups) outranks a named star rider or major brand, which in turn
 * outranks marginal/individual-scope news. Confirmed consistent across
 * racing (series-wide > star rider > minor race), new-models (popular
 * brand > generic model > gear), and tech (industry-wide standard > a
 * single manufacturer's own tech).
 */
const SCOPE_INDUSTRY_KEYWORDS =
  /赛历|赛程|新规|禁令|规则变动|规则变更|席位|退出|转播权|转播|政策|行业协会|销量|市场份额|安全标准|安全隐患|存在隐患|风险|前景不明|推迟|延期|取消|calendar|regulation|championship rules|broadcast rights|postponed|canceled|cancelled/i;
// Deliberately a single name for now — user's own call 2026-08-04: the full
// star-rider list can wait, Marquez alone covers the clearest real case.
// Extend this list as the user provides more names.
const STAR_RIDERS = /marquez|márquez|马奎兹|马奎斯/i;

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
  const scopeBonus = scoreScope(input.titleAndSummary);

  return clamp(categoryBaseline + corroborationBonus + keywordBonus + freshnessBonus + scopeBonus);
}

/**
 * See the 影响范围 comment above HEAT_KEYWORDS for the reasoning. Deliberately
 * does NOT fall back to clustering.ts's eventFingerprint() for a "major
 * brand" tier — that fingerprint table exists to catch ~24 tracked brands
 * for dedup purposes, so it matches almost any new-model/gear story (nearly
 * all of which mention a brand by nature) and would make this tier fire
 * near-universally, erasing the marginal-vs-major distinction it's meant to
 * capture. Found via a real run where a routine NC750X colour-update story
 * scored higher than it should have. Star-rider mentions stay narrow
 * (currently just Marquez, per the user's own call) until there's a real
 * signal for "major brand" that isn't just "mentions a tracked brand."
 */
function scoreScope(titleAndSummary: string): number {
  if (SCOPE_INDUSTRY_KEYWORDS.test(titleAndSummary)) return 30;
  if (STAR_RIDERS.test(titleAndSummary)) return 15;
  return 0;
}
