/**
 * Source catalog for Motorcycle News.
 *
 * Mirrors the 15 verified source notes in the Obsidian knowledge base
 * (`Motorcycle News/信源清单/`). Keep these in sync — the Obsidian notes are
 * the authoritative record of *why* each source was chosen; this file is
 * just the machine-readable version for the collector to run against.
 */

import type { SourceDescriptor } from "./types.js";

export const sources: SourceDescriptor[] = [
  // 赛事赛果 (racing)
  {
    slug: "motogp-news",
    name: "MotoGP 官方新闻",
    homepageUrl: "https://www.motogp.com/en/news",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://www.motogp.com/en/news", category: "racing" },
  },
  {
    slug: "worldsbk-news",
    name: "WorldSBK 官方新闻",
    homepageUrl: "https://www.worldsbk.com/en/news",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://www.worldsbk.com/en/news", category: "racing" },
  },

  // 本地车市 (local-market)
  {
    // NOTE: OneMotoring's COE bidding page (the URL originally requested)
    // does render this data, but as an HTML <table> our generic web-scraper
    // adapter can't parse. Switched 2026-07-29 to a dedicated adapter that
    // pulls the same data from data.gov.sg's structured dataset API instead
    // — see src/collectors/lta-coe.ts for why (also covers a presigned-URL
    // handling caveat).
    slug: "lta-coe-motorcycle",
    name: "新加坡 LTA COE 摩托车类别（Category D）投标结果",
    homepageUrl: "https://data.gov.sg/datasets/d_69b3380ad7e51aff3a7dcc84eba52b8a/view",
    adapter: "lta-coe",
    language: "en",
    config: {
      url: "https://data.gov.sg/datasets/d_69b3380ad7e51aff3a7dcc84eba52b8a/view",
      category: "local-market",
    },
  },
  {
    slug: "boon-siew-honda",
    name: "Boon Siew Honda",
    homepageUrl: "https://boonsiewhonda.com.my/news-and-events/news/",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://boonsiewhonda.com.my/news-and-events/news/", category: "local-market" },
  },
  {
    slug: "modenas-emos",
    name: "MODENAS/EMOS（马来西亚 Kawasaki 官方总代理）",
    homepageUrl: "https://modenas.my/news&event/press-release",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://modenas.my/news&event/press-release", category: "local-market" },
  },
  {
    slug: "mah-pte-ltd",
    name: "Mah Pte Ltd（新加坡 Kawasaki 等六品牌独家代理）",
    homepageUrl: "https://mah.com.sg/brands-kawasaki/",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://mah.com.sg/brands-kawasaki/", category: "local-market" },
  },

  // 全球新车发布 (new-models)
  {
    slug: "rideapart",
    name: "RideApart",
    homepageUrl: "https://www.rideapart.com/",
    adapter: "rss",
    language: "en",
    config: { url: "https://www.rideapart.com/rss/articles/all/", category: "new-models" },
  },
  {
    slug: "cycleworld",
    name: "Cycle World",
    homepageUrl: "https://www.cycleworld.com/",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://www.cycleworld.com/", category: "new-models" },
  },

  // 技术工程解读 (tech)
  {
    slug: "honda-global-news",
    name: "Honda Global 摩托车新闻室",
    homepageUrl: "https://global.honda/en/motorcycle/brand/news/",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://global.honda/en/motorcycle/brand/news/", category: "tech" },
  },
  {
    // NOTE: the "RSS" URL found during source research (global.yamaha-motor.com/rss/)
    // turned out to be an HTML index page describing their feeds, not an actual
    // feed — verified 2026-07-29 by fetching it and finding no valid RSS/Atom XML.
    // Falls back to web-scraper against the news listing page instead.
    slug: "yamaha-global-news",
    name: "Yamaha Motor Global News Center",
    homepageUrl: "https://global.yamaha-motor.com/news/",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://global.yamaha-motor.com/news/", category: "tech" },
  },

  // 产业商业动态 (industry)
  //
  // NOTE: CFMoto/QJMOTOR were dropped 2026-07-29 — both are JS-rendered SPAs
  // that return no usable content to a plain HTTP scraper. 摩托范/58moto.com
  // was also evaluated but sits behind an Aliyun WAF anti-bot challenge —
  // deliberately not worked around (see 信源清单/摩托范.md for why). Replaced
  // both with 两轮视界's 行业数据 (industry data) section instead: plain
  // static HTML, no anti-bot layer, real article links (verified via curl).
  {
    slug: "lianglunshijie-industry",
    name: "两轮视界·行业数据",
    homepageUrl: "https://www.lianglunshijie.com/htmlry/hysj_1201.html",
    adapter: "web-scraper",
    language: "zh",
    config: { url: "https://www.lianglunshijie.com/htmlry/hysj_1201.html", category: "industry" },
  },

  // 骑行文化车展活动 (culture)
  {
    slug: "eicma",
    name: "EICMA（米兰国际两轮车展）",
    homepageUrl: "https://www.eicma.it/en/news/",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://www.eicma.it/en/news/", category: "culture" },
  },
  {
    slug: "bangkok-motor-show",
    name: "Bangkok International Motor Show",
    homepageUrl: "https://motorshow.in.th/",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://motorshow.in.th/", category: "culture" },
  },
  {
    slug: "kompas-otomotif",
    name: "Kompas.com Otomotif",
    homepageUrl: "https://otomotif.kompas.com/",
    adapter: "web-scraper",
    language: "id",
    config: { url: "https://otomotif.kompas.com/", category: "culture" },
  },
];
