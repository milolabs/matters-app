import { type HitSegment, highlight } from "./hits.ts";

/**
 * ADR 0077. The marked parts of a list row. A row is drawn again and again while the list scrolls,
 * so the segments of a message are cut once per query and kept; with no word there is no work and
 * nothing is kept. The cache forgets everything when the words change or it grows past a screen
 * or two of messages' worth.
 */
export interface RowSegments {
  readonly subject: readonly HitSegment[];
  readonly snippet: readonly HitSegment[];
}

interface Source {
  readonly key: number;
  readonly subject: string;
  readonly snippet: string;
}

export const ROW_CACHE_MAX = 600;

export function createRowHits(): {
  of(message: Source, words: readonly string[]): RowSegments | null;
  readonly size: number;
} {
  let signature = "";
  const kept = new Map<number, { subject: string; snippet: string; segments: RowSegments }>();
  return {
    of(message, words) {
      if (words.length === 0) {
        if (kept.size > 0) kept.clear();
        signature = "";
        return null;
      }
      const sig = words.join("\u0001");
      if (sig !== signature || kept.size >= ROW_CACHE_MAX) {
        kept.clear();
        signature = sig;
      }
      const subject = message.subject.trim() === "" ? "(no subject)" : message.subject;
      const hit = kept.get(message.key);
      if (hit !== undefined && hit.subject === subject && hit.snippet === message.snippet) {
        return hit.segments;
      }
      const segments: RowSegments = {
        subject: highlight(subject, words),
        snippet: highlight(message.snippet, words),
      };
      kept.set(message.key, { subject, snippet: message.snippet, segments });
      return segments;
    },
    get size() {
      return kept.size;
    },
  };
}
