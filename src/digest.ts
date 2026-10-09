#!/usr/bin/env node
/**
 * Digest CLI — stage 2 of the pipeline. Reads today's `data/raw/{date}.json`
 * (written by `collect.ts`) and asks DeepSeek to turn the newly-collected
 * signals into a 主推 (main push) modeled on 36Kr's "互联网人资讯早餐"
 * format — 今日热点导览 (one-line highlights for everything) → 今日头条
 * (2-3 top-scored stories, expanded) → 分类栏目 (everything else, grouped
 * by our 6 content categories). See 输出结构.md in the Obsidian knowledge
 * base. Also scores every signal (confidence + heat — domain/scoring.ts)
 * and, for the 1-2 that clear both the score threshold and a minimum
 * information-density bar, generates a separate 子推送 (deep-dive personal
 * commentary, styled after a 36Kr product-review piece) — independent of
 * 主推, not a module appended under it.
 *
 * The model is only ever asked to select/order/summarize the signals it's
 * given and reference them by index — it never invents a source URL. The
 * citation link in the rendered output always comes from our own collected
 * data, not from model output, so a hallucinated URL can't end up in the
 * digest. Heat/confidence scores are used internally for selection only —
 * never shown to the reader.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { DeepSeekClient, DeepSeekError } from "./ai/deepseek.js";
import { BRIEF_PER_CATEGORY, FULL_PER_CATEGORY, findLikelyDuplicateGroups, firstSentence, scoreOf, selectBalanced } from "./domain/digest-selection.js";
import type { Selected, Tier } from "./domain/digest-selection.js";
import { scoreSignals } from "./domain/score-signals.js";
import { sources } from "./sources.js";
import type { RawSignal, ScoredSignal } from "./domain/score-signals.js";

const SUB_PUSH_SCORE_THRESHOLD = 60;
// A "骨架新闻" (bare announcement with no real detail) can still score high
// on confidence/heat but has nothing to actually analyze — found 2026-07-31
// on a thin Yamaha personnel announcement that produced a hollow sub-push.
const SUB_PUSH_MIN_SUMMARY_LENGTH = 60;
const MAX_SUB_PUSH_ITEMS = 2;
const MAX_TOP_STORIES = 3;
// How many items a direction gets, and at what depth, lives in
// domain/digest-selection.ts (FULL_PER_CATEGORY / BRIEF_PER_CATEGORY). Selection
// is per direction so one busy direction cannot crowd out the others, and it
// also bounds what is sent to the model however large a backlog is — which is
// what protects against the 2026-09-13 outage (a 224-signal backlog overflowed
// the token budget and, because nothing capped input, kept failing).
//
// Text handed to the model per signal. 800 until 2026-10-06, when the pipeline
// started capturing full article bodies; briefs only need enough to write one
// sentence.
const FULL_CHARS_PER_SIGNAL = 4_000;
const BRIEF_CHARS_PER_SIGNAL = 600;

const CATEGORY_LABELS: Record<string, string> = {
  racing: "赛事赛果",
  "new-models": "全球新车发布",
  tech: "技术工程解读",
  industry: "产业商业动态",
  "local-market": "本地车市",
  culture: "骑行文化车展活动",
};
const CATEGORY_ORDER = ["racing", "new-models", "tech", "industry", "local-market", "culture"];

const digestResponseSchema = z.object({
  headline: z.string().min(1),
  // Tied to an index (not a free-floating string list) so irrelevant items
  // can be filtered out here the same way they're filtered out of the body
  // — a plain prompt instruction to "skip irrelevant ones" wasn't reliably
  // followed (found 2026-08-01: the sheriff-corruption story still showed
  // up as an overview bullet even though it was correctly excluded from
  // every other section).
  overview: z.array(z.object({ index: z.number().int().positive(), text: z.string().min(1) })).min(1),
  items: z
    .array(
      z.object({
        index: z.number().int().positive(),
        heading: z.string().min(1),
        body: z.string().min(1),
        // The model's own read of what this article is actually about —
        // not the source's blanket category label. RideApart (adapter:
        // "rss") is configured as "new-models" but also publishes unrelated
        // content (local-government stories, giveaways) that a source-level
        // label can't distinguish; RideApart's RSS feed itself carries no
        // per-article category to fall back on (checked 2026-08-01).
        category: z.enum(["racing", "new-models", "tech", "industry", "local-market", "culture"]),
        // False for content that isn't genuinely about motorcycles/the moto
        // industry — tangential local-news or unrelated promotional filler
        // a moto site sometimes publishes alongside real coverage.
        relevant: z.boolean(),
        // Other input indices this item absorbed because they report the same event.
        // Validated in renderDigest, never trusted.
        merged: z.array(z.number().int().positive()).optional(),
      }),
    )
    .min(1),
});

const subPushResponseSchema = z.object({
  hook: z.string().min(1),
  body: z.string().min(1),
  verdict: z.string().min(1),
  closingQuestion: z.string().min(1),
});

async function main() {
  // DIGEST_DATE lets a past day be regenerated from its saved raw data (e.g. after a prompt change).
  const dateStr = process.env.DIGEST_DATE ?? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Singapore" }).format(new Date());
  const rawPath = `data/raw/${dateStr}.json`;

  const raw = await readRawSignals(rawPath);
  if (!raw || raw.signals.length === 0) {
    console.log(`${rawPath} 里没有新信号，跳过生成主推（不调用 AI，避免空跑浪费调用）。`);
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "缺少 DEEPSEEK_API_KEY 环境变量，无法生成主推。不做静默兜底——宁可报错也不要生成占位内容。",
    );
  }

  // Generating structured JSON for a full day routinely takes over a minute
  // (found 2026-09-13: a 120-item request timed out at the old 60s default).
  const client = new DeepSeekClient({ apiKey, timeoutMs: 600_000 });
  const contextSignals = await readRecentContextSignals(dateStr);
  const scoredAll = scoreSignals(raw.signals, contextSignals);

  // Selection is entirely deterministic (our own scoring), per direction — the
  // model's job is writing content for whatever indices selection hands it,
  // never choosing which indices matter. Direction here is the source's label
  // (known before the AI call); the model's own re-judgment only lands in the
  // response, too late to drive selection. Accepted minor imprecision: an item
  // may render under a different section than the one it was selected in.
  const picked = selectBalanced(scoredAll, CATEGORY_ORDER);
  const countBy = (tier: Tier) => picked.filter((p) => p.tier === tier).length;
  console.log(
    `今日 ${raw.signals.length} 条新信号 → 按方向均衡选取 ${picked.length} 条（详写 ${countBy("full")}、简讯 ${countBy("brief")}）；` +
      `其余 ${raw.signals.length - picked.length} 条已入库、不会重复抓取，只是不进今天的主推。`,
  );
  for (const category of CATEGORY_ORDER) {
    const inCategory = picked.filter((p) => p.item.signal.category === category).length;
    const total = scoredAll.filter((s) => s.signal.category === category).length;
    if (total > 0) console.log(`  ${(CATEGORY_LABELS[category] ?? category).padEnd(10)} ${inCategory}/${total}`);
  }

  const leaders = pickCategoryLeaders(picked);
  const overviewIndexSet = new Set(leaders.map((entry) => entry.index));
  const topIndexSet = new Set(
    [...leaders]
      .sort((a, b) => scoreOf(b.item) - scoreOf(a.item))
      .slice(0, Math.min(MAX_TOP_STORIES, leaders.length))
      .map((entry) => entry.index),
  );

  // Raised 5,000 -> 16,000 -> 60,000 across two real incidents (67 signals
  // truncated at 5,000 on 2026-08-03; 224 truncated at 16,000 on 2026-09-13).
  // Input is now bounded by selection (≤ 10 per direction), so this is
  // comfortable headroom, far under DeepSeek's 384k-token output ceiling.
  const duplicateGroups = findLikelyDuplicateGroups(picked.map((p) => ({ title: p.item.signal.title, category: p.item.signal.category }))).map((group) =>
    group.map((i) => i + 1),
  );
  const { system, user } = buildDigestPrompt(picked, topIndexSet, overviewIndexSet, duplicateGroups);
  // The model occasionally returns well-formed JSON that misses the schema (seen
  // 2026-10-09: one run in several failed validation, the next identical run
  // passed). A single such miss must not cost a whole day's digest, so retry —
  // the same lesson as 2026-09-13, when one failure cascaded into a lost fortnight.
  const MAX_SCHEMA_ATTEMPTS = 3;
  let result = await client.completeJson({ system, user, maxTokens: 60_000 });
  let parsed: z.infer<typeof digestResponseSchema> | undefined;
  for (let attempt = 1; ; attempt++) {
    const check = digestResponseSchema.safeParse(result.value);
    if (check.success) {
      parsed = check.data;
      break;
    }
    const issues = check.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    if (attempt >= MAX_SCHEMA_ATTEMPTS) {
      throw new DeepSeekError(`DeepSeek 返回内容不符合预期结构（已重试 ${attempt} 次）：${issues}`, "schema_mismatch");
    }
    console.warn(`DeepSeek 返回内容不符合预期结构（第 ${attempt}/${MAX_SCHEMA_ATTEMPTS} 次）：${issues}；重新生成。`);
    result = await client.completeJson({ system, user, maxTokens: 60_000 });
  }

  const markdown = renderDigest(dateStr, parsed, picked, topIndexSet, overviewIndexSet, duplicateGroups);
  const outPath = `digests/${dateStr}.md`;
  await mkdir("digests", { recursive: true });
  await writeFile(outPath, markdown, "utf8");
  console.log(`主推已生成：${outPath}`);
  console.log(`模型：${result.model}，用量：${result.usage.totalTokens} tokens`);

  const candidates = picked
    .map((p) => p.item)
    .filter(
      (item) =>
        item.confidence >= SUB_PUSH_SCORE_THRESHOLD &&
        item.heat >= SUB_PUSH_SCORE_THRESHOLD &&
        item.signal.summary.length >= SUB_PUSH_MIN_SUMMARY_LENGTH,
    )
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, MAX_SUB_PUSH_ITEMS);

  if (candidates.length === 0) {
    console.log("没有条目同时达到置信度/热度门槛（都需 ≥60）且信息量足够，今天不生成子推送。");
    return;
  }

  for (const candidate of candidates) {
    const subPushResult = await client.completeJson({
      ...buildSubPushPrompt(candidate),
      maxTokens: 2_000,
      temperature: 0.4,
    });
    let subPushParsed: z.infer<typeof subPushResponseSchema>;
    try {
      subPushParsed = subPushResponseSchema.parse(subPushResult.value);
    } catch (error) {
      console.error(
        `子推送生成失败（${candidate.signal.title}）：${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const subPushMarkdown = renderSubPush(candidate, subPushParsed);
    const slug = candidate.signal.externalId ? shortHash(candidate.signal.externalId) : shortHash(candidate.signal.title);
    const subPushPath = `digests/${dateStr}-子推送-${slug}.md`;
    await writeFile(subPushPath, subPushMarkdown, "utf8");
    console.log(`子推送已生成：${subPushPath}（置信度 ${candidate.confidence}，热度 ${candidate.heat}，仅供内部参考，不会出现在正文里）`);
  }
}

interface LeaderEntry {
  index: number;
  item: ScoredSignal;
}

/** Best full-tier item per direction (1-based index into `picked`) — at most one per direction that has any, so up to 6. */
function pickCategoryLeaders(picked: Selected[]): LeaderEntry[] {
  const best = new Map<string, LeaderEntry>();
  picked.forEach((p, i) => {
    if (p.tier !== "full") return;
    const category = p.item.signal.category;
    const current = best.get(category);
    if (!current || scoreOf(p.item) > scoreOf(current.item)) best.set(category, { index: i + 1, item: p.item });
  });
  return [...best.values()];
}

async function readRawSignals(path: string): Promise<{ signals: RawSignal[] } | null> {
  try {
    const body = await readFile(path, "utf8");
    const parsed = JSON.parse(body) as { signals?: RawSignal[] };
    return { signals: parsed.signals ?? [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// 3 calendar days back reliably reaches the previous Mon/Wed/Fri collection
// run in every case (Monday needs Friday, 3 days back; Wednesday and Friday
// each only need 2) — see the corroboration-window note on scoreSignals.
const CONTEXT_LOOKBACK_DAYS = 3;

async function readRecentContextSignals(todayStr: string): Promise<RawSignal[]> {
  const [year, month, day] = todayStr.split("-").map(Number) as [number, number, number];
  const context: RawSignal[] = [];
  for (let offset = 1; offset <= CONTEXT_LOOKBACK_DAYS; offset++) {
    const date = new Date(Date.UTC(year, month - 1, day - offset));
    const dateStr = date.toISOString().slice(0, 10);
    const raw = await readRawSignals(`data/raw/${dateStr}.json`);
    if (raw) context.push(...raw.signals);
  }
  return context;
}

const SOURCE_BY_SLUG = new Map(sources.map((source) => [source.slug, source]));

/** What kind of voice a source is — shown to the model so it can settle contradictions. */
function sourceTypeLabel(signal: RawSignal): string {
  const source = SOURCE_BY_SLUG.get(signal.sourceSlug);
  if (source?.sourceType === "brand") return "品牌官方信源";
  if (source?.isPrimary) return "官方机构信源";
  return "媒体/综合信源";
}

function buildDigestPrompt(
  picked: Selected[],
  topIndexSet: Set<number>,
  overviewIndexSet: Set<number>,
  duplicateGroups: number[][],
): { system: string; user: string } {
  const system = `你是一个摩托车行业快讯编辑，参考 36 氪"互联网人资讯早餐"（8点1氪）的结构：像一篇写得流畅的中文新闻简报，直接陈述事实和文章里的观点。你自己不发表任何观点或推测；文章里已有的判断、评价、预测属于新闻内容，直接融进叙述里即可。

**全部输出必须是中文**，包括标题、速览、正文——即使原始新闻是英语、印尼语、马来语等其他语言，也要翻译成中文再写，不要直接照抄原文语言。人名、品牌名、车型名等专有名词可以保留原文或用通用中文译名，但句子本身必须是中文。

只能使用用户提供的信息，不能编造任何数据、时间或事实。如果信息不完整就照实精简，不要补充你"猜测"的内容。

部分条目标注"时间：未知"——这些是抓取时拿不到真实发布日期的旧文章（不是今天发生的事），不要把它们当成"最新"/"今日"新闻处理。

**每条输入前面【】里的类别是信源的固定标签，不是这篇文章自己的类别**——信源本身可能什么都发（比如一个以"全球新车发布"为主的媒体站，也会顺带发地方新闻、抽奖推广这类不相关内容）。请你根据标题和摘要的实际内容，重新判断这篇文章真正属于六个方向里的哪一个：racing（赛事赛果）/new-models（全球新车发布）/tech（技术工程解读）/industry（产业商业动态）/local-market（本地车市）/culture（骑行文化车展活动），不要直接照抄输入里给的标签。

**local-market（本地车市）专指新加坡/马来西亚/印尼等东南亚市场的动态**（这是频道的目标受众所在地），不是"随便哪个国家的本地新闻"都算——比如英国的通勤停车税新闻，虽然是"某地的本地新闻"，但不属于东南亚市场，不要归进 local-market；这类内容按实际主题改判到更贴切的类别（如 industry 或 culture）。

**同时判断每条是否跟摩托车/摩托车行业真正相关**（relevant）。像地方政府贪腐挪用公款（哪怕买的是摩托艇/ATV）、跟摩托车无关的纯推广抽奖这类内容，摩托车媒体站有时也会顺带发，但跟摩托车选题无关，这类请标 relevant: false，不会出现在最终产出里。**四轮汽车/电动汽车相关内容也算不相关**——部分信源（如 Kompas.com Otomotif）是覆盖全品类车辆的综合汽车站，不是纯摩托车站，顺带发的汽车新闻（哪怕是同一品牌，比如某车企的电动汽车新品）请标 relevant: false，不要因为发布在"汽车资讯"站上就当成摩托车相关内容。纯促销、抽奖、限时优惠类稿件（"限时 XX 元""抽奖送车"）也不算新闻，标 relevant: false。

**选择哪些条目、进哪个层级不是你的工作，已经用打分公式按方向选好了**——你只负责写内容。每条输入前面的标记告诉你它属于哪一层：

1. **【今日头条】**：body 写 250-350 字，分 2-3 个自然段（段落之间用两个换行），讲清楚事情经过和关键数据，**要说清楚这条新闻为什么够格上头条**（涉及的品牌/规模、影响范围、意外程度），并把文章里最有信息量的判断和评价自然地写进去。
2. **【详写】/【本方向今日代表】**：body 写 120-220 字，分 1-2 个自然段（段落之间用两个换行），让读者不点进原文也能读懂：先交代发生了什么、关键数据和背景，再把文章里的判断、评价、原因分析自然地写进叙述——直接陈述内容，像一篇写好的新闻稿，**不要逐句加"某某表示/认为/指出"这类转述框架，不要写"某媒体的评论认为"，也不要大段引用原话**；需要点明是谁说的时候，一句话带过即可。
3. **【简讯】**：body **只写一句话**（不超过 60 个字），点出发生了什么，不分段、不展开。

**可读性第一**：这是给人快速浏览的简报，不是原文翻译。宁可精炼也不要写成大段文字——超出上面的字数上限算失败。新车/产品类稿件不要罗列全部配置参数，只挑最重要的 3-5 项（价格、核心卖点、与上一代的变化）；长篇采访只挑最有信息量的 1-2 个判断，不要把所有表态都搬进来。

**长度由材料决定，不要为了凑字数扩写**：如果某条输入只有一两句话（比如只有标题和一句简介），就只写一两句，宁短勿编；如果材料里没有任何判断或评价，就只写事实，**绝不能自己编造观点**。

**同一件事被多个信源报道时要合并**（不同信源、不同语言都算同一件事，比如德语站和英语官网都在报同一场比赛的同一个新闻点）：只为其中信息最全的一条写 item，综合所有来源的信息来写，并把被并入的其余条目编号放进该 item 的 "merged" 数组——被并入的编号**不要**再单独出现在 items 里。不是同一件事就不要硬并（同一场比赛的不同新闻点是不同的事）。

**各来源说法矛盾时的取舍**：每条输入前标注了信源类型。如果合并的几条在事实上互相矛盾（价格、日期、参数、结果等），以【品牌官方信源】的说法为准，其次是【官方机构信源】，最后才是【媒体/综合信源】，并在正文里用一句话点明"各方说法有出入"。品牌官方信源只在涉及它自己品牌的事实问题上优先，不代表它的评价性说法更可信。

输出必须是 JSON：
{
  "headline": "把当天 2-3 条最重磅新闻的关键词揉进一句话标题",
  "overview": [ { "index": <编号>, "text": "一句话速览" } ]——**只能包含标了【今日头条】或【本方向今日代表】的条目，每条一句话概括，不展开**，
  "items": [
    { "index": <对应输入条目的编号>, "heading": "一行小标题，加粗一句话，不用 markdown # 标题", "body": "正文，长度按上面对应层级的要求", "category": "重新判断后的真实类别", "relevant": true或false, "merged": [被并入的编号，没有就省略] }
  ]
}

每条输入要么作为一个 item 出现（包括 relevant: false 的，程序会负责过滤，不要自己先跳过不写），要么出现在某个 item 的 merged 里。index 必须精确对应输入列表里的编号，不要自己编号。body 里不要包含来源括号——来源标注由程序自动加在每条后面。`;

  const itemLines = picked
    .map(({ item, tier }, i) => {
      const index = i + 1;
      const { signal } = item;
      const marker = topIndexSet.has(index)
        ? "【今日头条】"
        : overviewIndexSet.has(index)
          ? "【本方向今日代表】"
          : tier === "brief"
            ? "【简讯】"
            : "【详写】";
      const chars = tier === "brief" ? BRIEF_CHARS_PER_SIGNAL : FULL_CHARS_PER_SIGNAL;
      return `${index}. ${marker}【${sourceTypeLabel(signal)}｜信源固定标签：${signal.category}，仅供参考，请你重新判断真实类别】${signal.title}\n   来源：${signal.sourceName}　时间：${dateLabelFor(signal)}\n   正文：${signal.summary.slice(0, chars)}`;
    })
    .join("\n\n");

  const duplicateLines = duplicateGroups.map((group) => `- 编号 ${group.join("、")}`).join("\n");
  const duplicateHint =
    duplicateGroups.length > 0
      ? `\n\n**程序检测到下面几组条目的标题里含有相同的车型代号，很可能是同一件事，请优先合并（按上面的规则写一个 item，其余放进 merged）：**\n${duplicateLines}\n（如果你读完正文确认其中某几条其实是不同的事，就不要合并。）`
      : "";
  const user = `今天从各信源按方向均衡选出 ${picked.length} 条，请据此生成主推：\n\n${itemLines}${duplicateHint}`;
  return { system, user };
}

function dateLabelFor(signal: RawSignal): string {
  const date = new Date(signal.publishedAt);
  return signal.rawMeta.dateInferred === true || Number.isNaN(date.getTime())
    ? "未知"
    : date.toISOString().slice(0, 10);
}

function renderDigest(
  dateStr: string,
  digest: z.infer<typeof digestResponseSchema>,
  picked: Selected[],
  topIndexSet: Set<number>,
  overviewIndexSet: Set<number>,
  duplicateGroups: number[][],
): string {
  const signalAt = (index: number) => picked[index - 1]?.item.signal;
  const relevantIndexSet = new Set(digest.items.filter((item) => item.relevant).map((item) => item.index));

  // Merges are validated here, in code, not trusted from the prompt: a merged
  // index must exist, must not be the item itself, and must not itself be a
  // merge target (which would make two items swallow each other and show
  // neither). Merged-in items are not rendered on their own; their sources are
  // added to the citation of the item that absorbed them.
  const mergeTargets = new Set(digest.items.filter((item) => (item.merged ?? []).length > 0).map((item) => item.index));
  const mergedInto = new Map<number, number>();
  for (const item of digest.items) {
    for (const child of item.merged ?? []) {
      if (child === item.index || !signalAt(child) || mergeTargets.has(child) || mergedInto.has(child)) continue;
      mergedInto.set(child, item.index);
    }
  }
  // Backstop for the same job: the model merges unreliably, so for each likely-duplicate
  // group (shared model code) that it left as separate items, fold the group's brief-tier
  // members into its best full-tier item — the full item already covers the event, a second
  // one-liner about it is just a repeat. Only briefs are folded, so no full write-up is lost.
  const itemIndexSet = new Set(digest.items.filter((item) => item.relevant).map((item) => item.index));
  for (const group of duplicateGroups) {
    const live = group.filter((index) => itemIndexSet.has(index) && !mergedInto.has(index) && !mergeTargets.has(index));
    const keeper = live
      .filter((index) => picked[index - 1]?.tier === "full")
      .sort((a, b) => scoreOf(picked[b - 1]!.item) - scoreOf(picked[a - 1]!.item))[0];
    if (keeper === undefined) continue;
    for (const index of live) {
      if (index !== keeper && picked[index - 1]?.tier === "brief") mergedInto.set(index, keeper);
    }
  }
  const absorbed = (index: number) =>
    [...mergedInto.entries()].filter(([, parent]) => parent === index).map(([child]) => child);

  const lines: string[] = [];
  lines.push(`# ${digest.headline}`, "");
  lines.push(`> ${dateStr}`, "");
  lines.push("## 今日热点导览", "");
  // Code-enforced against overviewIndexSet, not just the prompt instruction —
  // a plain "only include X" instruction wasn't reliably followed before
  // (found 2026-08-01).
  for (const highlight of digest.overview) {
    if (overviewIndexSet.has(highlight.index) && relevantIndexSet.has(highlight.index)) {
      lines.push(`- ${highlight.text}`);
    }
  }
  lines.push("");

  type DigestItem = (typeof digest.items)[number];
  const citationFor = (item: DigestItem) => {
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const index of [item.index, ...absorbed(item.index)]) {
      const signal = signalAt(index);
      if (!signal || seen.has(signal.url)) continue;
      seen.add(signal.url);
      parts.push(`[${signal.sourceName}](${signal.url})`);
    }
    return parts.length > 0 ? `（${parts.join("、")}）` : "";
  };
  const itemScore = (item: DigestItem) =>
    Math.max(...[item.index, ...absorbed(item.index)].map((index) => (picked[index - 1] ? scoreOf(picked[index - 1]!.item) : 0)));

  const renderFull = (item: DigestItem) => {
    lines.push(`**${item.heading}**`, "");
    lines.push(`${item.body}${citationFor(item)}`, "");
  };

  // relevant: false — content the model judged isn't genuinely about
  // motorcycles/the moto industry (found 2026-08-01: a local-government
  // corruption story and a giveaway promo from a moto-focused site). Dropped
  // entirely, not just miscategorized.
  const relevantItems = digest.items.filter((item) => item.relevant && !mergedInto.has(item.index));

  const topItems = relevantItems.filter((item) => topIndexSet.has(item.index));
  if (topItems.length > 0) {
    lines.push("## 今日头条", "");
    for (const item of topItems) renderFull(item);
  }

  // Grouped by the model's own re-judged category, not the source's label. Each
  // section: the best FULL_PER_CATEGORY full-tier items in full, then everything
  // else that fits (brief-tier items and any full-tier overflow) as one-line
  // briefs, capped — so no direction can run long, and heat decides what stays.
  const byCategory = new Map<string, DigestItem[]>();
  for (const item of relevantItems) {
    if (topIndexSet.has(item.index)) continue;
    const bucket = byCategory.get(item.category) ?? [];
    bucket.push(item);
    byCategory.set(item.category, bucket);
  }
  const orderedCategories = [
    ...CATEGORY_ORDER.filter((category) => byCategory.has(category)),
    ...[...byCategory.keys()].filter((category) => !CATEGORY_ORDER.includes(category)),
  ];

  for (const category of orderedCategories) {
    lines.push(`## ${CATEGORY_LABELS[category] ?? category}`, "");
    const ranked = [...(byCategory.get(category) ?? [])].sort((a, b) => itemScore(b) - itemScore(a));
    const fullItems = ranked.filter((item) => picked[item.index - 1]?.tier === "full").slice(0, FULL_PER_CATEGORY);
    const fullSet = new Set(fullItems.map((item) => item.index));
    const briefItems = ranked.filter((item) => !fullSet.has(item.index)).slice(0, BRIEF_PER_CATEGORY);

    for (const item of fullItems) renderFull(item);
    if (briefItems.length > 0) {
      lines.push("### 其他动态", "");
      for (const item of briefItems) {
        const text = picked[item.index - 1]?.tier === "brief" ? item.body : firstSentence(item.body);
        lines.push(`- **${item.heading}**：${text}${citationFor(item)}`);
      }
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Per-category analysis framework for 子推送 — mirrors how a 36Kr deep-dive
 * piece is actually structured (hook → unpack details → personal verdict →
 * open question to the reader), adapted per news type. An incident/recall
 * override applies regardless of category, since "who's affected, what
 * should you do" matters more than the category's usual angle there.
 */
const SUB_PUSH_FRAMEWORKS: Record<string, string> = {
  "new-models": '分析框架"值不值得写"：先说清楚定价，再拆解核心卖点/参数，然后跟同价位竞品横向对比，最后给出个人判断——值不值、适合什么样的骑手。',
  racing: '分析框架"看点回顾"：先说清楚比赛结果，再讲关键转折点，然后解读车手/车队表现说明了什么，最后聊对后续积分榜/赛季走势的影响。',
  industry: '分析框架"数字背后"：先呈现数字本身，再放进历史数据/同行对比里看这算好算坏，然后挖这个数字背后藏着的行业信号，最后给个人解读。',
  tech: '分析框架"技术拆解"：先说清楚这项技术解决了什么问题，再跟现有方案比好在哪，最后判断实际意义有多大——是真突破还是营销话术。',
  "local-market": '分析框架"本地影响"：先说清楚发生了什么，再讲对当地车主/市场的具体影响，然后挖背后原因，最后给个人观点。',
  culture: '分析框架"现场观察"：先说清楚事件本身，再讲亮点/看点，然后聊对行业/骑行文化的意义，最后给个人感受。',
};
const INCIDENT_FRAMEWORK = '分析框架"利益相关"：先说清楚发生了什么，再讲哪些车主/哪些地区受影响，然后给车主具体的行动建议，最后分析背后原因、评价企业处理方式。';
const INCIDENT_KEYWORDS = /召回|事故|故障|漏油|起火|安全隐患|recall|crash|fire hazard|malfunction/i;

function frameworkFor(signal: RawSignal): string {
  if (INCIDENT_KEYWORDS.test(`${signal.title} ${signal.summary}`)) return INCIDENT_FRAMEWORK;
  return SUB_PUSH_FRAMEWORKS[signal.category] ?? '分析框架：先交代背景，再展开细节，然后给个人判断，最后抛一个问题给读者。';
}

function buildSubPushPrompt(candidate: ScoredSignal): { system: string; user: string } {
  const { signal } = candidate;
  const system = `你是一个摩托车内容创作者，为中文摩托车 YouTube 频道写深度评论文章，风格参考 36 氪的产品测评文章：口语化第一人称，有明确的个人态度和判断，用短句和自然的转折词组织行文（不是分点罗列），结尾习惯抛一个开放式问题给读者互动。

只能基于用户提供的这条新闻内容做分析，不能编造它没提到的数据或事实；你的个人判断/态度可以是主观的，但不要把猜测包装成确凿事实——该说"我觉得""大概率"的地方就明确说是自己的判断。

这条新闻请用这个${frameworkFor(signal)}

输出必须是 JSON：
{
  "hook": "开头一两句，用一个贴近读者的观察或问题把话题引出来，不要直接复述新闻标题",
  "body": "正文，按上面的分析框架展开，口语化、有个人态度，段落之间用两个换行分隔，不用分点小标题",
  "verdict": "一两句话的个人结论/判断",
  "closingQuestion": "结尾抛给读者的一个开放式问题"
}`;
  const user = `新闻标题：${signal.title}\n类别：${signal.category}\n来源：${signal.sourceName}\n摘要：${signal.summary}`;
  return { system, user };
}

function renderSubPush(candidate: ScoredSignal, content: z.infer<typeof subPushResponseSchema>): string {
  const { signal } = candidate;
  const lines: string[] = [];
  lines.push(`# ${signal.title}`, "");
  lines.push(content.hook, "");
  lines.push(content.body, "");
  lines.push(content.verdict, "");
  lines.push(content.closingQuestion, "");
  lines.push(`（[${signal.sourceName}](${signal.url})）`);
  return `${lines.join("\n").trimEnd()}\n`;
}

function shortHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
