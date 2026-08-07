#!/usr/bin/env node
/**
 * Static site generator — stage 3 of the pipeline. Reads every
 * `digests/*.md` file and renders the public site (`site/`) for GitHub
 * Pages. Styled after 36Kr's blue-banner section dividers for content
 * structure, with a warm "kopi" (coffee) accent for brand elements —
 * "KopiRider" plays on the Singapore/Malaysia coffee-shop-chat vibe this
 * digest is meant to have. No JS/animation libraries by design (user
 * request 2026-08-01): CSS-only polish, kept dependency-free.
 *
 * The code repo is public (verified 2026-08-01: full commit history
 * checked for leaked secrets before making it public — see the Obsidian
 * knowledge base), so this doesn't need a separate private-source/
 * public-output split.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { marked } from "marked";

const DIGESTS_DIR = "digests";
const SITE_DIR = "site";
const BRAND_EN = "KopiRider";
const BRAND_CN = "两轮资讯";
const TAGLINE = "Riding is all you need.";
const SITE_TAB_TITLE = `${BRAND_EN} ${BRAND_CN}`;

interface DigestEntry {
  date: string;
  kind: "main" | "sub-push";
  filename: string;
  title: string;
  // Only populated for "main" entries — used on the homepage card to make
  // it visually obvious this is a roundup of several stories, not one
  // (found 2026-08-02: a single combined headline read as "just one piece
  // of news" to a first-time visitor).
  itemCount: number;
  highlights: string[];
}

interface WeeklyEntry {
  monday: string;
  filename: string;
  title: string;
  dateRange: string;
  briefing: string;
  itemCount: number;
}

const FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:-子推送-([a-f0-9]+))?\.md$/;
const WEEKLY_FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2})\.md$/;
const MAX_PREVIEW_HIGHLIGHTS = 3;

async function main() {
  const files = await readdir(DIGESTS_DIR);
  const entries: DigestEntry[] = [];

  for (const filename of files) {
    if (!filename.endsWith(".md")) continue;
    const match = filename.match(FILENAME_PATTERN);
    if (!match) continue;
    const [, date, hash] = match;
    const content = await readFile(`${DIGESTS_DIR}/${filename}`, "utf8");
    entries.push({
      date: date!,
      kind: hash ? "sub-push" : "main",
      filename,
      title: extractTitle(content),
      itemCount: hash ? 0 : countItems(content),
      highlights: hash ? [] : extractHighlights(content).slice(0, MAX_PREVIEW_HIGHLIGHTS),
    });
  }

  entries.sort((a, b) => (a.date === b.date ? (a.kind === "main" ? -1 : 1) : a.date < b.date ? 1 : -1));

  await mkdir(`${SITE_DIR}/digests`, { recursive: true });

  for (const entry of entries) {
    const content = await readFile(`${DIGESTS_DIR}/${entry.filename}`, "utf8");
    const bodyHtml = await marked.parse(content);
    const outName = entry.filename.replace(/\.md$/, ".html");
    await writeFile(`${SITE_DIR}/digests/${outName}`, renderPage(entry.title, bodyHtml, "../index.html"), "utf8");
  }

  const weeklyDir = `${DIGESTS_DIR}/weekly`;
  const weeklyEntries: WeeklyEntry[] = [];
  let weeklyFiles: string[] = [];
  try {
    weeklyFiles = await readdir(weeklyDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  for (const filename of weeklyFiles) {
    if (!filename.endsWith(".md")) continue;
    const match = filename.match(WEEKLY_FILENAME_PATTERN);
    if (!match) continue;
    const content = await readFile(`${weeklyDir}/${filename}`, "utf8");
    weeklyEntries.push({
      monday: match[1]!,
      filename,
      title: extractTitle(content),
      dateRange: extractWeeklyDateRange(content),
      briefing: extractWeeklyBriefing(content),
      itemCount: countItems(content),
    });
  }
  weeklyEntries.sort((a, b) => (a.monday < b.monday ? 1 : -1));

  await mkdir(`${SITE_DIR}/weekly`, { recursive: true });
  for (const entry of weeklyEntries) {
    const content = await readFile(`${weeklyDir}/${entry.filename}`, "utf8");
    const bodyHtml = await marked.parse(content);
    const outName = entry.filename.replace(/\.md$/, ".html");
    await writeFile(`${SITE_DIR}/weekly/${outName}`, renderPage(entry.title, bodyHtml, "index.html", " · 每周"), "utf8");
  }
  await writeFile(`${SITE_DIR}/weekly/index.html`, renderWeeklyIndex(weeklyEntries), "utf8");

  await writeFile(`${SITE_DIR}/index.html`, renderIndex(entries), "utf8");
  // GitHub Pages needs this to skip Jekyll processing, which would
  // otherwise mangle a directory named `digests`.
  await writeFile(`${SITE_DIR}/.nojekyll`, "", "utf8");

  console.log(`已生成 ${entries.length + weeklyEntries.length + 1} 个页面到 ${SITE_DIR}/`);
}

function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? "未命名";
}

// Each rendered story is a bold heading on its own line — see digest.ts's
// renderItem (`**${item.heading}**`) — so counting those lines gives the
// real number of stories in this digest, not just how many made the
// (deliberately short) 今日热点导览 preview list.
function countItems(markdown: string): number {
  return [...markdown.matchAll(/^\*\*(.+?)\*\*$/gm)].length;
}

function extractHighlights(markdown: string): string[] {
  const section = markdown.match(/##\s*今日热点导览\s*\n([\s\S]*?)(?=\n##|\n*$)/);
  if (!section?.[1]) return [];
  return [...section[1].matchAll(/^-\s+(.+)$/gm)].map((m) => m[1]!.trim());
}

// weekly-digest.ts renders `> {monday} – {last date}（本周）` as the second
// line — reuse it verbatim rather than reformatting, so the site always
// shows exactly the range the digest itself claims to cover.
function extractWeeklyDateRange(markdown: string): string {
  const match = markdown.match(/^>\s*(.+)$/m);
  return match?.[1]?.trim() ?? "";
}

// The briefing paragraph is the first non-blank, non-heading, non-blockquote
// line after the date range — see weekly-digest.ts's renderWeekly.
function extractWeeklyBriefing(markdown: string): string {
  const lines = markdown.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(">")) continue;
    return trimmed;
  }
  return "";
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function formatDateHeader(dateStr: string): string {
  const parts = dateStr.split("-").map(Number);
  const [year, month, day] = parts;
  if (!year || !month || !day) return dateStr;
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${month}月${day}日 · ${weekday}`;
}

function baseStyles(): string {
  return `
    :root {
      color-scheme: light;
      --ink: #2a2118;
      --ink-soft: #6b6155;
      --ink-faint: #9a9184;
      --paper: #faf6f0;
      --card: #ffffff;
      --line: #ece5db;
      --kopi: #a15c2e;
      --kopi-dark: #7c451f;
      --banner: #2255cc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 0 1.1rem 4rem;
      font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
      color: var(--ink); background: var(--paper); line-height: 1.75;
      -webkit-font-smoothing: antialiased;
    }
    main { max-width: 640px; margin: 0 auto; }
    a { color: var(--kopi); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Homepage brand header */
    .brand-header { max-width: 640px; margin: 0 auto; padding: 2.5rem 0 1.75rem; }
    .brand-link { display: inline-flex; align-items: baseline; gap: 0.55rem; }
    .brand-en {
      font-size: 1.9rem; font-weight: 700; letter-spacing: -0.01em;
      color: var(--kopi-dark);
    }
    .brand-cn { font-size: 1.1rem; font-weight: 500; color: var(--ink); }
    .brand-tagline { margin: 0.5rem 0 0; color: var(--ink-faint); font-size: 0.92rem; font-style: italic; }

    /* Daily / Weekly tab switcher */
    .tab-nav { display: flex; gap: 1.5rem; margin: 1.4rem 0 0; border-bottom: 1px solid var(--line); }
    .tab-nav a {
      color: var(--ink-soft); font-size: 0.95rem; font-weight: 600;
      padding: 0 0 0.7rem; border-bottom: 2px solid transparent;
    }
    .tab-nav a:hover { color: var(--kopi); text-decoration: none; }
    .tab-nav a.tab-active { color: var(--kopi-dark); border-bottom-color: var(--kopi); }
    .index-briefing { color: var(--ink-soft); font-size: 0.9rem; margin: 0.6rem 0 0; line-height: 1.6; }

    /* Back link on article pages */
    .back-nav { max-width: 640px; margin: 0 auto; padding: 1.5rem 0 0.5rem; }
    .back-nav a { color: var(--ink-soft); font-size: 0.88rem; }
    .back-nav .back-en { color: var(--kopi-dark); font-weight: 700; }

    h1 { font-size: 1.45rem; line-height: 1.5; margin: 1.4rem 0 0.6rem; letter-spacing: -0.01em; }
    h2 {
      display: inline-block; background: var(--banner); color: #fff;
      font-size: 0.92rem; font-weight: 700; padding: 0.42rem 1.15rem;
      border-radius: 5px; margin: 2.1rem 0 1rem; letter-spacing: 0.02em;
    }
    blockquote { color: var(--ink-faint); font-size: 0.88rem; margin: 0 0 1.2rem; padding: 0; border: none; }
    p { margin: 0.65rem 0; }
    strong { font-size: 1.03rem; }
    ul { padding-left: 1.25rem; }
    li { margin: 0.45rem 0; }
    hr { border: none; border-top: 1px solid var(--line); margin: 2.2rem 0; }

    /* Homepage list */
    .index-list { list-style: none; padding: 0; margin: 0; }
    .index-day { margin-bottom: 1.4rem; }
    .index-date {
      color: var(--kopi-dark); font-size: 1rem; font-weight: 700;
      letter-spacing: 0.01em; margin: 0 0 0.5rem 0.1rem;
    }
    .index-card {
      background: var(--card); border: 1px solid var(--line); border-radius: 10px;
      padding: 1.1rem 1.25rem;
      transition: border-color 0.15s ease, transform 0.15s ease;
    }
    .index-card:hover { border-color: var(--kopi); transform: translateY(-1px); }
    .index-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; }
    .index-title { font-weight: 700; font-size: 1.05rem; color: var(--ink); }
    .index-title:hover { color: var(--kopi); text-decoration: none; }
    .index-count {
      flex-shrink: 0; color: var(--kopi-dark); background: #f3e6d8;
      font-size: 0.76rem; font-weight: 700; padding: 0.15rem 0.55rem;
      border-radius: 999px; white-space: nowrap;
    }
    .index-preview { list-style: none; padding: 0; margin: 0.6rem 0 0; }
    .index-preview li {
      color: var(--ink-soft); font-size: 0.86rem; margin: 0.3rem 0;
      padding-left: 0.9rem; position: relative;
    }
    .index-preview li::before { content: "·"; position: absolute; left: 0; color: var(--kopi); }
    .index-subpush { display: block; font-size: 0.87rem; margin-top: 0.6rem; }
    .index-subpush .tag { color: var(--kopi-dark); font-weight: 700; }
  `;
}

function renderPage(title: string, bodyHtml: string, backHref: string, backSuffix = ""): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${SITE_TAB_TITLE}</title>
<style>${baseStyles()}</style>
</head>
<body>
<nav class="back-nav"><a href="${backHref}">← <span class="back-en">${BRAND_EN}</span> ${BRAND_CN}${backSuffix}</a></nav>
<main>${bodyHtml}</main>
</body>
</html>`;
}

function renderIndex(entries: DigestEntry[]): string {
  const dates = [...new Set(entries.map((e) => e.date))];
  const items = dates
    .map((date) => {
      const main = entries.find((e) => e.date === date && e.kind === "main");
      const subPushes = entries.filter((e) => e.date === date && e.kind === "sub-push");
      if (!main) return "";
      const subLinks = subPushes
        .map((sp) => {
          // Older sub-push files (pre-2026-08-01 redesign) baked a
          // "子推送：" prefix into their own title — strip it so it doesn't
          // clash with the "Deep Dive" tag used here for all of them.
          const cleanTitle = sp.title.replace(/^子推送[:：]\s*/, "");
          return `<a class="index-subpush" href="digests/${sp.filename.replace(/\.md$/, ".html")}">↳ <span class="tag">Deep Dive</span> · ${escapeHtml(cleanTitle)}</a>`;
        })
        .join("");
      const previewItems = main.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join("");

      return `<li class="index-day">
        <div class="index-date">${formatDateHeader(date)}</div>
        <div class="index-card">
          <div class="index-card-head">
            <a class="index-title" href="digests/${main.filename.replace(/\.md$/, ".html")}">${escapeHtml(main.title)}</a>
            <span class="index-count">共 ${main.itemCount} 条</span>
          </div>
          ${previewItems ? `<ul class="index-preview">${previewItems}</ul>` : ""}
          ${subLinks}
        </div>
      </li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SITE_TAB_TITLE}</title>
<style>${baseStyles()}</style>
</head>
<body>
<header class="brand-header">
  <a class="brand-link" href="index.html">
    <span class="brand-en">${BRAND_EN}</span><span class="brand-cn">${BRAND_CN}</span>
  </a>
  <p class="brand-tagline">${TAGLINE}</p>
  ${tabNav("daily")}
</header>
<main><ul class="index-list">${items}</ul></main>
</body>
</html>`;
}

function renderWeeklyIndex(entries: WeeklyEntry[]): string {
  const items = entries
    .map(
      (entry) => `<li class="index-day">
        <div class="index-date">${escapeHtml(entry.dateRange)}</div>
        <div class="index-card">
          <div class="index-card-head">
            <a class="index-title" href="${entry.filename.replace(/\.md$/, ".html")}">${escapeHtml(entry.title)}</a>
            <span class="index-count">十大热点</span>
          </div>
          ${entry.briefing ? `<p class="index-briefing">${escapeHtml(entry.briefing)}</p>` : ""}
        </div>
      </li>`,
    )
    .join("\n");

  const body =
    entries.length > 0
      ? `<ul class="index-list">${items}</ul>`
      : `<p class="index-briefing">还没有周报——每周五的定时任务会自动生成本周的十大热点回顾。</p>`;

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>每周热点 · ${SITE_TAB_TITLE}</title>
<style>${baseStyles()}</style>
</head>
<body>
<header class="brand-header">
  <a class="brand-link" href="../index.html">
    <span class="brand-en">${BRAND_EN}</span><span class="brand-cn">${BRAND_CN}</span>
  </a>
  <p class="brand-tagline">${TAGLINE}</p>
  ${tabNav("weekly")}
</header>
<main>${body}</main>
</body>
</html>`;
}

function tabNav(active: "daily" | "weekly"): string {
  return `<nav class="tab-nav">
    <a class="${active === "daily" ? "tab-active" : ""}" href="${active === "daily" ? "index.html" : "../index.html"}">每日</a>
    <a class="${active === "weekly" ? "tab-active" : ""}" href="${active === "weekly" ? "index.html" : "weekly/index.html"}">每周</a>
  </nav>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
