import assert from "node:assert/strict";
import { test } from "node:test";
import { healthWarnings, NO_NEW_WARN_RUNS, updateHealth } from "./source-health.js";
import type { SourceHealth } from "./source-health.js";

const NOW = "2026-10-06T00:00:00.000Z";

test("errors accumulate, then clear after a successful run", () => {
  let health: SourceHealth | undefined;
  health = updateHealth(health, { fetched: 0, newCount: 0, error: "HTTP 403" }, NOW);
  health = updateHealth(health, { fetched: 0, newCount: 0, error: "HTTP 403" }, NOW);
  assert.equal(health.consecutiveErrors, 2);
  assert.equal(healthWarnings("S", health).length, 1);
  health = updateHealth(health, { fetched: 5, newCount: 1 }, NOW);
  assert.equal(health.consecutiveErrors, 0);
  assert.equal(health.lastError, undefined);
  assert.deepEqual(healthWarnings("S", health), []);
});

test("a silent source (fetches fine, never finds anything new) warns only after the threshold", () => {
  let health: SourceHealth | undefined;
  for (let i = 0; i < NO_NEW_WARN_RUNS - 1; i++) health = updateHealth(health, { fetched: 4, newCount: 0 }, NOW);
  assert.deepEqual(healthWarnings("S", health!), []);
  health = updateHealth(health, { fetched: 4, newCount: 0 }, NOW);
  assert.equal(healthWarnings("S", health).length, 1);
  health = updateHealth(health, { fetched: 4, newCount: 2 }, NOW);
  assert.equal(health.runsSinceNew, 0);
  assert.equal(health.lastNewAt, NOW);
});

test("repeated empty fetches without an error are flagged as a likely structure change", () => {
  let health: SourceHealth | undefined;
  health = updateHealth(health, { fetched: 0, newCount: 0 }, NOW);
  assert.deepEqual(healthWarnings("S", health), []);
  health = updateHealth(health, { fetched: 0, newCount: 0 }, NOW);
  assert.match(healthWarnings("S", health)[0]!, /0 条/);
});
