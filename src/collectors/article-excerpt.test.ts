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
