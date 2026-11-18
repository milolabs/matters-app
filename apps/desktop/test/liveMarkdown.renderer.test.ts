// The reply editor's live Markdown (ADR 0100): where the quote starts, and how a line is marked.
import { EditorState, type Transaction, type TransactionSpec } from "@codemirror/state";
import { type DecorationSet, EditorView } from "@codemirror/view";
import {
  draftSections,
  FORWARD_MARK,
  joinSections,
  sectionStarts,
  signatureBlock,
} from "@matters/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  acceptSuggestion,
  lineRanges,
  liveMarkdown,
  ownText,
  quoteStart,
  signatureStart,
  suggestionsField,
  toggleQuote,
} from "../src/renderer/liveMarkdown.ts";

/** Where the editor folds the quote: the start of the "···" that stands for it, or null. */
function foldedAt(doc: string): number | null {
  const state = EditorState.create({ doc, extensions: liveMarkdown() });
  let at: number | null = null;
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue;
    (source as DecorationSet).between(0, doc.length, (from) => {
      at = from;
    });
  }
  return at;
}

describe("quoteStart", () => {
  it("starts at the attribution line above the quoted lines", () => {
    const text = "Dziękuję!\n\nOn 3 Nov 2026, 10:29, Anna wrote:\n> Cena?\n>\n> Pozdrawiam\n";
    expect(quoteStart(text)).toBe("Dziękuję!\n\n".length);
    expect(ownText(text)).toBe("Dziękuję!\n\n");
  });

  it("finds a quote under a line ending in a colon, and none in a text without one", () => {
    // Before, any run of `>` lines that ended the text was the quote (`"a\n> b"` folded at 2);
    // the core reads one with nothing of the app's above it as the person's own (ADR 0142).
    expect(quoteStart("a\n> b")).toBeNull();
    expect(quoteStart("Anna said:\n> b")).toBe(0);
    expect(quoteStart("a\n> quoted in the middle\nb")).toBeNull();
    expect(quoteStart("plain text")).toBeNull();
  });

  it("the reviewer's case: the person's own blockquote is theirs, and never folds away", () => {
    const text = "As agreed:\n\n> Paid by [date].";
    expect(quoteStart(text)).toBeNull();
    expect(sectionStarts(text).quote).toBeNull();
    expect(ownText(text)).toBe(text);
    expect(foldedAt(text)).toBeNull();
    // Under the signature, with the app's quote below: only the app's quote folds.
    const reply = `${text}\n\n-- \nMe\n\nOn 3 Nov 2026, 10:29, Anna wrote:\n> When?`;
    const at = `${text}\n\n-- \nMe\n\n`.length;
    expect(quoteStart(reply)).toBe(at);
    expect(foldedAt(reply)).toBe(at);
    // Opened, the fold's line stands where the quote starts.
    const state = EditorState.create({ doc: reply, extensions: liveMarkdown() });
    const open = state.update({ effects: toggleQuote.of(false) }).state;
    const starts: number[] = [];
    for (const source of open.facet(EditorView.decorations)) {
      if (typeof source !== "function")
        (source as DecorationSet).between(0, reply.length, (f) => {
          starts.push(f);
        });
    }
    expect(starts).toEqual([at]);
  });

  it("a fence the person left open does not make the signature theirs (ADR 0142, rule 4)", () => {
    const doc = "Example:\n\n```\nls\n\n-- \n```\nJane\n```";
    expect(signatureStart(doc)).toBe("Example:\n\n```\nls\n\n".length);
    expect(ownText(doc)).toBe("Example:\n\n```\nls\n\n");
  });

  it("treats an empty reply above a quote as empty", () => {
    const text = "\n\nAnna napisała:\n> x";
    expect(ownText(text).trim()).toBe("");
  });
});

describe("lineRanges", () => {
  const classes = (text: string) =>
    lineRanges(text, 0).map((r) => [
      text.slice(r.from, r.to),
      (r.deco.spec as { class: string }).class,
    ]);

  it("fades the syntax and marks the text it formats", () => {
    expect(classes("a **b** c")).toEqual([
      ["**", "cm-md-syntax"],
      ["b", "cm-md-bold"],
      ["**", "cm-md-syntax"],
    ]);
    expect(classes("- item")).toEqual([["-", "cm-md-syntax"]]);
  });

  it("marks placeholders but not links, boxes or bracketed addresses", () => {
    expect(classes("Cena [kwota]")).toEqual([["[kwota]", "cm-md-gap"]]);
    expect(classes("[x](http://a.pl)").map(([, c]) => c)).not.toContain("cm-md-gap");
    expect(classes("- [ ] todo").map(([, c]) => c)).not.toContain("cm-md-gap");
    expect(classes("See [https://a.pl/x]")).toEqual([]);
  });

  it("does not take a bullet's star for italics", () => {
    expect(classes("* one").map(([, c]) => c)).toEqual(["cm-md-syntax"]);
  });
});

describe("acceptSuggestion", () => {
  /** Just what the function uses of a view: its state, and a dispatch that moves it on. */
  function viewOf(doc: string) {
    let state = EditorState.create({ doc, extensions: [suggestionsField] });
    return {
      get state() {
        return state;
      },
      dispatch(spec: TransactionSpec) {
        state = (state.update(spec) as Transaction).state;
      },
    };
  }

  it("fills the gap in the person's lines and leaves the signature and the quote as they are", () => {
    const view = viewOf(
      "Meet on [date], then [date].\n\n-- \nAway until [date]\n\nAnna wrote:\n> On [date]?",
    );
    const done = acceptSuggestion(view as unknown as EditorView, {
      token: "[date]",
      value: "Friday",
      source: "thread",
    });
    expect(done).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "Meet on Friday, then Friday.\n\n-- \nAway until [date]\n\nAnna wrote:\n> On [date]?",
    );
  });

  it("fills a gap in the person's own blockquote above the signature, as the core splits it", () => {
    const mine = "As agreed:\n\n> Paid by [date].\n\nSee you [date].";
    const doc = `${mine}\n\n-- \nAway until [date]\n\nOn 3 Nov, Anna wrote:\n> On [date]?`;
    // The signature starts at its delimiter, not inside the person's blockquote.
    expect(signatureStart(doc)).toBe(`${mine}\n\n`.length);
    expect(ownText(doc)).toBe(`${mine}\n\n`);
    const view = viewOf(doc);
    expect(
      acceptSuggestion(view as unknown as EditorView, {
        token: "[date]",
        value: "Friday",
        source: "thread",
      }),
    ).toBe(true);
    expect(view.state.doc.toString()).toBe(doc.replace(mine, mine.replaceAll("[date]", "Friday")));
    // A `-- ` line inside a fenced code block is not the delimiter.
    expect(signatureStart("```\n-- \n> x\n```\n\n-- \nMe")).toBe("```\n-- \n> x\n```\n\n".length);
  });

  it("changes nothing when the gap is only in the signature", () => {
    const view = viewOf("Hello\n\n-- \nAway until [date]");
    expect(
      acceptSuggestion(view as unknown as EditorView, {
        token: "[date]",
        value: "x",
        source: "thread",
      }),
    ).toBe(false);
    expect(view.state.doc.toString()).toBe("Hello\n\n-- \nAway until [date]");
  });
});

describe("the editor reads a draft as the core does (ADR 0142, rule 4)", () => {
  const plain = fc.constantFrom("Hi", "[date]", "> cited", "As it says:", "", "Anna napisała:");
  const inside = fc.constantFrom("ls", "-- ", "--", "", "> x", "~~~");
  const closed = fc
    .tuple(fc.constantFrom("```", "~~~"), fc.array(inside, { maxLength: 3 }))
    .map(([open, body]) => [open, ...body.filter((l) => !l.startsWith(open[0] as string)), open]);
  const own = fc
    .tuple(
      fc.array(
        fc.oneof(
          plain.map((l) => [l]),
          closed,
        ),
        { maxLength: 6 },
      ),
      fc.constantFrom([], ["```"], ["```", "ls"]),
    )
    .map(([parts, tail]) => [...parts.flat(), ...tail].join("\n").trimEnd());
  const signature = fc.constantFrom("", "Me", "```\nJane\n```");
  const quote = fc.constantFrom(
    "",
    "On 3 Nov 2026, 10:29, Anna wrote:\n> When?\n",
    `${FORWARD_MARK}\n> From: Anna\n>\n> Hello\n`,
  );

  it("folds, styles and fills where the core splits, for any draft", () => {
    fc.assert(
      fc.property(own, signature, quote, (mine, sig, q) => {
        const text = joinSections(mine, signatureBlock(sig), q);
        const at = sectionStarts(text);
        const parts = draftSections(text);
        expect(quoteStart(text)).toBe(at.quote);
        expect(signatureStart(text)).toBe(at.signature);
        expect(foldedAt(text)).toBe(at.quote);
        const end = at.signature ?? at.quote;
        expect(ownText(text)).toBe(end === null ? text : `${parts.own}\n`);
      }),
      { numRuns: 1000 },
    );
  });
});
