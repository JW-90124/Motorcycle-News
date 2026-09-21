import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CollectedSignal } from "./types.js";

type SavedSignal = CollectedSignal & { sourceSlug: string; sourceName: string };

/** Preserve earlier batches when a scheduled job is run again the same day. */
export async function saveDailyCollection(path: string, incoming: SavedSignal[]): Promise<void> {
  let existing: SavedSignal[] = [];
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as { signals: SavedSignal[] };
    if (!Array.isArray(data.signals)) throw new Error(`Invalid signals array in ${path}`);
    existing = data.signals;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // An empty rerun should not rewrite or erase an existing daily archive.
  if (existing.length > 0 && incoming.length === 0) return;
  const byKey = new Map<string, SavedSignal>();
  for (const signal of [...existing, ...incoming]) {
    const key = JSON.stringify([signal.sourceSlug, signal.externalId || signal.url || signal.title]);
    // Keep the already saved article when the same source returns it again.
    if (!byKey.has(key)) byKey.set(key, signal);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ collectedAt: new Date().toISOString(), signals: [...byKey.values()] }, null, 2)}\n`, "utf8");
}
