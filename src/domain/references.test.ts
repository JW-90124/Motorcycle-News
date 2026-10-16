import assert from "node:assert/strict";
import { test } from "node:test";
import { ReferenceRegistry } from "./references.js";
import type { RefInput } from "./references.js";

const ref = (n: string, source: string, publishedAt: string | null = "2026-10-09T08:00:00Z"): RefInput => ({
  url: `https://example.com/${n}`, title: `Title ${n}`, sourceName: source, publishedAt,
});

test("numbers follow order of first citation, and one article keeps one number", () => {
  const reg = new ReferenceRegistry();
  assert.equal(reg.cite([ref("a", "RideApart")]), '<sup><a href="#ref-1">[1]</a></sup>');
  assert.equal(reg.cite([ref("b", "Visordown")]), '<sup><a href="#ref-2">[2]</a></sup>');
  assert.equal(reg.cite([ref("a", "RideApart")]), '<sup><a href="#ref-1">[1]</a></sup>', "re-citing reuses [1]");
  assert.equal(reg.size, 2);
});

test("a merged item cites several articles in ascending order, without duplicates", () => {
  const reg = new ReferenceRegistry();
  reg.cite([ref("a", "RideApart")]);
  const marker = reg.cite([ref("c", "SPEEDWEEK"), ref("a", "RideApart"), ref("c", "SPEEDWEEK")]);
  assert.equal(marker, '<sup><a href="#ref-1">[1]</a><a href="#ref-2">[2]</a></sup>');
});

test("the reference list nests each outlet's articles under the outlet, in citation order", () => {
  const reg = new ReferenceRegistry();
  reg.cite([ref("1", "RideApart")]);
  reg.cite([ref("2", "Visordown")]);
  reg.cite([ref("3", "RideApart")]);
  reg.cite([ref("4", "RideApart")]);
  const section = reg.renderSection().join("\n");
  const lines = reg.renderSection();
  const outlets = lines.filter((l) => l.startsWith("- "));
  assert.deepEqual(outlets, ["- **RideApart**", "- **Visordown**"], "one top-level item per outlet, in order of first citation");
  const nested = lines.filter((l) => l.startsWith("  - "));
  assert.equal(nested.length, 4, "every article is indented under an outlet");
  assert.ok(lines.indexOf("- **RideApart**") + 1 < lines.indexOf("- **Visordown**"));
  assert.ok(section.includes('  - <a id="ref-3"></a>[3] [Title 3](https://example.com/3) · 2026-10-09'));
  assert.ok(!section.includes("引用 1"), "the numbers live on the entries, not in the outlet heading");
  assert.ok(!section.includes("方括号"), "no explanatory preamble");
});

test("an unknown date is left out rather than invented; brackets in a title cannot break the link", () => {
  const reg = new ReferenceRegistry();
  reg.cite([{ ...ref("x", "S", null), title: "Hot [new] bike" }]);
  const line = reg.renderSection().find((l) => l.includes("[1]") && l.startsWith("  - "))!;
  assert.equal(line, '  - <a id="ref-1"></a>[1] [Hot new bike](https://example.com/x)');
});

test("nothing cited means no reference section at all", () => {
  assert.deepEqual(new ReferenceRegistry().renderSection(), []);
});
