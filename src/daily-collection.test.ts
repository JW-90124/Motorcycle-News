import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { saveDailyCollection } from "./daily-collection.js";

function signal(id: string, sourceSlug = "source") {
  return {
    externalId: id, sourceSlug, sourceName: sourceSlug,
    url: `https://example.com/${id}`, title: id, summary: "Saved article",
    language: "en", publishedAt: "2026-09-21T00:00:00Z", category: "news",
    tags: [], metrics: {}, rawMeta: {},
  };
}

test("same-day reruns preserve saved articles, deduplicate, and append new articles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "motorcycle-collection-"));
  try {
    const path = join(dir, "raw", "2026-09-21.json");
    await saveDailyCollection(path, [signal("first")]);
    const before = await readFile(path, "utf8");
    await saveDailyCollection(path, []);
    assert.equal(await readFile(path, "utf8"), before);
    await saveDailyCollection(path, [signal("first"), signal("second"), signal("first", "other-source")]);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved.signals, [signal("first"), signal("second"), signal("first", "other-source")]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed existing archives fail without overwriting saved data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "motorcycle-collection-"));
  try {
    const path = join(dir, "daily.json");
    for (const body of ["broken JSON", '{"signals":null}']) {
      await writeFile(path, body);
      await assert.rejects(saveDailyCollection(path, [signal("new")]));
      assert.equal(await readFile(path, "utf8"), body);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
