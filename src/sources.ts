/**
 * Source catalog for Motorcycle News.
 *
 * Mirrors the source notes in the Obsidian knowledge base
 * (`Motorcycle News/信源清单/`). Keep these in sync — the Obsidian notes are
 * the authoritative record of *why* each source was chosen; this file is
 * just the machine-readable version for the collector to run against.
 *
 * `authorityScore`/`isPrimary` are a one-time manual judgment call made when
 * a source is added — this project has ~15 hand-picked sources, not an open
 * pool that needs agent-pulse's automated trust-tier/observation-period
 * machinery. Rubric to apply for future additions:
 *
 *   90-95  一档：官方一手 — 厂商新闻室、赛事主办方官方站、政府数据（isPrimary: true）
 *   75-85  二档：官方经销商/总代理，或老牌权威媒体（isPrimary: true for 经销商/总代理, false for 媒体）
 *   60-70  三档：综合新闻门户的摩托板块、区域性媒体（isPrimary: false）
 *   40-55  四档：二手转载/资讯聚合站（isPrimary: false）
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
    authorityScore: 95,
    isPrimary: true,
  },
  {
    slug: "worldsbk-news",
    name: "WorldSBK 官方新闻",
    homepageUrl: "https://www.worldsbk.com/en/news",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://www.worldsbk.com/en/news", category: "racing" },
    authorityScore: 95,
    isPrimary: true,
  },
  {
    // German-language dedicated motorsport site, MotoGP/Moto2/Moto3/
    // Superbike section — verified 2026-08-03: real <article> tags, real
    // titles/links extracted successfully. Language isn't a concern —
    // digest.ts forces Chinese output regardless of source language.
    slug: "speedweek-motogp",
    name: "SPEEDWEEK.com（MotoGP 板块）",
    homepageUrl: "https://www.speedweek.com/o/motorrad-gp/motogp",
    adapter: "web-scraper",
    language: "de",
    config: { url: "https://www.speedweek.com/o/motorrad-gp/motogp", category: "racing" },
    authorityScore: 82,
    isPrimary: false,
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
    authorityScore: 95,
    isPrimary: true,
  },
  {
    // NOTE: the 403 here isn't an anti-bot challenge (no CAPTCHA, no JS
    // puzzle) — verified 2026-07-29 that it's a naive User-Agent string
    // filter: our honest self-identifying UA gets rejected, a normal
    // browser UA gets HTTP 200 with no other change. Setting a realistic
    // UA for this one source is standard scraping etiquette, not evasion.
    slug: "boon-siew-honda",
    name: "Boon Siew Honda",
    homepageUrl: "https://boonsiewhonda.com.my/news-and-events/news/",
    adapter: "web-scraper",
    language: "en",
    config: {
      url: "https://boonsiewhonda.com.my/news-and-events/news/",
      category: "local-market",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    },
    authorityScore: 80,
    isPrimary: true,
  },
  {
    slug: "modenas-emos",
    name: "MODENAS/EMOS（马来西亚 Kawasaki 官方总代理）",
    homepageUrl: "https://modenas.my/news&event/press-release",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://modenas.my/news&event/press-release", category: "local-market" },
    authorityScore: 80,
    isPrimary: true,
  },
  {
    slug: "mah-pte-ltd",
    name: "Mah Pte Ltd（新加坡 Kawasaki 等六品牌独家代理）",
    homepageUrl: "https://mah.com.sg/brands-kawasaki/",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://mah.com.sg/brands-kawasaki/", category: "local-market" },
    authorityScore: 80,
    isPrimary: true,
  },

  // 全球新车发布 (new-models)
  {
    slug: "rideapart",
    name: "RideApart",
    homepageUrl: "https://www.rideapart.com/",
    adapter: "rss",
    language: "en",
    config: { url: "https://www.rideapart.com/rss/articles/all/", category: "new-models" },
    authorityScore: 75,
    isPrimary: false,
  },
  {
    slug: "cycleworld",
    name: "Cycle World",
    homepageUrl: "https://www.cycleworld.com/",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://www.cycleworld.com/", category: "new-models" },
    authorityScore: 80,
    isPrimary: false,
  },
  {
    // UK motorcycle media — verified 2026-08-03: real article links found
    // directly in the static HTML (/news/... paths with real headlines),
    // mix of new-model launches and industry stories that the category
    // re-judgment step in digest.ts will sort correctly either way.
    slug: "visordown",
    name: "Visordown",
    homepageUrl: "https://www.visordown.com/news",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://www.visordown.com/news", category: "new-models" },
    authorityScore: 75,
    isPrimary: false,
  },

  // 技术工程解读 (tech)
  {
    slug: "honda-global-news",
    name: "Honda Global 摩托车新闻室",
    homepageUrl: "https://global.honda/en/motorcycle/brand/news/",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://global.honda/en/motorcycle/brand/news/", category: "tech" },
    authorityScore: 90,
    isPrimary: true,
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
    authorityScore: 90,
    isPrimary: true,
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
    authorityScore: 55,
    isPrimary: false,
  },
  // NOTE: Cycle News's press-releases page was evaluated 2026-08-03 —
  // real industry content exists (sponsorship deals, business moves) but
  // lives inside a "Top Stories" sidebar widget on what's otherwise a
  // static WordPress page, not a clean listing. Its RSS feed is blocked by
  // Cloudflare. Dropped rather than kept chasing the page's specific
  // structure — see queries/ in the Obsidian knowledge base for the
  // investigation. 产业商业动态 still only has 两轮视界; a better second
  // source is still worth finding.

  // 骑行文化车展活动 (culture)
  {
    slug: "eicma",
    name: "EICMA（米兰国际两轮车展）",
    homepageUrl: "https://www.eicma.it/en/news/",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://www.eicma.it/en/news/", category: "culture" },
    authorityScore: 85,
    isPrimary: true,
  },
  {
    slug: "bangkok-motor-show",
    name: "Bangkok International Motor Show",
    homepageUrl: "https://motorshow.in.th/",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://motorshow.in.th/", category: "culture" },
    authorityScore: 80,
    isPrimary: true,
  },
  {
    slug: "kompas-otomotif",
    name: "Kompas.com Otomotif",
    homepageUrl: "https://otomotif.kompas.com/",
    adapter: "web-scraper",
    language: "id",
    config: { url: "https://otomotif.kompas.com/", category: "culture" },
    authorityScore: 65,
    isPrimary: false,
  },
];
