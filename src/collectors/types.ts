/**
 * Adapter contract — ported from agent-pulse's `src/collectors/types.ts`.
 */

import type { CollectedSignal, SourceDescriptor } from "../types.js";
import type { FetchResult } from "../fetcher.js";

export interface CollectContext {
  fetchText: (url: string, headers?: Record<string, string>) => Promise<FetchResult>;
}

export type { FetchResult };

export interface SourceAdapter {
  kind: string;
  collect(source: SourceDescriptor, context: CollectContext): Promise<CollectedSignal[]>;
}
