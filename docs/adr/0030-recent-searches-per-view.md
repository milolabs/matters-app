# 0030. Recent searches are remembered per view

- Status: Accepted
- Date: 2026-11-04
- Builds on: [0027](0027-saved-views.md), [0029](0029-query-bar-full-width.md)

## Context

People repeat searches, and the searches they repeat differ between views. Typed text is lost
as soon as another tab is chosen. Restoring it when the tab comes back would make the tab show
something other than what it stands for: `All mail` would no longer be all mail, and returning
to a clean view would take an extra step.

## Decision

- **A tab always opens on its saved text.** Recent searches are offered, never restored.
- **Each view keeps its 10 latest searches,** in `view_searches`, across restarts. `All mail`
  has them too, under its built-in id, so the table has no foreign key. They go with a deleted
  view.
- **Leaving the bar is what makes text a search.** It is kept when it differs from the view's
  text, has at least 2 characters and no half-typed or invalid term. Nothing is written per
  keystroke, and writes go through the sync worker (ADR 0019).
- **The panel offers 5 of them while the bar holds the view's own text,** above the other
  suggestions, and they step aside once something is typed. Choosing one replaces the whole text.
- **Any one can be removed,** with `x` or the Delete key, and **all of a view's can be
  cleared** from the last row of the group, including those the panel does not show. It is a
  row rather than a button in the heading so that the keyboard reaches it, and it asks once, in
  place, because it cannot be taken back. Clearing covers the active view only, matching what
  the panel shows.

## Consequences

- Search text is now stored on disk, unencrypted like the mail index. A "forget this account"
  guarantee has to include this table. There is no control yet that clears every view at once.
- A query typed through and abandoned is kept if it is valid: there is no sure sign of intent.
- History does not sync between devices, as views do not (ADR 0027).
