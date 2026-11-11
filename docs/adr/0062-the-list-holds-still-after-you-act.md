# 0062. The list holds still after you act

- Status: Accepted
- Date: 2026-11-06

## Context

The owner closed a thing in `Now` and the rows under it changed places. Each list is worked out from the
facts, and closing a thing changes the facts: a bundle of two stops being a bundle (ADR 0059), so the other
thread loses its place, and what the blocking turn said no longer applies to the threads that are left.
The same facts must keep giving the same list, so the ranking is right to change. What is wrong is doing that
under someone who is working down the list.

## Decision

1. **From the first action, the order is held.** Closing, `Not important`, `Later`, sending, or a move out of
   the list takes down the order on screen. Lists that come after keep the rows that were there in that order,
   on their side of the heading.
2. **New things still show.** A new row goes after the row that the ranking puts before it, above the heading
   if it is for now. Lists before the first action go by the ranking as they did, so a reading can still bring
   better rows above.
3. **Undo puts a row back where it was.** The held order remembers the rows that left.
4. **Leaving lets go.** Moving to another view ends the hold, and the list is in ranked order on the way back.
   A search shows ranked results and leaves the hold as it was.
5. **It lives in the renderer.** This is about what one person is looking at, like the scroll position and the
   rest staying open (ADR 0058). The backend and the ranking do not change.

## Consequences

- While on hold, a row can sit above one that now outranks it, and a thing can stay in `Now` after losing
  the reason it was there. `why` on the row is current, so it may not explain the place. It lasts until the
  person leaves the view.
- The hold is not saved: a new start of the app begins in ranked order.
- A bundle's rows can come apart under a hold, and its rail is drawn only between neighbours.
