#!/usr/bin/env node
/**
 * Digest CLI — stage 2 of the pipeline. Reads today's `data/raw/{date}.json`
 * (written by `collect.ts`), asks DeepSeek to turn the newly-collected
 * signals into a 36Kr《8点1氪》-style digest (see 输出结构.md in the
 * Obsidian knowledge base), and writes the result to `digests/{date}.md`.
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
import type { CollectedSignal } from "./types.js";

type RawSignal = CollectedSignal & { sourceSlug: string; sourceName: string };

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
  const { system, user } = buildPrompt(raw.signals);
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

function buildPrompt(signals: RawSignal[]): { system: string; user: string } {
  const system = `你是一个摩托车行业快讯编辑，风格严格模仿 36 氪《8点1氪》系列微信公众号文章：纯事实快讯体，客观中性，绝不夹带个人观点或推测，不分类别、按重要性/时效混排。

只能使用用户提供的信息，不能编造任何数据、时间或事实。如果信息不完整就照实精简，不要补充你"猜测"的内容。

输出必须是 JSON，结构为：
{
  "headline": "把当天 2-3 条最重磅新闻的关键词揉进一句话标题",
  "highlights": ["顶部速览要点，一句话，不展开", "..."],
  "items": [
    { "index": <对应输入条目的编号>, "heading": "一行小标题，加粗一句话，不用 markdown # 标题", "body": "1-2 段事实陈述，数据/时间直接写进句子里，不用表格，客观中性" }
  ]
}

items 里的顺序就是最终正文的顺序，按你判断的重要性/时效排列，不要按输入的类别分组。index 必须精确对应输入列表里的编号，不要自己编号。body 里不要包含来源括号——来源标注由程序自动加在每条后面。`;

  const itemLines = signals
    .map((signal, i) => {
      const date = new Date(signal.publishedAt);
      const dateLabel = Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
      return [
        `${i + 1}. 【${signal.category}】${signal.title}`,
        `   来源：${signal.sourceName}　时间：${dateLabel}`,
        `   摘要：${signal.summary.slice(0, 600)}`,
      ].join("\n");
    })
    .join("\n\n");

  const user = `今天收集到 ${signals.length} 条新信号，请据此生成主推：\n\n${itemLines}`;
  return { system, user };
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
