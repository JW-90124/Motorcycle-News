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
    slug: "lta-coe-motorcycle",
    name: "新加坡 LTA COE 摩托车类别（Category D）投标结果",
    homepageUrl: "https://onemotoring.lta.gov.sg/content/onemotoring/home/buying/coe-open-bidding.html",
    adapter: "web-scraper",
    language: "en",
    config: {
      url: "https://onemotoring.lta.gov.sg/content/onemotoring/home/buying/coe-open-bidding.html",
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
  {
    slug: "cfmoto-media",
    name: "CFMoto（春风动力）全球媒体中心",
    homepageUrl: "https://www.cfmoto.com/global/media-center/news.html",
    adapter: "web-scraper",
    language: "en",
    config: { url: "https://www.cfmoto.com/global/media-center/news.html", category: "industry" },
  },
  {
    slug: "qjmotor",
    name: "QJMOTOR（钱江摩托）官网",
    homepageUrl: "https://www.qjmotor.com/",
    adapter: "web-scraper",
    language: "zh",
    config: { url: "https://www.qjmotor.com/", category: "industry" },
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
