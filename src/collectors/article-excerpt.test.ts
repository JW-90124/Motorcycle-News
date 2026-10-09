import assert from "node:assert/strict";
import { test } from "node:test";
import { extractArticleBody } from "./article-excerpt.js";

const LEAD = "The first paragraph of the real story is comfortably longer than the minimum.";
const SECOND = "A second paragraph carrying the rider's own assessment of what happened on track.";
const TEASER = "A related-story teaser sentence that is also long enough to look like body copy.";

test("body inside one <article>: that block wins over page chrome", () => {
  const html = `<nav><p>${"Navigation blurb that happens to be long enough to pass the filter."}</p></nav>
    <article><p>${LEAD}</p><p>${SECOND}</p></article>`;
  const body = extractArticleBody(html)!;
  assert.ok(body.includes(LEAD) && body.includes(SECOND));
});

test("SPEEDWEEK-style page: body is outside <article>, which only wraps teaser cards", () => {
  const html = `<main><p>${LEAD}</p><p>${SECOND}</p></main>
    <article><p>${TEASER}</p></article><article><p>${TEASER} Another.</p></article>`;
  const body = extractArticleBody(html)!;
  assert.ok(body.includes(LEAD) && body.includes(SECOND));
  assert.ok(!body.includes("related-story teaser"), "teaser cards must not leak into the body");
});

test("short fragments and repeated paragraphs are dropped", () => {
  const html = `<p>Share</p><p>${LEAD}</p><p>${LEAD}</p>`;
  assert.equal(extractArticleBody(html), LEAD);
});

test("no usable paragraphs gives null, not an empty string", () => {
  assert.equal(extractArticleBody("<div>nothing here</div>"), null);
});

import { extractPublishDate } from "./article-excerpt.js";

const NOW = Date.parse("2026-10-09T08:00:00Z");

test("publish date: meta tag wins over a later body timestamp", () => {
  const html = `<meta property="article:published_time" content="2026-10-08T03:00:00Z"><p>posted 2026/10/01 10:00</p>`;
  assert.equal(extractPublishDate(html, NOW), "2026-10-08T03:00:00.000Z");
});

test("publish date: falls back to a Chinese CMS body timestamp, read as UTC+8", () => {
  assert.equal(extractPublishDate("<div>发布时间 2026/3/26 14:56:38</div>", NOW), "2026-03-26T06:56:00.000Z");
});

test("publish date: ignores implausible values (future or ancient) and returns null when nothing is found", () => {
  assert.equal(extractPublishDate(`<meta name="date" content="2031-01-01">`, NOW), null);
  assert.equal(extractPublishDate(`<time datetime="1999-05-05">x</time>`, NOW), null);
  assert.equal(extractPublishDate("<p>no dates here</p>", NOW), null);
});
