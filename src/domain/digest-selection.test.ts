import assert from "node:assert/strict";
import { test } from "node:test";
import { firstSentence, selectBalanced } from "./digest-selection.js";
import type { ScoredSignal } from "./score-signals.js";

function item(category: string, id: string, score: number): ScoredSignal {
  return {
    signal: {
      externalId: id, url: `https://x/${id}`, title: id, summary: "s", language: "en",
      publishedAt: "2026-10-09T00:00:00Z", category, tags: [], metrics: {}, rawMeta: {},
      sourceSlug: "s", sourceName: "S",
    },
    heat: score, confidence: 0, clusterSize: 1,
  };
}

const ORDER = ["racing", "new-models", "culture"];

test("a loud direction cannot crowd out a quiet one", () => {
  const racing = Array.from({ length: 40 }, (_, i) => item("racing", `r${i}`, 100 - i % 3));
  const culture = [item("culture", "c1", 20), item("culture", "c2", 10)];
  const picked = selectBalanced([...racing, ...culture], ORDER, { full: 5, brief: 5 });
  assert.equal(picked.filter((p) => p.item.signal.category === "racing").length, 10);
  assert.equal(picked.filter((p) => p.item.signal.category === "culture").length, 2, "low-scoring but only items of their direction still get shown");
});

test("within a direction: best first as full, next as brief, rest dropped", () => {
  const items = Array.from({ length: 14 }, (_, i) => item("racing", `r${i}`, i));
  const picked = selectBalanced(items, ORDER, { full: 3, brief: 4 });
  const full = picked.filter((p) => p.tier === "full").map((p) => p.item.signal.title);
  const brief = picked.filter((p) => p.tier === "brief").map((p) => p.item.signal.title);
  assert.deepEqual(full, ["r13", "r12", "r11"]);
  assert.deepEqual(brief, ["r10", "r9", "r8", "r7"]);
});

test("directions come out in the configured order, unknown ones last", () => {
  const picked = selectBalanced([item("culture", "c", 1), item("zzz", "z", 1), item("racing", "r", 1)], ORDER);
  assert.deepEqual(picked.map((p) => p.item.signal.category), ["racing", "culture", "zzz"]);
});

test("firstSentence cuts at the first full stop and caps length", () => {
  assert.equal(firstSentence("第一句。第二句。"), "第一句。");
  assert.equal(firstSentence("没有句号的一段很长的文字".repeat(20), 10).length, 10);
});

import { findLikelyDuplicateGroups, modelCodes } from "./digest-selection.js";

test("model codes: keeps CMX500 / T40 / Desmo450, drops years, session codes and units", () => {
  assert.deepEqual(modelCodes("2027 Honda CMX500 Rebel 100cc FP1 Moto3 Q2 T40 Desmo450"), ["cmx500", "t40", "desmo450"]);
});

const T = (title: string, category = "new-models") => ({ title, category });

test("likely duplicates: same manufacturer + a shared model name, across outlets and languages", () => {
  const items = [
    T("Honda CMX500 Rebel evolves with e-clutch for 2027"),
    T("Triumph Introduces the Most Accessible Bonneville Ever. And A Menacing Sibling"),
    T("Honda’s middleweight Rebel platform leads series of 2027 updates"),
    T("Triumph Bonneville T40 and T40 Black: the 1960s icon, now within everyone's reach"),
    T("本田 CMX500 Rebel 迎来 2027 款"),
    T("Updated Ducati Desmo450 MX and 450 MX Factory announced"),
    T("The New Multistrada V4 S Grand Tour Is Ducati’s $31,000 Road-Trip Cheat Code"),
  ];
  assert.deepEqual(findLikelyDuplicateGroups(items), [[0, 2, 4], [1, 3]]);
});

test("the brand name alone never links two items (Ducati Multistrada vs Ducati Desmo450)", () => {
  assert.deepEqual(findLikelyDuplicateGroups([T("Ducati Multistrada V4 S Grand Tour"), T("Ducati Desmo450 MX updated")]), []);
});

test("racing items are never grouped, however many riders and codes they share", () => {
  const racing = (title: string) => T(title, "racing");
  assert.deepEqual(findLikelyDuplicateGroups([racing("Marquez wins sprint on Ducati GP26"), racing("Marquez explains Ducati GP26 push-ups")]), []);
});

test("a generic shared code (FP1) does not glue unrelated stories together", () => {
  assert.deepEqual(findLikelyDuplicateGroups([T("Honda FP1 test"), T("Honda Moto3 FP1 report")]), []);
});
