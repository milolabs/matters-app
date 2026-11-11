# 0029. The query bar is a full-width strip, and writes fields instead of quick filters

- Status: Accepted
- Date: 2026-11-04
- Amends: [0026](0026-query-bar.md), [0027](0027-saved-views.md), [0028](0028-people-suggestions.md)

## Context

The bar shared the toolbar with the title and stopped at 680 px, so it read as one more
tool rather than as the main way to filter mail. Under it the list had two more rows:
view tabs and four quick filters.
The quick filters (`Unread`, `Starred`, `Attachment`, `Last 7 days`) did the job of
views, with fewer abilities, and showed only a small part of the language. The toolbar
title repeated the name of the selected tab.

## Decision

- **The tabs move into the toolbar** and replace the title. The name stays for assistive
  technology as a hidden heading; the changed mark moves onto the tab.
- **The bar becomes a strip of its own across the whole window,** under the toolbar and
  fluid with it. The field takes the free width, so a long query has all the room there is.
  The message count moves to the end of the strip, since it counts what the query found.
- **Quick filters are gone.** Three starter views take their place: `Unread`, `Starred`,
  `Attachments`. `Last 7 days` does not become one; `after:` offers it as a date.
- **Starter views are ordinary rows, written by a migration.** A migration runs once, so a
  view the user deleted does not come back, and they can be renamed, moved and changed
  like any other. An existing view with the same name (ignoring case) keeps its place,
  and the 50-view limit holds.
- **Field handlers replace them, in the strip after the field.** One small button per field of the
  registry, written as it is typed (`from:`, `is:`), set in monospace so that it reads as
  the language. A click makes the same edit as choosing the field in the panel: it writes
  `field:` at the end of the text, undoably, and the panel offers the values. There is no
  second picker and no filter state, so ADR 0026 holds: the text is the only state.
- **A handler is marked when its field is in the query.** It is only a reading of the
  parse, and a click always adds another term. A field at the end still waiting for its
  value gives way to the next click, so that empty fields do not pile up.
- `account:` is shown only with more than one account.
- **The text comes first.** The field is a textarea over the same mirror, because a single
  line cannot show a long query or let it be edited by clicking. When the text no longer
  fits beside the handlers, it takes the whole line. Focused, it wraps in full, growing over
  what is below, with the handlers on a line of their own under it. At rest it shows what fits
  in one line and hides the handlers. The query is still one line of text: a pasted line
  break becomes a space. Whether it fits is measured on a canvas, which reads no layout on
  the keystroke.
- **A person field with nothing typed offers the most frequent people,** amending ADR 0028.
  `frequent` walks `people_rank` with the same check against the index. The panel asks once,
  when it opens on an empty value; it never runs per keystroke.

## Consequences

- Space above the list shrinks: one 40 px strip in place of two rows.
- The reader loses those 40 px too, which it did not give up before.
- In a narrow window the field keeps at least 200 px and the handlers scroll, with a fade.
- Text and mirror must now also share every wrapping metric.
- Down leaves the bar only from the end of a wrapped query; above that it moves the caret.
- Existing databases gain the starter views on upgrade, after the views already there.
