/**
 * Turns a digest (markdown) into something the WeChat Official Account editor
 * will accept when pasted, plus the pieces a person fills into the editor's other
 * fields (title ≤ 64 chars, summary ≤ 120 chars).
 *
 * Why it can't just reuse the site's HTML: the editor strips <style> blocks and
 * stylesheets, so every element needs its styling inline; it removes scripts;
 * and body text cannot carry external hyperlinks (only links to other WeChat
 * articles), so the site's clickable citations and reference links would
 * silently turn into dead text. This module makes that explicit instead:
 * citations become plain superscript numbers, references become plain text.
 *
 * Context (2026-10-16): the account is an unverified personal-subject
 * subscription account. WeChat's own docs say publish APIs (freepublish) were
 * withdrawn from personal-subject accounts in July 2025, so copy-and-paste is the
 * route that is guaranteed to work; see the Obsidian notes for the API question.
 */

import { marked } from "marked";

export const WECHAT_TITLE_MAX = 64;
export const WECHAT_SUMMARY_MAX = 120;

const INK = "#2a2118";
const TEXT = "#3f3a34";
const MUTED = "#8a8175";
const KOPI = "#a15c2e";
const KOPI_DARK = "#7c451f";
const BANNER = "#2255cc";
const LINE = "#ece5db";

export interface WechatArticle {
  /** Fits the editor's 64-character title limit. */
  title: string;
  /** True when the digest's own title had to be shortened. */
  titleTruncated: boolean;
  /** Fits the 120-character summary limit. */
  summary: string;
  /** Inline-styled HTML for the article body. */
  bodyHtml: string;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Strongest break first: end of a sentence, then a clause, then weaker separators.
const BREAK_TIERS = [["。", "；", ";", "."], ["，", ","], ["：", ":", "、", " "]];

/**
 * Cut `text` to at most `max` characters at a natural break: prefer a sentence or
 * clause boundary in the back half of the allowance, otherwise at least never inside
 * a Latin word or number ("Pikes Pea…"). Returns the text unchanged when it fits.
 */
function cutAtBreak(text: string, max: number): { text: string; truncated: boolean } {
  const chars = [...text];
  if (chars.length <= max) return { text, truncated: false };
  const room = chars.slice(0, max - 1); // leave a slot for the ellipsis
  const floor = Math.floor(max * 0.5);
  for (const tier of BREAK_TIERS) {
    for (let i = room.length - 1; i >= floor; i--) {
      if (tier.includes(room[i]!)) return { text: room.slice(0, i).join("").trimEnd(), truncated: true };
    }
  }
  let end = room.length;
  const isWordChar = (ch: string | undefined) => !!ch && /[A-Za-z0-9]/.test(ch);
  if (isWordChar(room[end - 1]) && isWordChar(chars[end])) {
    while (end > floor && isWordChar(room[end - 1])) end--;
  }
  return { text: `${room.slice(0, end).join("").trimEnd()}…`, truncated: true };
}

export function fitTitle(title: string, max = WECHAT_TITLE_MAX): { text: string; truncated: boolean } {
  return cutAtBreak(title.trim(), max);
}

export function fitSummary(text: string, max = WECHAT_SUMMARY_MAX): string {
  return cutAtBreak(text.replace(/\s+/g, " ").trim(), max).text;
}

function summaryFrom(markdown: string): string {
  const overview = markdown.match(/##\s*今日热点导览\s*\n([\s\S]*?)(?=\n##|$)/);
  if (overview?.[1]) {
    const bullets = [...overview[1].matchAll(/^-\s+(.+)$/gm)].map((m) => m[1]!.trim().replace(/[。；;]+$/, ""));
    if (bullets.length > 0) {
      // Add whole bullets while they fit, so the summary ends at a natural break instead
      // of mid-phrase; only a single over-long first bullet gets cut.
      let summary = "";
      for (const bullet of bullets.slice(0, 3)) {
        const next = summary ? `${summary}；${bullet}` : bullet;
        if ([...next].length > WECHAT_SUMMARY_MAX) break;
        summary = next;
      }
      return summary || fitSummary(bullets[0]!);
    }
  }
  // Weekly: the briefing paragraph, the first plain line after the title and date quote.
  for (const line of markdown.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && !t.startsWith(">") && !t.startsWith("-") && !t.startsWith("**")) return fitSummary(t);
  }
  return "";
}

function referencesToHtml(refMarkdown: string): string {
  const lines = refMarkdown.split("\n");
  const out: string[] = [
    `<p style="margin:30px 0 6px;font-size:14px;font-weight:bold;color:${KOPI};letter-spacing:1px;">参考来源</p>`,
  ];
  for (const line of lines) {
    const outlet = line.match(/^- \*\*(.+)\*\*\s*$/);
    if (outlet) {
      out.push(`<p style="margin:14px 0 4px;font-size:13px;font-weight:bold;color:${KOPI_DARK};">${escapeHtml(outlet[1]!)}</p>`);
      continue;
    }
    const entry = line.match(/^\s+- (?:<a id="ref-\d+"><\/a>)?\[(\d+)\] \[(.+?)\]\((\S+?)\)(?: · (\S+))?\s*$/);
    if (entry) {
      const [, n, title, , date] = entry;
      out.push(
        `<p style="margin:3px 0;padding-left:10px;border-left:2px solid ${LINE};font-size:12px;line-height:1.7;color:${MUTED};">[${n}] ${escapeHtml(title!)}${date ? ` · ${date}` : ""}</p>`,
      );
    }
  }
  return out.length > 1 ? out.join("\n") : "";
}

function styleBody(html: string): string {
  let h = html;
  h = h.replace(/<a id="ref-\d+"><\/a>/g, "");
  // Citations: keep the numbers, drop the in-page links (the editor would discard them anyway).
  h = h.replace(/<sup>([\s\S]*?)<\/sup>/g, (_m, inner: string) => {
    const nums = [...inner.matchAll(/\[(\d+)\]/g)].map((m) => `[${m[1]}]`).join("");
    return `<sup style="color:${KOPI};font-size:11px;font-weight:bold;line-height:0;margin-left:1px;">${nums}</sup>`;
  });
  // Any remaining link is external, which the editor does not allow in body text: keep the text only.
  h = h.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/g, "$1");
  // An item heading is a paragraph holding nothing but bold text.
  h = h.replace(
    /<p><strong>([\s\S]*?)<\/strong><\/p>/g,
    `<p style="margin:24px 0 6px;font-size:16px;line-height:1.6;font-weight:bold;color:${INK};">$1</p>`,
  );
  h = h.replace(
    /<h2[^>]*>([\s\S]*?)<\/h2>/g,
    `<p style="margin:34px 0 14px;"><span style="display:inline-block;background:${BANNER};color:#ffffff;font-size:14px;font-weight:bold;padding:6px 16px;border-radius:4px;letter-spacing:1px;">$1</span></p>`,
  );
  h = h.replace(
    /<h3[^>]*>([\s\S]*?)<\/h3>/g,
    `<p style="margin:22px 0 4px;font-size:13px;font-weight:bold;color:${KOPI_DARK};letter-spacing:1px;">$1</p>`,
  );
  // Lists become paragraphs with a bullet — pasted <ul> gets re-styled unpredictably by the editor.
  h = h.replace(/<\/?ul>\s*/g, "");
  h = h.replace(
    /<li>([\s\S]*?)<\/li>\s*/g,
    `<p style="margin:9px 0;padding-left:1em;text-indent:-1em;font-size:15px;line-height:1.85;color:${TEXT};letter-spacing:0.5px;">· $1</p>`,
  );
  h = h.replace(
    /<blockquote>\s*<p>([\s\S]*?)<\/p>\s*<\/blockquote>/g,
    `<p style="margin:4px 0 18px;font-size:13px;color:${MUTED};">$1</p>`,
  );
  h = h.replace(
    /<p>([\s\S]*?)<\/p>/g,
    `<p style="margin:12px 0;font-size:15px;line-height:1.85;color:${TEXT};letter-spacing:0.5px;">$1</p>`,
  );
  h = h.replace(/<strong>([\s\S]*?)<\/strong>/g, `<strong style="color:${INK};">$1</strong>`);
  return h;
}

export function digestToWechat(markdown: string, footerSite = "jw-90124.github.io/Motorcycle-News"): WechatArticle {
  const md = markdown.replace(/\r\n/g, "\n");
  const rawTitle = md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "两轮资讯";
  const { text: title, truncated } = fitTitle(rawTitle);

  const withoutTitle = md.replace(/^#\s+.+\n?/m, "");
  const refIndex = withoutTitle.search(/^## 参考来源\s*$/m);
  const bodyMd = refIndex >= 0 ? withoutTitle.slice(0, refIndex) : withoutTitle;
  const refMd = refIndex >= 0 ? withoutTitle.slice(refIndex) : "";

  const rendered = marked.parse(bodyMd, { async: false }) as string;
  const parts = [styleBody(rendered), referencesToHtml(refMd)];
  parts.push(
    `<p style="margin:34px 0 4px;padding-top:14px;border-top:1px solid ${LINE};font-size:13px;color:${MUTED};text-align:center;">KopiRider 两轮资讯 · Riding is all you need.</p>`,
    `<p style="margin:2px 0;font-size:12px;color:${MUTED};text-align:center;">完整原文链接见网站：${footerSite}</p>`,
  );

  return { title, titleTruncated: truncated, summary: summaryFrom(withoutTitle), bodyHtml: parts.filter(Boolean).join("\n") };
}

export interface WechatPageMeta {
  label: string;
  /** Relative URL back to the wechat index. */
  backHref: string;
}

/** A private working page: the three things to paste, with copy buttons, and a live preview. */
export function renderWechatPage(article: WechatArticle, meta: WechatPageMeta): string {
  const bodyChars = [...article.bodyHtml.replace(/<[^>]+>/g, "")].length;
  const titleNote = article.titleTruncated ? "（原标题超过 64 字，已在标点处截短，可自行改）" : "";
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>公众号版 · ${escapeHtml(meta.label)}</title>
<style>
  body { margin: 0; padding: 0 1rem 4rem; background: #faf6f0; color: #2a2118; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.6; }
  .wrap { max-width: 680px; margin: 0 auto; }
  .back { display: block; padding: 1.2rem 0 0.4rem; color: #6b6155; font-size: 0.9rem; text-decoration: none; }
  h1 { font-size: 1.15rem; margin: 0.6rem 0 1rem; }
  .panel { background: #fff; border: 1px solid #ece5db; border-radius: 10px; padding: 1rem 1.1rem; margin-bottom: 1rem; }
  .panel h2 { font-size: 0.82rem; letter-spacing: 0.06em; color: #7c451f; margin: 0 0 0.5rem; }
  .field { font-size: 0.95rem; background: #faf6f0; border-radius: 6px; padding: 0.55rem 0.7rem; word-break: break-all; }
  .meta { font-size: 0.78rem; color: #9a9184; margin-top: 0.35rem; }
  button { appearance: none; border: 0; background: #a15c2e; color: #fff; font-size: 0.9rem; padding: 0.55rem 1.1rem; border-radius: 6px; cursor: pointer; margin-top: 0.6rem; }
  button.done { background: #3c8a4f; }
  ol { margin: 0.4rem 0 0; padding-left: 1.2rem; font-size: 0.88rem; color: #3f3a34; }
  .preview-box { background: #fff; border: 1px solid #ece5db; border-radius: 10px; padding: 1.2rem 1.1rem; }
</style>
</head>
<body>
<div class="wrap">
  <a class="back" href="${meta.backHref}">← 公众号版列表</a>
  <h1>${escapeHtml(meta.label)}</h1>

  <div class="panel">
    <h2>① 标题</h2>
    <div class="field" id="title">${escapeHtml(article.title)}</div>
    <div class="meta"><span id="titleCount"></span> / ${WECHAT_TITLE_MAX} 字${titleNote}</div>
    <button data-copy-text="title">复制标题</button>
  </div>

  <div class="panel">
    <h2>② 摘要</h2>
    <div class="field" id="summary">${escapeHtml(article.summary)}</div>
    <div class="meta"><span id="summaryCount"></span> / ${WECHAT_SUMMARY_MAX} 字</div>
    <button data-copy-text="summary">复制摘要</button>
  </div>

  <div class="panel">
    <h2>③ 正文（约 ${bodyChars} 字）</h2>
    <button id="copyBody">复制正文（带格式）</button>
    <div class="meta" id="copyStatus">下面的预览就是会粘贴进去的内容。</div>
  </div>

  <div class="panel">
    <h2>粘贴前后要做的事</h2>
    <ol>
      <li>公众号后台 → 新建图文 → 把标题、摘要、正文分别粘贴进去（正文请直接 Ctrl+V，不要用"粘贴为纯文本"）</li>
      <li><b>封面图必须自己传</b>（正文里没有图片，编辑器不会自动生成封面）</li>
      <li>不要勾"原创声明"——这是整理转述的资讯；参考来源已在文末</li>
      <li>先点"预览"发到自己微信看一遍再群发</li>
    </ol>
  </div>

  <div class="preview-box"><div id="article">
${article.bodyHtml}
  </div></div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  $("titleCount").textContent = [...$("title").textContent].length;
  $("summaryCount").textContent = [...$("summary").textContent].length;
  function flash(btn, text) { const old = btn.textContent; btn.textContent = text; btn.classList.add("done"); setTimeout(() => { btn.textContent = old; btn.classList.remove("done"); }, 1800); }
  document.querySelectorAll("[data-copy-text]").forEach((btn) => btn.addEventListener("click", async () => {
    const text = $(btn.dataset.copyText).textContent.trim();
    try { await navigator.clipboard.writeText(text); } catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
    flash(btn, "已复制 ✓");
  }));
  $("copyBody").addEventListener("click", async () => {
    const el = $("article");
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([el.innerHTML], { type: "text/html" }),
        "text/plain": new Blob([el.innerText], { type: "text/plain" }),
      })]);
    } catch {
      const range = document.createRange(); range.selectNodeContents(el);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); document.execCommand("copy"); sel.removeAllRanges();
    }
    flash($("copyBody"), "已复制 ✓");
    $("copyStatus").textContent = "已复制。到公众号编辑器正文区直接 Ctrl+V。";
  });
</script>
</body>
</html>`;
}
