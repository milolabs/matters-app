# 0053. Reading that shows itself

- Status: Superseded by [0117](0117-matters-is-a-view-with-a-prompt.md)
- Date: 2026-11-05
- Amends: [0052](0052-things-that-matter.md) (order of reading, what an empty list says)

## Context

The owner turned AI on and landed on an empty Matters tab with no idea what was happening. While reading,
the app said so in three small places. When reading had stopped, the list said only "Nothing here.".

Reading was also too slow to give anything early. One turn took about 5.5 s and threads went one at a
time, newest first, so 200 threads would take about 20 minutes, and the newest thread is not likely to
be the one that matters.

## Decision

1. **Likeliest first.** Candidates are ordered locally, with no model: first threads where a person
   other than the owner wrote last, then threads where the owner wrote last and nobody has answered,
   then the rest. Within each group, newest first. The same thread set is read; only the order changes.
2. **Several turns at once.** Up to 3 turns run together. The budget is checked before each turn starts,
   so a stop may leave up to 2 turns finishing. A turn that is running is not abandoned because
   another one hit the budget, and its result is kept.
3. **Lower effort for understanding.** `AgentRunRequest` carries an optional effort. Analysis asks for
   `low`, and what the person asks for directly uses the runtime's default.
4. **The reader says what is happening.** Until a thing is open, the reading column shows the state, in
   full sentences, with what can be done about it:

   | State | Says | Actions |
   |---|---|---|
   | Checking the runtime | Checking Claude Code | |
   | Reading | How many read, how many found, time left, plan left | Pause, Open All mail |
   | Paused by the person | Paused, and how far it got | Continue, Open All mail |
   | Paused by the plan | Until when, and which limit | Open Settings |
   | Signed out or missing | What to run | Copy, Look again |
   | Test failed | The reason | Try again |
   | Nothing in the window | Nothing to read in the window | Read further back |
   | Finished, nothing found | How many read; nothing needs you | |

   "Nothing here." is never shown in Matters.
5. **Time left is measured.** It comes from the turns of this reading, once at least 3 have finished.
   Before that the screen says "Estimating". It never comes from a constant.
6. **The first thing opens by itself.** While the person has opened nothing, the first thing found
   opens as it arrives. Once they have chosen something, the list only grows.
7. **The tab shows progress.** While reading, the tab reads `Matters 12/214`, so that the person can go
   to All mail and still see it moving.
8. **Pausing is the person's and it lasts.** It survives a restart. A sync does not resume it.
9. **A model's own doubt is a weak filter.** The threshold of ADR 0052 rule 6 is 0.5, not 0.7. On a plain
   thread where the person owes an answer, five real turns rated themselves 0.5 to 0.7, so at 0.7 nearly
   nothing would show and a list could stay empty. Quotes and their authors are checked by code either way.
   Analyses already stored are ranked again without being read again.

## Consequences

- Up to 3 `claude` processes run at once during a reading. The worker must stay responsive; the budgets
  of ADR 0012 still hold.
- The plan's limit is used up faster per minute, not per thread. Measured on one made-up thread with
  Claude Code and Haiku: `low` took 4.5 s and 820 output tokens against 5.9 s and 1049 by default, with the
  same facts; three turns together took 7.2 s. Whether 3 is the right number, and whether `low` keeps
  quality on real mail, are to be checked on real use.
- A window showing threads out of date order is deliberate, because the list is ordered by rank.
