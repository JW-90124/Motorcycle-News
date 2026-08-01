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
import { clusterSignals, independentSourceCount } from "./domain/clustering.js";
import { scoreConfidence, scoreHeat } from "./domain/scoring.js";
import { sources } from "./sources.js";
import type { CollectedSignal } from "./types.js";

type RawSignal = CollectedSignal & { sourceSlug: string; sourceName: string };

interface ScoredSignal {
  signal: RawSignal;
  confidence: number;
  heat: number;
  clusterSize: number;
}

const SUB_PUSH_SCORE_THRESHOLD = 60;
// A "骨架新闻" (bare announcement with no real detail) can still score high
// on confidence/heat but has nothing to actually analyze — found 2026-07-31
// on a thin Yamaha personnel announcement that produced a hollow sub-push.
const SUB_PUSH_MIN_SUMMARY_LENGTH = 60;
const MAX_SUB_PUSH_ITEMS = 2;
const MAX_TOP_STORIES = 3;

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
  overview: z.array(z.object({ index: z.number().int().positive(), text: z.string().min(1) })).min(1).max(10),
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
  const dateStr = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Singapore" }).format(new Date());
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

  const client = new DeepSeekClient({ apiKey });
  const scored = scoreSignals(raw.signals);

  const topIndexSet = new Set(
    [...scored]
      .map((item, i) => ({ item, index: i + 1 }))
      .sort((a, b) => b.item.heat + b.item.confidence - (a.item.heat + a.item.confidence))
      .slice(0, Math.min(MAX_TOP_STORIES, scored.length))
      .map((entry) => entry.index),
  );

  const { system, user } = buildDigestPrompt(raw.signals, topIndexSet);
  const result = await client.completeJson({ system, user, maxTokens: 5_000 });

  let parsed: z.infer<typeof digestResponseSchema>;
  try {
    parsed = digestResponseSchema.parse(result.value);
  } catch (error) {
    throw new DeepSeekError(
      `DeepSeek 返回内容不符合预期结构：${error instanceof Error ? error.message : String(error)}`,
      "schema_mismatch",
    );
  }

  const markdown = renderDigest(dateStr, parsed, raw.signals, topIndexSet);
  const outPath = `digests/${dateStr}.md`;
  await mkdir("digests", { recursive: true });
  await writeFile(outPath, markdown, "utf8");
  console.log(`主推已生成：${outPath}`);
  console.log(`模型：${result.model}，用量：${result.usage.totalTokens} tokens`);

  const candidates = scored
    .filter(
      (item) =>
        item.confidence >= SUB_PUSH_SCORE_THRESHOLD &&
        item.heat >= SUB_PUSH_SCORE_THRESHOLD &&
        item.signal.summary.length >= SUB_PUSH_MIN_SUMMARY_LENGTH,
    )
    .sort((a, b) => b.heat + b.confidence - (a.heat + a.confidence))
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

function buildDigestPrompt(signals: RawSignal[], topIndexSet: Set<number>): { system: string; user: string } {
  const system = `你是一个摩托车行业快讯编辑，参考 36 氪"互联网人资讯早餐"（8点1氪）的结构：纯事实快讯体，客观中性，绝不夹带个人观点或推测。

**全部输出必须是中文**，包括标题、速览、正文——即使原始新闻是英语、印尼语、马来语等其他语言，也要翻译成中文再写，不要直接照抄原文语言。人名、品牌名、车型名等专有名词可以保留原文或用通用中文译名，但句子本身必须是中文。

只能使用用户提供的信息，不能编造任何数据、时间或事实。如果信息不完整就照实精简，不要补充你"猜测"的内容。

部分条目标注"时间：未知"——这些是抓取时拿不到真实发布日期的旧文章（不是今天发生的事），不要把它们当成"最新"/"今日"新闻处理，也不要优先选进 overview。

**每条输入前面【】里的类别是信源的固定标签，不是这篇文章自己的类别**——信源本身可能什么都发（比如一个以"全球新车发布"为主的媒体站，也会顺带发地方新闻、抽奖推广这类不相关内容）。请你根据标题和摘要的实际内容，重新判断这篇文章真正属于六个方向里的哪一个：racing（赛事赛果）/new-models（全球新车发布）/tech（技术工程解读）/industry（产业商业动态）/local-market（本地车市）/culture（骑行文化车展活动），不要直接照抄输入里给的标签。

**同时判断每条是否跟摩托车/摩托车行业真正相关**（relevant）。像地方政府贪腐挪用公款（哪怕买的是摩托艇/ATV）、跟摩托车无关的纯推广抽奖这类内容，摩托车媒体站有时也会顺带发，但跟摩托车选题无关，这类请标 relevant: false，不会出现在最终产出里。

结构分三层，都要产出：
1. **overview**（今日热点导览）：5-10 条一句话速览，覆盖今天信号里最值得关注的内容（跳过 relevant: false 的），一眼扫完；不展开、不重复讲细节。
2. **重点展开条目**（输入里标了"【重点展开】"的那几条，对应"今日头条"）：这几条要写得比其他条目更长更详细——多写 1-2 句具体数据/背景/影响，让读者不用点进原文也能完整了解这条新闻，不是随便加长凑字数。如果这条其实 relevant: false，正常标注就好，程序会自动跳过不展示。
3. **普通条目**（其余的）：跟之前一样，1-2 段事实陈述即可，不用刻意加长。

输出必须是 JSON：
{
  "headline": "把当天 2-3 条最重磅新闻的关键词揉进一句话标题",
  "overview": [ { "index": <这条速览对应的输入条目编号>, "text": "一句话速览" } ],
  "items": [
    { "index": <对应输入条目的编号>, "heading": "一行小标题，加粗一句话，不用 markdown # 标题", "body": "正文，标了重点展开的条目要写得更详细", "category": "重新判断后的真实类别", "relevant": true或false }
  ]
}

items 里每条输入都要出现一次（包括 relevant: false 的，程序会负责过滤，不要自己先跳过不写）。index 必须精确对应输入列表里的编号，不要自己编号。overview 的 index 也必须对应输入编号——**程序会用这个 index 去对照 items 里的 relevant 字段自动过滤，不用你自己判断要不要写进 overview**，正常挑你觉得最值得关注的条目写就行。body 里不要包含来源括号——来源标注由程序自动加在每条后面。`;

  const itemLines = signals
    .map((signal, i) => {
      const index = i + 1;
      const marker = topIndexSet.has(index) ? "【重点展开】" : "";
      return `${index}. ${marker}【信源固定标签：${signal.category}，仅供参考，请你重新判断真实类别】${signal.title}\n   来源：${signal.sourceName}　时间：${dateLabelFor(signal)}\n   摘要：${signal.summary.slice(0, 800)}`;
    })
    .join("\n\n");

  const user = `今天收集到 ${signals.length} 条新信号，请据此生成主推：\n\n${itemLines}`;
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
  signals: RawSignal[],
  topIndexSet: Set<number>,
): string {
  const relevantIndexSet = new Set(digest.items.filter((item) => item.relevant).map((item) => item.index));

  const lines: string[] = [];
  lines.push(`# ${digest.headline}`, "");
  lines.push(`> ${dateStr}`, "");
  lines.push("## 今日热点导览", "");
  for (const highlight of digest.overview) {
    if (relevantIndexSet.has(highlight.index)) lines.push(`- ${highlight.text}`);
  }
  lines.push("");

  const renderItem = (item: (typeof digest.items)[number]) => {
    const signal = signals[item.index - 1];
    lines.push(`**${item.heading}**`, "");
    const citation = signal ? `（[${signal.sourceName}](${signal.url})）` : "";
    lines.push(`${item.body}${citation}`, "");
  };

  // relevant: false — content the model judged isn't genuinely about
  // motorcycles/the moto industry, even though the source published it
  // (found 2026-08-01: RideApart, a moto-focused source, also ran a local
  // government corruption story that happened to mention PWCs/ATVs, and an
  // unrelated giveaway promo). Dropped entirely, not just miscategorized.
  const relevantItems = digest.items.filter((item) => item.relevant);

  const topItems = relevantItems.filter((item) => topIndexSet.has(item.index));
  if (topItems.length > 0) {
    lines.push("## 今日头条", "");
    for (const item of topItems) renderItem(item);
  }

  // Grouped by the model's own re-judged category (item.category), not the
  // source's fixed label — see buildDigestPrompt for why the label alone
  // isn't trustworthy per-article.
  const remainingByCategory = new Map<string, typeof digest.items>();
  for (const item of relevantItems) {
    if (topIndexSet.has(item.index)) continue;
    const bucket = remainingByCategory.get(item.category) ?? [];
    bucket.push(item);
    remainingByCategory.set(item.category, bucket);
  }

  const orderedCategories = [
    ...CATEGORY_ORDER.filter((category) => remainingByCategory.has(category)),
    ...[...remainingByCategory.keys()].filter((category) => !CATEGORY_ORDER.includes(category)),
  ];

  for (const category of orderedCategories) {
    lines.push(`## ${CATEGORY_LABELS[category] ?? category}`, "");
    for (const item of remainingByCategory.get(category) ?? []) renderItem(item);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Confidence/heat per signal — see domain/scoring.ts for the formulas.
 * independentSourceCount comes from clustering this run's signals against
 * each other (agent-pulse-style token/fingerprint matching, scaled down —
 * see domain/clustering.ts).
 */
function scoreSignals(signals: RawSignal[]): ScoredSignal[] {
  const clusters = clusterSignals(signals);
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
