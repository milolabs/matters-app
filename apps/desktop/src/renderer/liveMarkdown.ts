// The reply editor's live Markdown (ADR 0100): the text stays Markdown, as the draft, the gaps and
// the send read it, but it looks like what is sent. Bold reads bold, a list reads as a list, and the
// syntax that makes them fades. The quote of the answered message folds to "···". A placeholder
// such as `[kwota]` is marked, and a value the agent found for it is offered beside it.
//
// No parser package: the lines are read with a few patterns, which is all a mail needs. Everything
// here is CodeMirror 6 view/state code and runs only on the visible lines.
import {
  EditorSelection,
  type EditorState,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

/** A value the agent found for a placeholder, and where it found it. */
export interface GapSuggestion {
  readonly token: string;
  readonly value: string;
  readonly source: string;
}

// --- Where the quote starts ---

const ATTRIBUTION = /wrote:\s*$|napisał(a)?:\s*$/i;

/**
 * Where the quoted message starts: the first line of the trailing run of `>` lines (and empty
 * lines), or the attribution line just above it. Null when the text ends with no quote.
 */
export function quoteStart(text: string): number | null {
  const lines = text.split("\n");
  let k = lines.length;
  while (k > 0) {
    const line = lines[k - 1] as string;
    if (line.trim() === "" || /^\s*>/.test(line)) k--;
    else break;
  }
  // The run must hold at least one quoted line.
  if (!lines.slice(k).some((l) => /^\s*>/.test(l))) return null;
  while (k < lines.length && (lines[k] as string).trim() === "") k++;
  let first = k;
  const above = lines[k - 1];
  if (above !== undefined && ATTRIBUTION.test(above)) first = k - 1;
  let offset = 0;
  for (let i = 0; i < first; i++) offset += (lines[i] as string).length + 1;
  return offset;
}

// --- Folding the quote ---

export const toggleQuote = StateEffect.define<boolean>();

/** Whether the quote is folded; it starts folded. */
export const quoteFolded = StateField.define<boolean>({
  create: () => true,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(toggleQuote)) return e.value;
    return value;
  },
});

class QuoteWidget extends WidgetType {
  readonly folded: boolean;
  constructor(folded: boolean) {
    super();
    this.folded = folded;
  }
  override eq(other: QuoteWidget) {
    return other.folded === this.folded;
  }
  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-quote-toggle";
    button.textContent = "···";
    button.title = this.folded ? "Show the quoted message" : "Hide the quoted message";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", String(!this.folded));
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", () => {
      view.dispatch({ effects: toggleQuote.of(!this.folded) });
    });
    const wrap = document.createElement("div");
    wrap.className = "cm-quote-line";
    wrap.appendChild(button);
    return wrap;
  }
  override ignoreEvent() {
    return true;
  }
}

function quoteDecorations(state: EditorState): DecorationSet {
  const at = quoteStart(state.doc.toString());
  if (at === null) return Decoration.none;
  const folded = state.field(quoteFolded);
  const builder = new RangeSetBuilder<Decoration>();
  if (folded) {
    builder.add(
      at,
      state.doc.length,
      Decoration.replace({ widget: new QuoteWidget(true), block: true }),
    );
  } else {
    builder.add(
      at,
      at,
      Decoration.widget({ widget: new QuoteWidget(false), block: true, side: -1 }),
    );
  }
  return builder.finish();
}

const quoteField = StateField.define<DecorationSet>({
  create: (state) => quoteDecorations(state),
  update(value, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(toggleQuote))) {
      return quoteDecorations(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- How the visible lines look ---

const mark = (cls: string) => Decoration.mark({ class: cls });
const syntax = mark("cm-md-syntax");
const bold = mark("cm-md-bold");
const italic = mark("cm-md-italic");
const strike = mark("cm-md-strike");
const code = mark("cm-md-code");
const linkText = mark("cm-md-link");
const gap = mark("cm-md-gap");
const quoteLine = Decoration.line({ class: "cm-md-quote" });
const listLine = Decoration.line({ class: "cm-md-list" });
const headLine = Decoration.line({ class: "cm-md-head" });

// Inline patterns, in the order they are tried; each gives the syntax parts and the text part.
const INLINE: readonly { re: RegExp; open: number; close: number; deco: Decoration }[] = [
  { re: /\*\*(?=\S)(.+?)(?<=\S)\*\*/g, open: 2, close: 2, deco: bold },
  { re: /~~(?=\S)(.+?)(?<=\S)~~/g, open: 2, close: 2, deco: strike },
  {
    re: /(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![*\w])/g,
    open: 1,
    close: 1,
    deco: italic,
  },
  { re: /(?<![_\w])_(?=\S)([^_\n]+?)(?<=\S)_(?![_\w])/g, open: 1, close: 1, deco: italic },
  { re: /`([^`\n]+)`/g, open: 1, close: 1, deco: code },
];
const LINK = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;
// The same gaps the send checks (core `gaps`): `[like this]`, not a link, a reference or a box.
const GAP = /(?<![!\]])\[(?![ xX]\])(?!\s*(?:[a-z][a-z0-9+.-]*:|www\.))([^\][\n]+)\](?![([:])/gi;

interface Range {
  from: number;
  to: number;
  deco: Decoration;
}

/** The decorations of one line of the writer's own text. */
export function lineRanges(text: string, start: number): Range[] {
  const out: Range[] = [];
  const list = /^(\s*)([-*+]|\d+[.)])\s/.exec(text);
  if (list) {
    const s = start + (list[1] as string).length;
    out.push({ from: s, to: s + (list[2] as string).length, deco: syntax });
  }
  const head = /^(#{1,6})\s/.exec(text);
  if (head) out.push({ from: start, to: start + (head[1] as string).length + 1, deco: syntax });
  for (const { re, open, close, deco } of INLINE) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const from = start + (m.index ?? 0);
      const to = from + m[0].length;
      out.push({ from, to: from + open, deco: syntax });
      out.push({ from: from + open, to: to - close, deco });
      out.push({ from: to - close, to, deco: syntax });
    }
  }
  for (const m of text.matchAll(LINK)) {
    const from = start + (m.index ?? 0);
    const label = (m[1] as string).length;
    out.push({ from, to: from + 1, deco: syntax });
    out.push({ from: from + 1, to: from + 1 + label, deco: linkText });
    out.push({ from: from + 1 + label, to: from + m[0].length, deco: syntax });
  }
  for (const m of text.matchAll(GAP)) {
    const from = start + (m.index ?? 0);
    out.push({ from, to: from + m[0].length, deco: gap });
  }
  return out;
}

export const setSuggestions = StateEffect.define<readonly GapSuggestion[]>();

/** What the agent found for the gaps; the widgets read it. */
export const suggestionsField = StateField.define<readonly GapSuggestion[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSuggestions)) return e.value;
    return value;
  },
});

/** Puts a suggested value in place of its placeholder, everywhere the placeholder is written. */
export function acceptSuggestion(view: EditorView, s: GapSuggestion): boolean {
  const text = view.state.doc.toString();
  const end = quoteStart(text) ?? text.length;
  const changes: { from: number; to: number; insert: string }[] = [];
  let at = text.indexOf(s.token);
  while (at !== -1 && at < end) {
    changes.push({ from: at, to: at + s.token.length, insert: s.value });
    at = text.indexOf(s.token, at + s.token.length);
  }
  if (changes.length === 0) return false;
  view.dispatch({
    changes,
    effects: setSuggestions.of(view.state.field(suggestionsField).filter((x) => x !== s)),
    userEvent: "input.agent",
  });
  return true;
}

class SuggestionWidget extends WidgetType {
  readonly s: GapSuggestion;
  constructor(s: GapSuggestion) {
    super();
    this.s = s;
  }
  override eq(other: SuggestionWidget) {
    return other.s === this.s;
  }
  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-gap-fill";
    button.title = `Found by the agent in ${this.s.source}. Tab puts it in.`;
    const spark = document.createElement("span");
    spark.className = "cm-gap-spark";
    spark.textContent = "✦";
    const value = document.createElement("span");
    value.textContent = this.s.value;
    const source = document.createElement("small");
    source.textContent = this.s.source;
    const key = document.createElement("kbd");
    key.textContent = "Tab";
    button.append(spark, value, source, key);
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", () => acceptSuggestion(view, this.s));
    return button;
  }
  override ignoreEvent() {
    return true;
  }
}

function buildLook(view: EditorView): DecorationSet {
  const state = view.state;
  const text = state.doc.toString();
  const end = quoteStart(text) ?? text.length;
  const suggestions = state.field(suggestionsField);
  const ranges: Range[] = [];
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      if (line.from >= end) break;
      if (/^\s*>/.test(line.text)) ranges.push({ from: line.from, to: line.from, deco: quoteLine });
      else {
        if (/^\s*([-*+]|\d+[.)])\s/.test(line.text)) {
          ranges.push({ from: line.from, to: line.from, deco: listLine });
        }
        if (/^#{1,6}\s/.test(line.text))
          ranges.push({ from: line.from, to: line.from, deco: headLine });
        ranges.push(...lineRanges(line.text, line.from));
        for (const s of suggestions) {
          let at = line.text.indexOf(s.token);
          while (at !== -1) {
            const after = line.from + at + s.token.length;
            ranges.push({
              from: after,
              to: after,
              deco: Decoration.widget({ widget: new SuggestionWidget(s), side: 1 }),
            });
            at = line.text.indexOf(s.token, at + s.token.length);
          }
        }
      }
      pos = line.to + 1;
    }
  }
  // A builder takes ranges in order; line decorations go first at their position.
  ranges.sort((a, b) => a.from - b.from || startSide(a.deco) - startSide(b.deco) || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.deco);
  return builder.finish();
}

const startSide = (d: Decoration) => (d.spec as { startSide?: number }).startSide ?? d.startSide;

const look = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildLook(view);
    }
    update(u: ViewUpdate) {
      const moved = u.docChanged || u.viewportChanged;
      const asked = u.transactions.some((t) => t.effects.some((e) => e.is(setSuggestions)));
      if (moved || asked) this.decorations = buildLook(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// --- The toolbar's commands ---

/** Wraps the selection (or the word at the cursor) in `mark`, or takes the mark away. */
export function toggleInline(view: EditorView, markText: string): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    let { from, to } = range;
    if (from === to) {
      const word = state.wordAt(from);
      if (word) ({ from, to } = word);
    }
    const n = markText.length;
    const before = state.sliceDoc(from - n, from);
    const after = state.sliceDoc(to, to + n);
    if (before === markText && after === markText) {
      return {
        changes: [
          { from: from - n, to: from },
          { from: to, to: to + n },
        ],
        range: rangeOf(from - n, to - n),
      };
    }
    return {
      changes: [
        { from, insert: markText },
        { from: to, insert: markText },
      ],
      range: rangeOf(from + n, to + n),
    };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input.format" }));
  view.focus();
  return true;
}

/** Puts `prefix` in front of every selected line, or takes it away when all of them have it. */
export function toggleLinePrefix(view: EditorView, kind: "bullet" | "number" | "quote"): boolean {
  const { state } = view;
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    for (let p = state.doc.lineAt(r.from).number; p <= state.doc.lineAt(r.to).number; p++) {
      lines.add(p);
    }
  }
  const pattern = kind === "bullet" ? /^[-*+]\s/ : kind === "number" ? /^\d+[.)]\s/ : /^>\s?/;
  const all = [...lines].every((n) => pattern.test(state.doc.line(n).text));
  const changes = [...lines].map((n, i) => {
    const line = state.doc.line(n);
    if (all) {
      const m = pattern.exec(line.text) as RegExpExecArray;
      return { from: line.from, to: line.from + m[0].length };
    }
    const insert = kind === "bullet" ? "- " : kind === "number" ? `${i + 1}. ` : "> ";
    return { from: line.from, insert };
  });
  view.dispatch({ changes, userEvent: "input.format" });
  view.focus();
  return true;
}

/** `[text](https://)` around the selection, with the address selected to type over. */
export function insertLink(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  const label = state.sliceDoc(r.from, r.to) || "link";
  const insert = `[${label}](https://)`;
  const urlFrom = r.from + label.length + 3;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert },
    selection: { anchor: urlFrom, head: urlFrom + 8 },
    userEvent: "input.format",
  });
  view.focus();
  return true;
}

/** Takes bold, italics, strikethrough and code marks out of the selection. */
export function clearFormatting(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  if (r.empty) return false;
  const text = state.sliceDoc(r.from, r.to);
  const plain = text.replace(/\*\*|~~|(?<!\w)[*_](?!\s)|(?<!\s)[*_](?!\w)|`/g, "");
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: plain },
    selection: { anchor: r.from, head: r.from + plain.length },
    userEvent: "input.format",
  });
  view.focus();
  return true;
}

const rangeOf = (anchor: number, head: number) => EditorSelection.range(anchor, head);

/** The writer's own lines, above the quote. */
export function ownText(doc: string): string {
  const at = quoteStart(doc);
  return at === null ? doc : doc.slice(0, at);
}

export const liveTheme = EditorView.theme({
  ".cm-md-syntax": { color: "var(--edge)" },
  ".cm-md-bold": { fontWeight: "600" },
  ".cm-md-italic": { fontStyle: "italic" },
  ".cm-md-strike": { textDecoration: "line-through" },
  ".cm-md-code": { fontFamily: "ui-monospace, SF Mono, Menlo, monospace", fontSize: "12.5px" },
  ".cm-md-link": {
    textDecoration: "underline",
    textDecorationColor: "var(--edge)",
    textUnderlineOffset: "3px",
  },
  ".cm-md-gap": { background: "var(--hit)", color: "var(--hit-ink)", borderRadius: "4px" },
  ".cm-md-quote": { color: "var(--secondary)", borderLeft: "2px solid var(--hairline)" },
  ".cm-md-list": { paddingLeft: "6px !important" },
  ".cm-md-head": { fontWeight: "600", fontSize: "16px" },
  ".cm-quote-line": { padding: "4px 2px 8px" },
  ".cm-quote-toggle": {
    height: "20px",
    padding: "0 8px",
    border: "0",
    borderRadius: "6px",
    background: "var(--fill)",
    color: "var(--secondary)",
    font: "14px/1 -apple-system, system-ui, sans-serif",
    letterSpacing: "2px",
    cursor: "default",
  },
  ".cm-gap-fill": {
    display: "inline-flex",
    alignItems: "baseline",
    gap: "4px",
    margin: "0 2px 0 6px",
    padding: "0 3px 0 6px",
    border: "1px dashed var(--agent)",
    borderRadius: "6px",
    background: "transparent",
    color: "var(--agent)",
    font: "13px/1.5 -apple-system, system-ui, sans-serif",
    cursor: "default",
  },
  ".cm-gap-fill small": { color: "var(--secondary)", fontSize: "11px" },
  ".cm-gap-fill kbd": {
    fontFamily: "inherit",
    fontSize: "10px",
    color: "var(--secondary)",
    background: "var(--agent-soft)",
    borderRadius: "4px",
    padding: "0 4px",
  },
  ".cm-gap-spark": { fontSize: "11px" },
});

/** Everything the reply editor adds to plain CodeMirror. */
export function liveMarkdown(): Extension {
  return [quoteFolded, quoteField, suggestionsField, look, liveTheme];
}
