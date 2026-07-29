#!/usr/bin/env node
/**
 * Digest CLI — stage 2 of the pipeline. Reads today's `data/raw/{date}.json`
 * (written by `collect.ts`), asks DeepSeek to turn the newly-collected
 * signals into a 36Kr《8点1氪》-style digest (see 输出结构.md in the
 * Obsidian knowledge base), and writes the result to `digests/{date}.md`.
 *
 * Also scores every signal (confidence + heat — see domain/scoring.ts) and,
 * for the 1-2 signals that clear both thresholds, generates a separate
 * 子推送 (deep-dive commentary) file — independent of 主推, not a module
 * appended under it, per 输出结构.md.
 *
 * The model is only ever asked to select/order/summarize the signals it's
 * given and reference them by index — it never invents a source URL. The
 * citation link in the rendered output always comes from our own collected
 * data, not from model output, so a hallucinated URL can't end up in the
 * digest.
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

const SUB_PUSH_THRESHOLD = 60;
const MAX_SUB_PUSH_ITEMS = 2;

const digestResponseSchema = z.object({
  headline: z.string().min(1),
  highlights: z.array(z.string().min(1)).min(1).max(8),
  items: z
    .array(
      z.object({
        index: z.number().int().positive(),
        heading: z.string().min(1),
        body: z.string().min(1),
      }),
    )
    .min(1),
});

const subPushResponseSchema = z.object({
  keyFacts: z.array(z.string().min(1)).min(1).max(6),
  angles: z.array(z.string().min(1)).min(1).max(5),
  formatTags: z.array(z.string().min(1)).min(1).max(4),
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

  const { system, user } = buildDigestPrompt(raw.signals);
  const result = await client.completeJson({ system, user, maxTokens: 4_000 });

  let parsed: z.infer<typeof digestResponseSchema>;
  try {
    parsed = digestResponseSchema.parse(result.value);
  } catch (error) {
    throw new DeepSeekError(
      `DeepSeek 返回内容不符合预期结构：${error instanceof Error ? error.message : String(error)}`,
      "schema_mismatch",
    );
  }

  const markdown = renderDigest(dateStr, parsed, raw.signals);
  const outPath = `digests/${dateStr}.md`;
  await mkdir("digests", { recursive: true });
  await writeFile(outPath, markdown, "utf8");
  console.log(`主推已生成：${outPath}`);
  console.log(`模型：${result.model}，用量：${result.usage.totalTokens} tokens`);

  const scored = scoreSignals(raw.signals);
  const candidates = scored
    .filter((item) => item.confidence >= SUB_PUSH_THRESHOLD && item.heat >= SUB_PUSH_THRESHOLD)
    .sort((a, b) => b.heat + b.confidence - (a.heat + a.confidence))
    .slice(0, MAX_SUB_PUSH_ITEMS);

  if (candidates.length === 0) {
    console.log("没有条目同时达到置信度/热度门槛（都需 ≥60），今天不生成子推送。");
    return;
  }

  for (const candidate of candidates) {
    const subPushResult = await client.completeJson({
      ...buildSubPushPrompt(candidate),
      maxTokens: 1_200,
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
    console.log(`子推送已生成：${subPushPath}（置信度 ${candidate.confidence}，热度 ${candidate.heat}）`);
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

function buildDigestPrompt(signals: RawSignal[]): { system: string; user: string } {
  const system = `你是一个摩托车行业快讯编辑，风格严格模仿 36 氪《8点1氪》系列微信公众号文章：纯事实快讯体，客观中性，绝不夹带个人观点或推测，不分类别、按重要性/时效混排。

只能使用用户提供的信息，不能编造任何数据、时间或事实。如果信息不完整就照实精简，不要补充你"猜测"的内容。

部分条目标注"时间：未知"——这些是抓取时拿不到真实发布日期的旧文章（不是今天发生的事），不要把它们当成"最新"/"今日"新闻处理，也不要在标题和顶部速览里优先选它们；标题和速览优先用有确切时间的条目。

输出必须是 JSON，结构为：
{
  "headline": "把当天 2-3 条最重磅新闻的关键词揉进一句话标题",
  "highlights": ["顶部速览要点，一句话，不展开", "..."],
  "items": [
    { "index": <对应输入条目的编号>, "heading": "一行小标题，加粗一句话，不用 markdown # 标题", "body": "1-2 段事实陈述，数据/时间直接写进句子里，不用表格，客观中性" }
  ]
}

items 里的顺序就是最终正文的顺序，按你判断的重要性/时效排列，不要按输入的类别分组。index 必须精确对应输入列表里的编号，不要自己编号。body 里不要包含来源括号——来源标注由程序自动加在每条后面。`;

  const itemLines = signals.map((signal, i) => `${i + 1}. 【${signal.category}】${signal.title}\n   来源：${signal.sourceName}　时间：${dateLabelFor(signal)}\n   摘要：${signal.summary.slice(0, 600)}`).join("\n\n");

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
): string {
  const lines: string[] = [];
  lines.push(`# ${digest.headline}`, "");
  lines.push(`> ${dateStr}`, "");
  lines.push("**今日速览**", "");
  for (const highlight of digest.highlights) lines.push(`- ${highlight}`);
  lines.push("", "---", "");

  for (const item of digest.items) {
    const signal = signals[item.index - 1];
    lines.push(`**${item.heading}**`, "");
    const citation = signal ? `（[${signal.sourceName}](${signal.url})）` : "";
    lines.push(`${item.body}${citation}`, "");
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

function buildSubPushPrompt(candidate: ScoredSignal): { system: string; user: string } {
  const system = `你是一个摩托车内容策划，为一个中文摩托车 YouTube 频道挖掘选题角度。这是"子推送"——针对一条今天真正的热点新闻做深挖，不是快讯，可以带主观判断和策划建议。

只能基于用户提供的这条新闻内容，不能编造它没提到的数据或事实；"评论角度"可以是你的主观建议/判断，但要清楚是建议，不要包装成事实陈述。

输出必须是 JSON：
{
  "keyFacts": ["从这条新闻里提炼的关键数据/事实，每条一句话"],
  "angles": ["2-3 个可以切入做视频的观点角度，每条一句话说清楚角度是什么"],
  "formatTags": ["适合的视频形式，如：快评、深度解读、对比评测、开箱预告"]
}`;
  const user = `新闻标题：${candidate.signal.title}\n类别：${candidate.signal.category}\n来源：${candidate.signal.sourceName}\n摘要：${candidate.signal.summary}\n\n置信度评分：${candidate.confidence}/100　热度评分：${candidate.heat}/100（供参考，不用在输出里提这两个数字）`;
  return { system, user };
}

function renderSubPush(candidate: ScoredSignal, content: z.infer<typeof subPushResponseSchema>): string {
  const { signal } = candidate;
  const lines: string[] = [];
  lines.push(`# 子推送：${signal.title}`, "");
  lines.push(`> 置信度 ${candidate.confidence}/100　热度 ${candidate.heat}/100　（[${signal.sourceName}](${signal.url})）`, "");
  lines.push("## 关键数据", "");
  for (const fact of content.keyFacts) lines.push(`- ${fact}`);
  lines.push("", "## 我的评论角度", "");
  content.angles.forEach((angle, i) => lines.push(`${i + 1}. ${angle}`));
  lines.push("", "## 适合形式标签", "");
  lines.push(content.formatTags.join("、"));
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
