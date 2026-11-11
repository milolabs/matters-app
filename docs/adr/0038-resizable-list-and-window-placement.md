# 0038. The list's width is the reader's choice, and the window opens where it was left

- Status: Accepted
- Date: 2026-11-04

## Context

The list was fixed at 380 px and the reading pane took the rest. Long subjects and senders were
cut off however wide the window was, and a narrow window gave the pane only 340 px with no way to
trade. The window itself opened at 1200×760 on every launch.

## Decision

- **The reader chooses the list's width, and the pane takes the rest.** The range is 280 to 560 px
  with a default of 380, as in the Swift prototype's range. The pane never goes below 340 px, which
  together with the default is the window's existing 720 px minimum.
- **The width is in pixels, not a share of the window.** A list row reads the same in any window,
  so all growth goes to the pane.
- **The window never overwrites the choice.** In a window too narrow for it the list gives way,
  and it comes back when the window widens. Only a gesture on the line changes the choice.
- **The line between them is the list's border, with a 9 px invisible grip over it.** It darkens
  after 120 ms of hover, so it does not flash when the pointer only passes. At the end of its range
  the cursor points the only way the line can still go, and within 6 px of the default a drag lands
  on the default.
- **Double-click and Enter return to the default, at once.** Animating the width would make the
  pane lay out for every frame of something that should simply be done.
- **The keyboard can do all of it.** The line is a focusable `separator` with its value: arrows
  move it by 8 px, Shift by 40, Home and End go to the ends. It takes those keys before the window's
  own, and a click on it leaves the focus on the list, so `j` and `k` keep working.
- **The width lives in `localStorage`, a preference of this computer,** read before the first paint
  and written when a gesture ends. Anything unreadable means the default.
- **A drag changes one inline width through one signal.** The window's width comes from
  `innerWidth`, which reads no layout. Rows have fixed heights (ADR 0010), so neither `layoutList`
  nor the virtualizer has any work to do. The browser already delivers pointer moves once a frame.
- **The mail frame waits for the end of a drag.** Fitting a message lays it out twice and measures
  every link, which is too much for each frame. While a drag lasts the frame keeps its zoom, height
  and link positions, and it is fitted once on release. Resizing the window still fits it as before.
- **Pointer capture keeps the gesture** when the pointer passes over a message's frame, which would
  otherwise take the events.
- **The mail window opens where it was left,** including whether it was maximized. A place that can
  no longer be reached, because a screen is gone or smaller, is dropped: the window keeps its size,
  as far as it fits, and the system places it. The place is saved in `window.json` under the user
  data directory when the window closes. Smoke runs ignore it and always measure the default window.
- **A letter's header holds at any width the pane can have.** Without room, the Original/Text
  switch drops to a line of its own, and the sender's name truncates before the date is covered.
- **The reading column stays at 760 px.** Text beyond that gets harder to read, so a wide window
  gives margins, not longer lines.
- **The list cannot be hidden yet.** That is a further state with a visible way back to design, and
  can come separately if the need shows.

## Consequences

- While a drag narrows the pane, an HTML message can be cropped or show a scrollbar of its own until
  release, and its link overlays are out of place. Nothing can be clicked during a drag.
- `MATTERS_SMOKE=1` now drags the line over a large HTML message and fails if the median frame
  reaches 20 ms, or if a gesture leaves the wrong width behind. Its pointer events are synthetic, so
  pointer capture over a real frame and the cursors are not covered by it.
- A crash loses the window's latest place, since it is saved on close only.
- Wide newsletters still shrink to the 760 px column.
