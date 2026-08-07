#!/usr/bin/env node
/**
 * Weekly digest CLI — summarizes the most recently *completed* ISO week
 * (last Monday-Sunday, Asia/Singapore), not the week in progress. Meant to
 * run once, on Monday, after that day's own daily digest — by then the
 * prior week is fully closed out, so "last week" always means a complete
 * Mon-Sun span, never a partial one. Reads whichever `data/raw/{date}.json`
 * files exist in that range (only Mon/Wed/Fri will, given the collection
 * cadence), scores every signal (reusing domain/score-signals.ts, the same
 * formulas the daily 主推 uses), and picks the top 10 distinct stories.
 * Unlike the daily 主推, this is allowed a personal point of view — the
 * user's own request 2026-08-07: a weekly roundup with "自己的观点和解读"
 * per item, not just facts. Written separately from digest.ts (not a mode
 * flag on it) since the selection window, dedup granularity, and voice are
 * all different enough that sharing one entry point would mean threading a
 * lot of conditionals through code that's otherwise a clean daily pipeline.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { DeepSeekClient, DeepSeekError } from "./ai/deepseek.js";
import { clusterSignals } from "./domain/clustering.js";
import { scoreSignals } from "./domain/score-signals.js";
import type { RawSignal, ScoredSignal } from "./domain/score-signals.js";

const WEEKLY_TOP_N = 10;

const weeklyResponseSchema = z.object({
  headline: z.string().min(1),
  briefing: z.string().min(1),
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

async function main() {
  const todayStr = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Singapore" }).format(new Date());
  const thisMonday = mondayOf(todayStr);
  const lastMonday = addDays(thisMonday, -7);
  const lastSunday = addDays(thisMonday, -1);
  const weekDates = datesFrom(lastMonday, lastSunday);

  const allSignals: RawSignal[] = [];
  for (const date of weekDates) {
    const raw = await readRawSignals(`data/raw/${date}.json`);
    if (raw) allSignals.push(...raw.signals);
  }

  if (allSignals.length === 0) {
    console.log(`上周（${lastMonday} 至 ${lastSunday}）没有任何抓取数据，跳过生成周报。`);
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("缺少 DEEPSEEK_API_KEY 环境变量，无法生成周报。不做静默兜底——宁可报错也不要生成占位内容。");
  }

  const scored = scoreSignals(allSignals);
  const scoreBySignal = new Map(scored.map((item) => [item.signal, item]));

  // One representative per cluster, not one entry per signal — the same
  // real-world event often gets covered by more than one source across the
  // week (that's exactly what raises its score, see score-signals.ts), but
  // a "top 10 stories" list should be 10 distinct stories, not the same
  // story appearing twice because two different articles about it both
  // scored highly.
  const clusters = clusterSignals(allSignals);
  const representatives: ScoredSignal[] = clusters.map((cluster) => {
    let best = scoreBySignal.get(cluster[0]!)!;
    for (const member of cluster) {
      const candidate = scoreBySignal.get(member)!;
      if (candidate.heat + candidate.confidence > best.heat + best.confidence) best = candidate;
    }
    return best;
  });

  const top10 = representatives
    .sort((a, b) => b.heat + b.confidence - (a.heat + a.confidence))
    .slice(0, WEEKLY_TOP_N);

  const client = new DeepSeekClient({ apiKey });
  const { system, user } = buildWeeklyPrompt(top10, lastMonday, lastSunday);
  const result = await client.completeJson({ system, user, maxTokens: 6_000, temperature: 0.5 });

  let parsed: z.infer<typeof weeklyResponseSchema>;
  try {
    parsed = weeklyResponseSchema.parse(result.value);
  } catch (error) {
    throw new DeepSeekError(
      `DeepSeek 返回内容不符合预期结构：${error instanceof Error ? error.message : String(error)}`,
      "schema_mismatch",
    );
  }

  const markdown = renderWeekly(lastMonday, lastSunday, parsed, top10);
  const outDir = "digests/weekly";
  await mkdir(outDir, { recursive: true });
  const outPath = `${outDir}/${lastMonday}.md`;
  await writeFile(outPath, markdown, "utf8");
  console.log(`周报已生成：${outPath}（上周 ${lastMonday} 至 ${lastSunday}，共 ${allSignals.length} 条信号，选出 ${top10.length} 条）`);
  console.log(`模型：${result.model}，用量：${result.usage.totalTokens} tokens`);
}

/** Monday of the ISO week containing dateStr (YYYY-MM-DD in, YYYY-MM-DD out). */
function mondayOf(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay(); // 0 = Sunday
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  date.setUTCDate(date.getUTCDate() + diffToMonday);
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function datesFrom(startStr: string, endStr: string): string[] {
  const [sy, sm, sd] = startStr.split("-").map(Number) as [number, number, number];
  const start = new Date(Date.UTC(sy, sm - 1, sd));
  const dates: string[] = [];
  const cursor = new Date(start);
  while (cursor.toISOString().slice(0, 10) <= endStr) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
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

function buildWeeklyPrompt(
  candidates: ScoredSignal[],
  mondayStr: string,
  lastDateStr: string,
): { system: string; user: string } {
  const system = `你是一个摩托车内容创作者，为中文摩托车 YouTube 频道写"上周十大热点"周报（回顾刚结束的一周），风格参考 36 氪产品测评文章：口语化，有明确的个人态度和判断，但绝不能把猜测包装成确凿事实——该说"我觉得""大概率"的地方就明确说是自己的判断。

**全部输出必须是中文**，即使原始新闻是英语、印尼语、马来语等其他语言，也要翻译成中文再写。人名、品牌名、车型名等专有名词可以保留原文或用通用中文译名。

只能使用用户提供的信息，不能编造任何数据、时间或事实。

**这 ${candidates.length} 条已经是上周热度最高的代表性事件（已用打分公式选好、去重过），排列顺序就是热度排序，不需要你重新判断哪条更重要**——你只负责写内容。

每条 body 写 150-220 字：先交代清楚这件事本身（事实），再给出你自己的解读或态度（这里允许主观评论，不是纯事实快讯）——可以点评这件事对行业/车迷意味着什么，也可以是你自己的态度或猜测方向，但要让读者分得清哪是事实哪是你的判断。

输出必须是 JSON：
{
  "headline": "把上周 2-3 条最重磅新闻的关键词揉进一句话标题",
  "briefing": "开场白，2-4 句，像播客开场一样点出上周的主线/趋势——是车手八卦密集，还是新车扎堆发布，还是行业动荡——可以有你自己的视角",
  "items": [
    { "index": <对应输入条目的编号>, "heading": "一行小标题，加粗一句话，不用 markdown # 标题", "body": "正文，事实+个人解读，150-220字" }
  ]
}

items 里每条输入都要出现一次，按输入给的顺序（已经是热度排序）。index 必须精确对应输入列表里的编号。body 里不要包含来源括号——来源标注由程序自动加在每条后面。`;

  const itemLines = candidates
    .map((item, i) => {
      const { signal } = item;
      return `${i + 1}. 【${signal.category}】${signal.title}\n   来源：${signal.sourceName}　时间：${dateLabelFor(signal)}\n   摘要：${signal.summary.slice(0, 800)}`;
    })
    .join("\n\n");

  const user = `上周（${mondayStr} 至 ${lastDateStr}）选出了 ${candidates.length} 条代表性热点，请据此生成周报：\n\n${itemLines}`;
  return { system, user };
}

function formatMonthDay(dateStr: string): string {
  const [, month, day] = dateStr.split("-").map(Number) as [number, number, number];
  return `${month}月${day}日`;
}

function dateLabelFor(signal: RawSignal): string {
  const date = new Date(signal.publishedAt);
  return signal.rawMeta.dateInferred === true || Number.isNaN(date.getTime())
    ? "未知"
    : date.toISOString().slice(0, 10);
}

function renderWeekly(
  mondayStr: string,
  lastDateStr: string,
  weekly: z.infer<typeof weeklyResponseSchema>,
  candidates: ScoredSignal[],
): string {
  const lines: string[] = [];
  lines.push(`# ${weekly.headline}`, "");
  lines.push(`> ${formatMonthDay(mondayStr)} – ${formatMonthDay(lastDateStr)}（上周）`, "");
  lines.push(weekly.briefing, "");
  lines.push("## 上周十大热点", "");

  const byIndex = new Map(weekly.items.map((item) => [item.index, item]));
  candidates.forEach((candidate, i) => {
    const item = byIndex.get(i + 1);
    if (!item) return;
    const { signal } = candidate;
    lines.push(`**${i + 1}. ${item.heading}**`, "");
    lines.push(`${item.body}（[${signal.sourceName}](${signal.url})）`, "");
  });

  return `${lines.join("\n").trimEnd()}\n`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
