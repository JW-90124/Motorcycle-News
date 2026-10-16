/**
 * Numeric citations with a reference list grouped by source (2026-10-16).
 *
 * Why: after every item the digest used to print its source and link inline —
 * with a handful of outlets behind ~40 items a day, that was the same few names
 * repeated dozens of times and the body text was hard to scan. Now an item ends
 * with just its number(s), and one "参考来源" section at the end lists every
 * article, grouped by the outlet it came from.
 *
 * Numbering is by order of first appearance in the text (the same scheme as
 * GB/T 7714's 顺序编码制 / IEEE / Vancouver), one number per distinct article, so
 * the same article cited twice keeps one number. Grouping the list by outlet is
 * the one deliberate departure from those standards — they order the list by
 * number — and it is what lets a reader see at a glance "items 1, 3, 5 and 10
 * all come from RideApart".
 */

export interface RefInput {
  url: string;
  title: string;
  sourceName: string;
  /** ISO publish date, or null when unknown (an inferred date is never shown as fact). */
  publishedAt: string | null;
}

interface Entry {
  n: number;
  ref: RefInput;
}

const dayOf = (iso: string | null): string => (iso && Number.isFinite(Date.parse(iso)) ? iso.slice(0, 10) : "");

export class ReferenceRegistry {
  private readonly byUrl = new Map<string, Entry>();

  /** Registers the articles (once each, by URL) and returns the in-text marker, e.g. `[1][4]`. */
  cite(refs: RefInput[]): string {
    const numbers: number[] = [];
    for (const ref of refs) {
      let entry = this.byUrl.get(ref.url);
      if (!entry) {
        entry = { n: this.byUrl.size + 1, ref };
        this.byUrl.set(ref.url, entry);
      }
      if (!numbers.includes(entry.n)) numbers.push(entry.n);
    }
    if (numbers.length === 0) return "";
    numbers.sort((a, b) => a - b);
    return `<sup>${numbers.map((n) => `<a href="#ref-${n}">[${n}]</a>`).join("")}</sup>`;
  }

  get size(): number {
    return this.byUrl.size;
  }

  /** The "参考来源" section as markdown lines; empty when nothing was cited. */
  renderSection(): string[] {
    if (this.byUrl.size === 0) return [];
    const bySource = new Map<string, Entry[]>();
    for (const entry of [...this.byUrl.values()].sort((a, b) => a.n - b.n)) {
      const bucket = bySource.get(entry.ref.sourceName) ?? [];
      bucket.push(entry);
      bySource.set(entry.ref.sourceName, bucket);
    }

    const lines = ["## 参考来源", "", "> 方括号数字是正文里的引用编号；按来源归并，同一来源的文章列在一起。", ""];
    // Sources appear in the order they are first cited, entries ascending within each.
    for (const [sourceName, entries] of bySource) {
      lines.push(`### ${sourceName} · 引用 ${entries.map((e) => e.n).join("、")}`, "");
      for (const { n, ref } of entries) {
        const date = dayOf(ref.publishedAt);
        lines.push(`- <a id="ref-${n}"></a>[${n}] [${ref.title.replace(/[[\]]/g, "")}](${ref.url})${date ? ` · ${date}` : ""}`);
      }
      lines.push("");
    }
    return lines;
  }
}
