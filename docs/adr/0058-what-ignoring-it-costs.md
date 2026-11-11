# 0058. What ignoring it costs, what is for now, and learning from no

- Status: Accepted
- Date: 2026-11-05
- Amended by: [0066](0066-what-you-would-regret-not-seeing.md) (closing is not complaining, and what may be stale goes after the rest)

## Context

A reading says whether something is open, not whether it matters: any quoted ask is a thing, and since
ADR 0055 all of them show. ADR 0057 improved the order with what the store knows, but a real deadline
and a polite question could still look alike. The owner accepted reading the mail once more for this.

## Decision

1. **The reading says what ignoring it costs.** `consequence` is `none`, `minor` or `real`. `real` must
   quote a passage, and code checks the passage as it checks every fact: without one it is `minor`. It
   moves a thing by +15 or -10, with a sentence in `why`. `ANALYZER_VERSION` goes to 2, so every thread
   in the window is read again; feedback and drafts are kept.
2. **Now and the rest.** Nothing is hidden (ADR 0055); the list has two parts, and the rest starts
   closed. A thing is for now, decided by code, when it is late, due within 3 days, has a real cost, or
   rests on the person's own promise that the reading did not call costless. Written back since (ADR
   0057) takes it out of now unless it is late. A list with only one part, and a search, have no
   sections. Rows of the rest on screen do not close when a thing for now comes: the rest counts as
   open from then on, until the person closes it.
3. **The thread says how deep it is.** The prompt gets one counted line: messages, how many are the
   person's, other people, days. The model does not have to count, and it is told depth alone is not a
   consequence.
4. **Saying no adds up to an offer.** Closing still offers a rule for the sender. `Not important` offers
   one from the second time for that sender. Three of either from a domain, by more than one sender,
   offers the whole domain, except for shared mail domains. It stays an offer: one click, never by
   itself.
5. **Writing to someone counts for them.** Five sent messages or more add 8 points, with a sentence in
   `why`. This is the other side of the penalty of ADR 0057.
6. **The matter of a thread is recorded now, used later.** The reading also gives `case`, a short name,
   and `anchors`, identifiers found word for word in the thread. Nothing uses them yet. They are asked
   for now so that bundling threads, which is still being decided, needs no second reading.

## Consequences

- Things empty out and come back while the window is read again, as on a first reading.
- `listWrittenTo` now counts, and `agent_analyses` gains three columns.
- `case` is model text: it is shown as text only, and it is not evidence of anything.
- Tier rules and weights are a judgment and have not been tuned on real mail.
