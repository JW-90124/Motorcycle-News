#!/usr/bin/env node
/**
 * Static site generator — stage 3 of the pipeline. Reads every
 * `digests/*.md` file and renders a simple public site (`site/`) for
 * GitHub Pages. Styled after 36Kr's blue-banner section dividers, kept
 * intentionally plain per the user's brief: "先做一个干净简单版本，不追求
 * 一步到位的精美设计" (a clean simple version first, not a polished design).
 *
 * The code repo is public (verified 2026-08-01: full commit history
 * checked for leaked secrets before making it public — see
 * queries/ in the Obsidian knowledge base), so this doesn't need a
 * separate private-source/public-output split.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { marked } from "marked";

const DIGESTS_DIR = "digests";
const SITE_DIR = "site";
// Used only for the browser tab <title> (SEO/history) — not shown as a
// visible on-page heading anywhere, per user request 2026-08-01.
const SITE_TAB_TITLE = "摩托车新闻";

interface DigestEntry {
  date: string;
  kind: "main" | "sub-push";
  filename: string;
  title: string;
}

const FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:-子推送-([a-f0-9]+))?\.md$/;

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
    });
  }

  entries.sort((a, b) => (a.date === b.date ? (a.kind === "main" ? -1 : 1) : a.date < b.date ? 1 : -1));

  await mkdir(`${SITE_DIR}/digests`, { recursive: true });

  for (const entry of entries) {
    const content = await readFile(`${DIGESTS_DIR}/${entry.filename}`, "utf8");
    const bodyHtml = await marked.parse(content);
    const outName = entry.filename.replace(/\.md$/, ".html");
    await writeFile(`${SITE_DIR}/digests/${outName}`, renderPage(entry.title, bodyHtml), "utf8");
  }

  await writeFile(`${SITE_DIR}/index.html`, renderIndex(entries), "utf8");
  // GitHub Pages needs this to serve files/paths starting with an
  // underscore (none currently, but harmless) and to skip Jekyll
  // processing, which would otherwise mangle a directory named `digests`.
  await writeFile(`${SITE_DIR}/.nojekyll`, "", "utf8");

  console.log(`已生成 ${entries.length} 个页面到 ${SITE_DIR}/`);
}

function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? "未命名";
}

function baseStyles(): string {
  return `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 0 1rem 3rem;
      font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
      color: #1a1a1a; background: #fafafa; line-height: 1.75;
    }
    main { max-width: 640px; margin: 0 auto; padding-top: 1.5rem; }
    header.site-header {
      max-width: 640px; margin: 0 auto; padding: 1.5rem 0 1rem;
      border-bottom: 1px solid #e5e5e5;
    }
    header.site-header a { color: #666; text-decoration: none; font-size: 0.9rem; }
    h1 { font-size: 1.4rem; line-height: 1.5; margin: 1.5rem 0 0.5rem; }
    h2 {
      display: inline-block; background: #2255cc; color: #fff;
      font-size: 0.95rem; font-weight: 700; padding: 0.4rem 1.2rem;
      border-radius: 4px; margin: 2rem 0 1rem;
    }
    blockquote { color: #888; font-size: 0.9rem; margin: 0 0 1rem; padding: 0; border: none; }
    p { margin: 0.6rem 0; }
    strong { font-size: 1.02rem; }
    ul { padding-left: 1.2rem; }
    li { margin: 0.4rem 0; }
    a { color: #2255cc; }
    hr { border: none; border-top: 1px solid #e5e5e5; margin: 2rem 0; }
    .index-list { list-style: none; padding: 0; }
    .index-item { padding: 1rem 0; border-bottom: 1px solid #e5e5e5; }
    .index-date { color: #888; font-size: 0.85rem; }
    .index-title { display: block; font-weight: 700; margin-top: 0.2rem; }
    .index-subpush { display: block; font-size: 0.9rem; margin-top: 0.4rem; color: #2255cc; }
  `;
}

function renderPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${SITE_TAB_TITLE}</title>
<style>${baseStyles()}</style>
</head>
<body>
<header class="site-header"><a href="../index.html">← 返回</a></header>
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
          // clash with the "Deep Dive" label used here for all of them.
          const cleanTitle = sp.title.replace(/^子推送[:：]\s*/, "");
          return `<a class="index-subpush" href="digests/${sp.filename.replace(/\.md$/, ".html")}">↳ Deep Dive · ${escapeHtml(cleanTitle)}</a>`;
        })
        .join("");
      return `<li class="index-item">
        <span class="index-date">${date}</span>
        <a class="index-title" href="digests/${main.filename.replace(/\.md$/, ".html")}">${escapeHtml(main.title)}</a>
        ${subLinks}
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
<main><ul class="index-list">${items}</ul></main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
