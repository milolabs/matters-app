# 0049. The reading column fills the pane

- Status: Accepted
- Date: 2026-11-05
- Amends: [0038](0038-resizable-list-and-window-placement.md)

## Context

ADR 0038 kept the reading column at 760 px, so a wide window gave margins rather than longer lines.
That left unused space on both sides of a message on a large screen, and wide newsletters shrank to
the column even when the window had room to show them at full size.

## Decision

- **The column takes the pane's whole width,** less its 32 px of padding on each side. It has no
  maximum, and it is no longer centered, since there is no margin left to center it in.
- **This covers the thread's header and its messages.** The composer has its own layout, which
  already filled the pane.
- **The reader controls the line length** with the window and the list's edge. Nothing else limits
  it.

## Consequences

- Wide newsletters show at full size as soon as the pane has room for them.
- Plain-text mail and our own text in wide windows run to long lines, which are harder to read than
  the 760 px column was.
- Narrow HTML layouts, such as a 600 px newsletter, keep their own width and alignment, so they can
  sit to one side of a wide pane on a white background.
- A drag of the list's edge now reflows the message at every list width, not only when the pane is
  under 760 px. The frame still waits for the end of the drag to fit (ADR 0038), and
  `MATTERS_SMOKE=1` now drags over the list's whole range.
- Resizing the window now fits the message at every window width, where a pane wider than the column
  used to cost nothing. No smoke run measures a window resize, so this is the cost to watch on large
  messages.
