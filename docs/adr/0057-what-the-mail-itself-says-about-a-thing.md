# 0057. What the mail itself says about a thing

- Status: Accepted
- Date: 2026-11-05
- Amended by: [0066](0066-what-you-would-regret-not-seeing.md) (relation by company, and relation older than two years counts for nothing)

## Context

Since ADR 0055 every thing shows, so the order is what decides whether a list of hundreds is usable.
The ranking of ADR 0052 knew only what a reading said. An ask from 28 days ago with no date scored
the same as one from yesterday, a stranger's question scored the same as a colleague's, and a thread
the person had already written back on relied on the model noticing that. The local store knows all
of this, without spending anything on the person's plan.

## Decision

1. **Local facts, read at read time.** They change the order and never the stored reading, so
   `ANALYZER_VERSION` stays and nothing is sent to a model again.
2. **Age.** A thing with no date loses 1 point per day after its first 7, at most 15. A date is not
   aged: lateness already speaks for it.
3. **Grace for waiting.** A `waiting` thing with no date does not show until 3 days after the fact it
   rests on. Someone who has not answered since yesterday is not a thing yet.
4. **Who it is from.** An `onYou` thing from someone the person has never written to loses 15 points.
   It lowers and does not hide, because a new customer is a stranger too. With no Sent mail at all this
   is not known, and nothing is taken off.
5. **Only in Cc.** An `onYou` thing loses 10 when the message it comes from has the person in Cc and
   not in To.
6. **Written back since.** An `onYou` thing that rests only on asks, all older than the person's newest
   message in the thread, loses 20. A promise of theirs does not: writing back does not keep one.
7. **Said out loud.** Each of these adds its own sentence to `why`, as every weight does, so the order
   stays explainable from the facts. The same facts still give the same list.

## Consequences

- `MessageStorePort` gains `listWrittenTo`, with a partial index over Sent mail so that the cost follows
  what was sent. The router caches the answer for a minute, because the list is read on every push and
  keystroke; a new reply can take that long to count.
- A `waiting` thing can appear by itself when its grace ends, on the next read of the list.
- The weights are a judgment, as in ADR 0052, and none has been tuned on real mail yet.
