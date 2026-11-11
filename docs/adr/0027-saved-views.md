# 0027. Saved views are named query text

- Status: Accepted
- Date: 2026-11-04
- Builds on: [0025](0025-query-language-and-plans.md), [0026](0026-query-bar.md)

## Context

People return to the same searches. The query bar (ADR 0026) already holds all filter
state as text, so a saved filter needs no model of its own. The Swift prototype's
sender categories are one case of this: `from:(northwind OR hale)`.

"Filter" in a mail client usually means a rule that moves mail, and that word should
stay free for rules later. Search must stay within 16 ms per keystroke (ADR 0012), and
the backend router has one thread, so anything that keeps a badge current must not
stand in front of a keystroke.

## Decision

- **A view is a name and query text,** in `saved_views`. The text is stored rather than
  a tree: the grammar can change, `after:-7d` is computed on each run, and a view can be
  copied as text. The UI calls them views.
- **A view spans all accounts** unless its query says otherwise, so it outlives a removed
  account. `All mail` is built in, is not stored, and cannot be changed.
- **Editing the query never changes a view.** The view is marked changed, with Save, Save
  as new and Revert. `⌘S` saves, or asks for a name when the active view is `All mail`.
  `Esc` returns to the saved text before it does anything else.
- **Views are tabs above the list,** not a sidebar: the canvas has none, and the reader
  keeps its width. Keys `1` to `9` switch tabs from the list. Rename, move and delete are
  in the tab's context menu.
- **Names are unique** ignoring case, 1 to 40 characters. There are at most 50 views.
- **Writes go through the sync worker,** as drafts do (ADR 0019).
- **The app opens on `All mail`.** Restoring a view would put a query in front of the
  launch budget.
- **Results keep their day headings in a view.** A view is a place, not a search.

**Unread badges stay off the keystroke path.** A badge counts the view's query AND
`is:unread`, capped at 99. The renderer asks one chunk at a time, one view at a time,
with a gap between requests. It stops when the user types or when the views change, and
starts again after a quiet moment following a `changes` event. A count never hydrates
messages.

**Counts run in the sync worker,** not on the router. One request for a heavy query took
25-94 ms on 500k messages, and on the router that would stand in front of a keystroke
however long the gaps between requests are.

Not in this ADR: syncing views between devices, rules, `view:` references, restoring the
last view, drag to reorder.

## Consequences

- Views depend only on the language, so rules and notifications can reuse the text.
- A view whose query names an account that no longer exists shows the usual diagnostic
  rather than breaking.
- A badge can lag behind the list by a moment.
- A view with a heavy query keeps its badge cost, in small steps. Its first search still
  runs with the costs listed in ADR 0025.
- View saves, sends and sync batches queue behind a count in the worker, for up to one
  request. That delay has not been measured. While the worker is down, badges disappear
  rather than wait.
