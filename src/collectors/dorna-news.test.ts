import assert from "node:assert/strict";
import { test } from "node:test";
import { dornaNewsAdapter } from "./dorna-news.js";
import type { FetchResult } from "../fetcher.js";

const source = {
  slug: "motogp-news", name: "MotoGP", homepageUrl: "https://www.motogp.com/en/news",
  adapter: "dorna-news", language: "en", config: { url: "https://www.motogp.com/en/news", category: "racing" },
  authorityScore: 95, isPrimary: true,
};

function page(inner: string): FetchResult {
  const filler = "<!-- filler -->".repeat(500);
  return { body: `<html><body>${inner}${filler}</body></html>`, status: 200, headers: new Headers(), attemptCount: 1, responseBytes: 0, finalUrl: "" };
}

test("extracts dated article links with their headline and ignores nav, sponsors and socials", async () => {
  const html = page(`
    <a href="/en/news/motogp"><span class="x">View MotoGP</span></a>
    <a href="https://www.tissotwatches.com/"><img alt="TISSOT"></a>
    <a href="https://facebook.com/MotoGP">Facebook</a>
    <a class="hero" href="/en/news/2026/10/09/bezzecchi-leads-in-indonesia-fp1/1174846"><img src="a.jpg"></a>
    <a class="card" href="/en/news/2026/10/09/bezzecchi-leads-in-indonesia-fp1/1174846"><div class="content-item__title">Bezzecchi leads Marquez and Martin in Indonesia FP1</div></a>
    <a class="card" href="/en/news/2026/10/07/new-weekend-format-from-2027/1174695"><h3 class="content-item__title">MotoGP introduces new weekend format from 2027</h3></a>
  `);
  const signals = await dornaNewsAdapter.collect(source, { fetchText: async () => html });
  assert.equal(signals.length, 2);
  assert.equal(signals[0]!.title, "Bezzecchi leads Marquez and Martin in Indonesia FP1");
  assert.equal(signals[0]!.publishedAt.slice(0, 10), "2026-10-09");
  assert.equal(signals[0]!.rawMeta.dateInferred, false);
  assert.equal(signals[1]!.publishedAt.slice(0, 10), "2026-10-07");
});

test("a page with no article links fails loudly instead of returning an empty list", async () => {
  const html = page(`<a href="/en/news/motogp">View MotoGP</a>`);
  await assert.rejects(() => dornaNewsAdapter.collect(source, { fetchText: async () => html }), /no article links/);
});
