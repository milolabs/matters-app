# 0055. Every thing that matters shows

- Status: Accepted
- Date: 2026-11-05
- Amends: 0052

## Context

ADR 0052, rule 6 showed at most 7 things. In use that reads as a broken queue: when a thing is closed,
another one that was there all along drops into its place, and the person cannot see how much is
really open or go through it in their own order. Every other list in the app shows all it has and
pages in as it scrolls.

The 7 also did a second job: drafts were prepared for what shows, so it bounded what drafting ahead
costs on the person's plan. Showing everything must not let that cost grow with the list.

## Decision

1. **All of them show**, in the order `rankThings` gives, in a virtualized list of the same 68 px rows.
   The tab counts all of them, loaded or not.
2. **They page in by a growing limit.** The window asks for the best 50, and for 50 more as the list
   nears the end of what is loaded; each answer also says how many there are in all. Every refresh asks
   for the whole limit again, not for the next slice. The ranking moves while a reading runs, and an
   offset over a moving order would repeat or skip rows.
3. **Only the best 7 are drafted ahead** (`DRAFTED_AHEAD`), best first, as before. When one is closed,
   the next one in the order gets its draft. Any other row says `Needs you` and has `Prepare now`, and
   the reader says `Not prepared yet.` rather than that the agent is preparing it.
4. **What the person is looking at stays.** A row that arrives or leaves above the viewport does not
   move the rows on screen.

## Consequences

- The person sees everything that is open; closing a thing no longer brings in something new.
- A row outside the best 7 has no draft waiting until it rises or the person asks for one.
- The list is ranked in memory, so a read still looks at every analysis in the window, however small
  the limit. That cost was already there. Only the rows returned read what was prepared for them. If
  it becomes visible at the scale budgets, the ranking needs its own read, not a smaller limit.
- The open thing can leave what is loaded if new rows push it past the limit while it is the last one;
  the top one then opens, as when a thing is dealt with.
