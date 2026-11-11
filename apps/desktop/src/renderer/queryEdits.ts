import { foldText, type ParsedQuery, parseQuery } from "@matters/core";

/**
 * ADR 0026. Filters are tokens written into the query text. A token counts as already there only
 * when it is a top-level term of an AND (or the whole query): not negated, not in brackets, not
 * under an OR.
 */
function findOn(
  text: string,
  parsed: ParsedQuery,
  token: string,
): { start: number; end: number } | null {
  const root = parsed.root;
  if (root === null || root.kind === "or") return null;
  // `-from:x` is on as a negated top-level term; `from:x` as a plain one.
  const wantNegated = token.startsWith("-");
  const want = (wantNegated ? token.slice(1) : token).toLowerCase();
  let depth = 0;
  let negated = false;
  for (const t of parsed.tokens) {
    if (t.kind === "open") depth++;
    else if (t.kind === "close") depth = Math.max(depth - 1, 0);
    else if (t.kind === "minus" || t.kind === "not") negated = true;
    else {
      if (
        t.kind === "field" &&
        t.state === "ok" &&
        depth === 0 &&
        negated === wantNegated &&
        text.slice(t.start, t.end).toLowerCase() === want
      ) {
        return { start: t.start, end: t.end };
      }
      negated = false;
    }
  }
  return null;
}

/** The text with the token written in, unless it is already a top-level term. */
export function addFilter(text: string, token: string): string {
  const parsed = parseQuery(text);
  if (findOn(text, parsed, token) !== null) return text;
  let base = text.trim();
  if (base === "") return token;
  // An odd quote would swallow the token into a phrase.
  if ((base.match(/"/g)?.length ?? 0) % 2 === 1) base += '"';
  // `a OR b c` means `a OR (b AND c)`, and a trailing OR or minus would take the token.
  const last = parsed.tokens[parsed.tokens.length - 1];
  const dangling = last !== undefined && ["or", "and", "not", "minus"].includes(last.kind);
  if (parsed.root?.kind === "or" || dangling) base = `(${base})`;
  return `${base} ${token}`;
}

/**
 * ADR 0029. The text with `field:` at its end, waiting for a value. A field at the end that is
 * still waiting gives way, so that clicking around does not pile up empty fields.
 */
export function addField(text: string, field: string): string {
  const { tokens } = parseQuery(text);
  const last = tokens[tokens.length - 1];
  const waiting =
    last?.kind === "field" && last.valueStart === last.end && text.slice(last.end).trim() === "";
  if (!waiting) return addFilter(text, `${field}:`);
  const before = tokens[tokens.length - 2];
  const start = before?.kind === "minus" ? before.start : last.start;
  return addFilter(text.slice(0, start), `${field}:`);
}

const MAX_LABEL = 256;

/** `label:<value>` for a label id, or null when the parser could not read it back. */
export function labelToken(labelId: string): string | null {
  // The parser compares `label:` with the folded id, as the store keeps it (`label_fold`).
  const value = foldText(labelId).trim();
  if (value === "" || value.length > MAX_LABEL || value.includes('"')) return null;
  return `label:${/^[^\s()":]+$/.test(value) ? value : `"${value}"`}`;
}

/** `from:<address>` / `-from:<address>`; null when the address is not a plain word. */
export function senderToken(address: string, exclude: boolean): string | null {
  const a = address.trim().toLowerCase();
  if (!/^[^\s()":]+$/.test(a)) return null;
  return `${exclude ? "-" : ""}from:${a}`;
}

/** Top-level `field:` terms (ok, not under an OR or in brackets) whose text satisfies `want`. */
function topLevelTerms(
  text: string,
  parsed: ParsedQuery,
  want: (field: string, token: string, negated: boolean) => boolean,
): { start: number; end: number }[] {
  const root = parsed.root;
  if (root === null || root.kind === "or") return [];
  const out: { start: number; end: number }[] = [];
  let depth = 0;
  let minusAt: number | null = null;
  for (const t of parsed.tokens) {
    if (t.kind === "open") depth++;
    else if (t.kind === "close") depth = Math.max(depth - 1, 0);
    else if (t.kind === "minus" || t.kind === "not") minusAt = t.start;
    else {
      if (t.kind === "field" && t.state === "ok" && depth === 0 && t.field !== undefined) {
        const token = text.slice(t.start, t.end).toLowerCase();
        if (want(t.field, token, minusAt !== null))
          out.push({ start: minusAt ?? t.start, end: t.end });
      }
      minusAt = null;
    }
  }
  return out;
}

/** The text without the given spans, the white space around each closed up. */
function cut(text: string, spans: readonly { start: number; end: number }[]): string {
  let out = text;
  for (const { start, end } of [...spans].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, start)}${out.slice(end)}`;
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

/** The text without the token, when it is a top-level term (the reverse of `addFilter`). */
export function removeFilter(text: string, token: string): string {
  const negated = token.startsWith("-");
  const want = (negated ? token.slice(1) : token).toLowerCase();
  const found = topLevelTerms(text, parseQuery(text), (_f, t, n) => n === negated && t === want);
  return found.length === 0 ? text : cut(text, found);
}

/** The text without any top-level term of these fields, whatever its value. */
export function removeField(text: string, fields: readonly string[]): string {
  const found = topLevelTerms(text, parseQuery(text), (f) => fields.includes(f));
  return found.length === 0 ? text : cut(text, found);
}
