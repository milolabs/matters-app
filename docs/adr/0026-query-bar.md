# 0026. One query bar, with the text as the only state

- Status: Accepted
- Date: 2026-11-04
- Builds on: [0025](0025-query-language-and-plans.md)

## Context

The language of ADR 0025 is invisible in a plain input: nothing shows what was
understood, a mistyped field is silently searched as text, and a bad date is
silently dropped. Mail clients usually answer with a second, form-based filter
panel, which then has to stay in sync with the text and hides the language from
the people who would benefit from learning it.

Search runs on every keystroke within 16 ms (ADR 0012), so the bar must not add
work that competes with the results.

## Decision

- **The query text is the only state.** There is no separate filter model and no
  "advanced" mode. Quick filters and suggestions only edit the text, so using them
  shows the syntax.
- **Highlighting is a layer under a real input.** The input stays native with
  transparent text and a visible caret, and a mirror behind it paints the tokens.
  IME, undo, selection and accessibility stay the browser's. Styles on tokens may
  change only colour, fill and underline: anything that changes a glyph's width
  makes the caret drift.
- **The renderer parses synchronously** with the core parser, on the keystroke, to
  paint in the same frame. The backend still parses for itself (ADR 0025).
- **Nothing blocks.** An invalid term is underlined and explained in one line, and
  the rest of the query keeps running.
- **Suggestions read one registry** of fields and values in core, shared with the
  parser, so a new field needs no UI change. They never run a query.
- **Labels for suggestions come from a loose index scan,** fetched when suggestions
  open, never on a keystroke.
- **A quick filter is on only when its token is a top-level term of an AND.** Adding
  one to a query whose root is an OR first wraps it in brackets, because `a OR b c`
  means `a OR (b AND c)`.

Not in this ADR: saved views, people in suggestions.

## Consequences

- The field grows to fill the toolbar, taking the empty space beside the title.
- Text and mirror must share every font metric. A change of the input's font has to
  change both.
- A token's meaning stays visible in one place, which makes the later saved views
  plain text as well.
