import assert from "node:assert/strict";
import { test } from "node:test";
import { digestToWechat, fitSummary, fitTitle, WECHAT_SUMMARY_MAX, WECHAT_TITLE_MAX } from "./wechat-html.js";

const DIGEST = `# 红牛冠名澳洲站，杜卡迪更新 Desmo450

> 2026-10-16

## 今日热点导览

- 红牛成为澳大利亚大奖赛冠名赞助商。
- 雅马哈承包商服务器遭攻击。
- 本田提供免费 3D 模型。
- 第四条不应出现在摘要里。

## 今日头条

**红牛冠名澳洲站**

MotoGP 官方确认红牛冠名。<sup><a href="#ref-1">[1]</a></sup>

### 其他动态

- **雅马哈数据泄露**：约 1600 名会员数据可能泄露。<sup><a href="#ref-2">[2]</a><a href="#ref-3">[3]</a></sup>

## 参考来源

- **MotoGP 官方新闻**
  - <a id="ref-1"></a>[1] [Red Bull to title sponsor](https://www.motogp.com/en/news/x) · 2026-10-15
- **RideApart**
  - <a id="ref-2"></a>[2] [Yamaha Saw a Hack](https://www.rideapart.com/y) · 2026-10-15
  - <a id="ref-3"></a>[3] [Another](https://www.rideapart.com/z)
`;

test("nothing the editor would strip or break survives: no links, anchors, style blocks or scripts", () => {
  const { bodyHtml } = digestToWechat(DIGEST);
  assert.ok(!/<a\b/i.test(bodyHtml), "no <a> elements at all");
  assert.ok(!/href=/i.test(bodyHtml));
  assert.ok(!/<style|<script|<ul|<li|<h[1-6]/i.test(bodyHtml));
  assert.ok(!bodyHtml.includes("https://www.motogp.com"), "reference URLs are not carried into the body");
});

test("every element is styled inline", () => {
  const { bodyHtml } = digestToWechat(DIGEST);
  const bare = bodyHtml.match(/<(p|span|sup|strong)>/g);
  assert.equal(bare, null, `unstyled tags found: ${bare}`);
});

test("citations stay as plain superscript numbers, in order", () => {
  const { bodyHtml } = digestToWechat(DIGEST);
  assert.ok(/<sup[^>]*>\[1\]<\/sup>/.test(bodyHtml));
  assert.ok(/<sup[^>]*>\[2\]\[3\]<\/sup>/.test(bodyHtml));
});

test("references become plain text grouped by outlet, with the date when known", () => {
  const { bodyHtml } = digestToWechat(DIGEST);
  assert.ok(bodyHtml.includes("参考来源"));
  assert.ok(bodyHtml.includes("[1] Red Bull to title sponsor · 2026-10-15"));
  assert.ok(bodyHtml.includes("[3] Another</p>"), "an unknown date is simply omitted");
  assert.ok(bodyHtml.indexOf("MotoGP 官方新闻") < bodyHtml.indexOf("RideApart"));
});

test("title and summary respect the editor's limits", () => {
  const article = digestToWechat(DIGEST);
  assert.equal(article.title, "红牛冠名澳洲站，杜卡迪更新 Desmo450");
  assert.equal(article.titleTruncated, false);
  assert.equal(article.summary, "红牛成为澳大利亚大奖赛冠名赞助商；雅马哈承包商服务器遭攻击；本田提供免费 3D 模型");

  const long = fitTitle("一二三四五六七八九十，".repeat(8));
  assert.ok([...long.text].length <= WECHAT_TITLE_MAX && long.truncated);
  assert.ok([...fitSummary("字".repeat(500))].length <= WECHAT_SUMMARY_MAX);
});

test("a weekly-style digest (briefing paragraph, no overview) still gets a summary from the briefing", () => {
  const weekly = "# 本周\n\n> 10月5日 – 10月11日（上周）\n\n上周摩托圈很热闹，新车扎堆发布。\n\n## 上周十大热点\n\n**1. 标题**\n\n正文。\n";
  assert.equal(digestToWechat(weekly).summary, "上周摩托圈很热闹，新车扎堆发布。");
});

test("the summary ends between items, not mid-phrase, and only the first item is cut if it alone is too long", () => {
  const item = (s: string) => `- ${s}。`;
  const md = (items: string[]) => `# T\n\n## 今日热点导览\n\n${items.map(item).join("\n")}\n\n## 今日头条\n\n**x**\n\ny\n`;
  const a = "甲".repeat(50), b = "乙".repeat(50), c = "丙".repeat(50);
  assert.equal(digestToWechat(md([a, b, c])).summary, `${a}；${b}`, "third would overflow, so it is left out whole");
  const long = digestToWechat(md(["甲".repeat(300)])).summary;
  assert.ok([...long].length <= WECHAT_SUMMARY_MAX && long.endsWith("…"));
});

test("truncation never cuts inside a Latin word and prefers a clause break", () => {
  const title = "MotoGP 莫特吉站马克·马奎斯夺最快、中上贵晶锁骨骨折，杜卡迪 2027 Multistrada V4 Pikes Peak 版发布并开启预订";
  const cut = fitTitle(title);
  assert.ok([...cut.text].length <= WECHAT_TITLE_MAX);
  assert.ok(!/Pea$|Pike$|Multistra$/.test(cut.text.replace(/…$/, "")), `cut inside a word: ${cut.text}`);
  const noBreaks = fitTitle("A".repeat(10) + " " + "word ".repeat(20));
  assert.ok(!/wor…?$/.test(noBreaks.text));
  assert.equal(fitSummary("短摘要"), "短摘要");
  const s = fitSummary("第一句话比较长一点。".repeat(20));
  assert.ok([...s].length <= WECHAT_SUMMARY_MAX && !s.endsWith("…"), "ends at a sentence break, no ellipsis needed");
});

test("regression: collapsing whitespace must not touch the letter s (a regex once lost its backslash)", () => {
  assert.equal(fitSummary("Multistrada   stays\n\nsharp"), "Multistrada stays sharp");
});

test("summary prefers a sentence break over a clause break, and a clause break over a list comma", () => {
  const text = `${"甲".repeat(60)}。${"乙".repeat(30)}，${"丙".repeat(30)}、${"丁".repeat(30)}`;
  const s = fitSummary(text);
  assert.equal(s, "甲".repeat(60), "cut at the full stop, the strongest break in range");
});
