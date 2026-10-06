/**
 * Per-source health tracking. Added 2026-10-06 after two incidents where a
 * source (or the whole pipeline) broke and nobody noticed for weeks: the
 * 2026-08-31 digest outage, and Visordown silently yielding zero new
 * articles for two weeks after a site redesign. Nothing here changes what is
 * collected — it only turns "this source looks broken" into a visible
 * warning on every run, instead of relying on someone remembering to read
 * the Actions log.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SourceHealth {
  consecutiveErrors: number;
  /** Fetched nothing at all, without an error being raised. */
  consecutiveEmpty: number;
  /** Runs in a row that fetched fine but produced no new article. */
  runsSinceNew: number;
  lastNewAt?: string;
  lastError?: string;
}

export type HealthState = Record<string, SourceHealth>;

export interface RunOutcome {
  fetched: number;
  newCount: number;
  error?: string;
}

// Mon/Wed/Fri cadence: 8 runs is a little under three weeks. Sparse-but-
// healthy sources (a COE round every two weeks) stay under it.
export const NO_NEW_WARN_RUNS = 8;
export const ERROR_WARN_RUNS = 2;
export const EMPTY_WARN_RUNS = 2;

const HEALTH_PATH = "data/source-health.json";

export function updateHealth(previous: SourceHealth | undefined, outcome: RunOutcome, nowIso: string): SourceHealth {
  const base: SourceHealth = previous ?? { consecutiveErrors: 0, consecutiveEmpty: 0, runsSinceNew: 0 };
  if (outcome.error) {
    return { ...base, consecutiveErrors: base.consecutiveErrors + 1, lastError: outcome.error.slice(0, 200) };
  }
  const next: SourceHealth = { ...base, consecutiveErrors: 0 };
  delete next.lastError;
  next.consecutiveEmpty = outcome.fetched === 0 ? base.consecutiveEmpty + 1 : 0;
  if (outcome.newCount > 0) {
    next.runsSinceNew = 0;
    next.lastNewAt = nowIso;
  } else {
    next.runsSinceNew = base.runsSinceNew + 1;
  }
  return next;
}

export function healthWarnings(name: string, health: SourceHealth): string[] {
  const warnings: string[] = [];
  if (health.consecutiveErrors >= ERROR_WARN_RUNS) {
    warnings.push(`${name}：连续 ${health.consecutiveErrors} 次抓取报错（${health.lastError ?? "未知错误"}）`);
  }
  if (health.consecutiveEmpty >= EMPTY_WARN_RUNS) {
    warnings.push(`${name}：连续 ${health.consecutiveEmpty} 次抓到 0 条，页面结构可能变了`);
  }
  if (health.consecutiveErrors === 0 && health.runsSinceNew >= NO_NEW_WARN_RUNS) {
    warnings.push(
      `${name}：连续 ${health.runsSinceNew} 次运行没有任何新内容（上次有新内容：${health.lastNewAt?.slice(0, 10) ?? "无记录"}），可能已失效`,
    );
  }
  return warnings;
}

export async function loadHealth(path = HEALTH_PATH): Promise<HealthState> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as HealthState;
  } catch {
    return {};
  }
}

export async function saveHealth(state: HealthState, path = HEALTH_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
