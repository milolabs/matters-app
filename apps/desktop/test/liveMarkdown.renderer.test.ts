// The reply editor's live Markdown (ADR 0100): where the quote starts, and how a line is marked.
import { EditorState, type Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  acceptSuggestion,
  lineRanges,
  ownText,
  quoteStart,
  suggestionsField,
} from "../src/renderer/liveMarkdown.ts";

describe("quoteStart", () => {
  it("starts at the attribution line above the quoted lines", () => {
    const text = "Dziękuję!\n\nOn 3 Nov 2026, 10:29, Anna wrote:\n> Cena?\n>\n> Pozdrawiam\n";
    expect(quoteStart(text)).toBe("Dziękuję!\n\n".length);
    expect(ownText(text)).toBe("Dziękuję!\n\n");
  });

  it("finds a quote without an attribution line, and none in a text without one", () => {
    expect(quoteStart("a\n> b")).toBe(2);
    expect(quoteStart("a\n> quoted in the middle\nb")).toBeNull();
    expect(quoteStart("plain text")).toBeNull();
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
