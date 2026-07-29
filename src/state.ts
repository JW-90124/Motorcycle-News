/**
 * Lightweight JSON-file dedup state — this project's equivalent of
 * agent-pulse's SQLite-backed signal tracking, simplified per the
 * architecture decision in `能力结构.md`: no relational DB, just a state
 * file that remembers what's already been seen. Same pattern as the
 * `.sent.json` dedup file used in the AI News WeChat digest push script.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STATE_PATH = "data/state.json";
const RETENTION_DAYS = 30;

/** sourceSlug -> { [dedupKey]: isoTimestampFirstSeen } */
export type CollectionState = Record<string, Record<string, string>>;

export async function loadState(path = STATE_PATH): Promise<CollectionState> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CollectionState;
  } catch {
    return {};
  }
}

export async function saveState(state: CollectionState, path = STATE_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const pruned = pruneOldEntries(state);
  await writeFile(path, `${JSON.stringify(pruned, null, 2)}\n`, "utf8");
}

/** Returns true if this key was NOT seen before, and records it as seen. */
export function markIfNew(state: CollectionState, sourceSlug: string, dedupKey: string): boolean {
  const bucket = (state[sourceSlug] ??= {});
  if (bucket[dedupKey]) return false;
  bucket[dedupKey] = new Date().toISOString();
  return true;
}

function pruneOldEntries(state: CollectionState): CollectionState {
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  const pruned: CollectionState = {};
  for (const [sourceSlug, bucket] of Object.entries(state)) {
    const keptEntries = Object.entries(bucket).filter(([, seenAt]) => Date.parse(seenAt) >= cutoff);
    if (keptEntries.length > 0) pruned[sourceSlug] = Object.fromEntries(keptEntries);
  }
  return pruned;
}
