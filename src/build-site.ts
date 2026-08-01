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
  // GitHub Pages needs this to skip Jekyll processing, which would
  // otherwise mangle a directory named `digests`.
  await writeFile(`${SITE_DIR}/.nojekyll`, "", "utf8");

  console.log(`已生成 ${entries.length} 个页面到 ${SITE_DIR}/`);
}

function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? "未命名";
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
    .index-item {
      background: var(--card); border: 1px solid var(--line); border-radius: 10px;
      padding: 1.1rem 1.25rem; margin-bottom: 0.9rem;
      transition: border-color 0.15s ease, transform 0.15s ease;
    }
    .index-item:hover { border-color: var(--kopi); transform: translateY(-1px); }
    .index-date { color: var(--ink-faint); font-size: 0.82rem; letter-spacing: 0.02em; }
    .index-title { display: block; font-weight: 700; font-size: 1.05rem; margin-top: 0.3rem; color: var(--ink); }
    .index-title:hover { color: var(--kopi); text-decoration: none; }
    .index-subpush { display: block; font-size: 0.87rem; margin-top: 0.5rem; }
    .index-subpush .tag { color: var(--kopi-dark); font-weight: 700; }
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
<nav class="back-nav"><a href="../index.html">← <span class="back-en">${BRAND_EN}</span> ${BRAND_CN}</a></nav>
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
<header class="brand-header">
  <a class="brand-link" href="index.html">
    <span class="brand-en">${BRAND_EN}</span><span class="brand-cn">${BRAND_CN}</span>
  </a>
  <p class="brand-tagline">${TAGLINE}</p>
</header>
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
