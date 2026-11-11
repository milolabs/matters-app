import type { ParsedQuery, QueryToken } from "@matters/core";

/**
 * ADR 0026. The query text cut into ordered pieces for the mirror behind the input. The pieces
 * cover the text exactly, so the mirror's glyphs sit under the input's.
 */
export type SegmentKind =
  | "plain"
  | "key" // `from:`
  | "value" // `anna`, also a bare word that is invalid
  | "grouped" // a word inside `from:(...)`
  | "op" // OR AND NOT -
  | "phrase" // a quoted phrase on its own
  | "bracket";

export interface QuerySegment {
  readonly text: string;
  readonly kind: SegmentKind;
  readonly state: QueryToken["state"];
  /** Segments of one `field:value` share the id of their token: the pill is drawn around both. */
  readonly pill?: number;
}

const OPERATORS = new Set<QueryToken["kind"]>(["or", "and", "not", "minus"]);

export function querySegments(text: string, parsed: ParsedQuery): readonly QuerySegment[] {
  const out: QuerySegment[] = [];
  let at = 0;
  const push = (end: number, kind: SegmentKind, state: QueryToken["state"], pill?: number) => {
    if (end <= at) return;
    out.push({ text: text.slice(at, end), kind, state, ...(pill === undefined ? {} : { pill }) });
    at = end;
  };
  parsed.tokens.forEach((t, i) => {
    // Spans ascend; one that does not fit the text (stale parse) is left as plain text.
    if (t.start < at || t.end > text.length) return;
    push(t.start, "plain", "ok");
    if (t.kind === "field") {
      const split = Math.min(Math.max(t.valueStart ?? t.start, t.start), t.end);
      push(split, "key", t.state, i);
      push(t.end, "value", t.state, i);
    } else if (OPERATORS.has(t.kind)) {
      push(t.end, "op", t.state);
    } else if (t.kind === "open" || t.kind === "close") {
      push(t.end, "bracket", t.state);
    } else if (t.field !== undefined) {
      push(t.end, "grouped", t.state, i);
    } else if (t.kind === "phrase") {
      push(t.end, "phrase", t.state);
    } else if (t.state === "invalid") {
      push(t.end, "value", "invalid", i);
    } else {
      push(t.end, "plain", "ok");
    }
  });
  push(text.length, "plain", "ok");
  return out;
}
