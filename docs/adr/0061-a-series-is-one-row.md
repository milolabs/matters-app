# 0061. A series is one row

- Status: Accepted
- Date: 2026-11-06
- Amends: [0059](0059-bundles-and-a-map-of-what-depends-on-what.md) (a bundle stays ordinary rows)
- Amended by: [0065](0065-a-closing-covers-only-its-own-ask.md) (a closing covers only its own ask, and says how many)

## Context

An accounting office sends the same reminder on many days of each month, each in a thread of its own.
Every one is read alone and every one is an open ask, so one month was nine nearly identical rows at the
top of Matters. ADR 0059 did find that they were one matter, and said so on the first row, but keeps a
bundle as ordinary rows. It is not only this sender: on the owner's mailbox ten senders did this, and
folding them takes the list from 64 rows to 45.

Hiding automated mail is not the answer. A failed payment or a renewal notice is automated too, and the
reminder itself is useful once.

## Decision

1. **What a series is.** Threads with the same account, the same other person and the same name of the
   matter (ADR 0058, rule 6), compared as `foldText` does, in none of which the person wrote. A thread the
   person wrote in is a conversation and stays a row of its own. All of this is code.
2. **One row, the newest.** The newest thread stands for the series, so its words, its date and its draft
   are what shows. It weighs what the heaviest weighs and not their sum, because asking again adds no new
   work. It is for now if any of them is. The older threads leave the list, the count and the bundles, so
   they get no draft ahead and are on no card of the turn about what blocks what.
3. **The newest decides.** A thread older than one of its series that the person closed, called not
   important, set aside or wrote in is covered by that. Nothing is written per thread: one feedback, one
   journal line and one Undo, which brings them all back. A reminder that comes after opens the series
   again, and counts only from there.
4. **Nothing is out of reach.** The row says `9 mails, newest 16 Sept`. The reader lists every mail of the
   series with the map of ADR 0059, and choosing one shows it under `The whole thread`. Replying and closing
   stay with the newest. A search finds the row by the words of any of its mails.

## Consequences

- A bundle made of different people keeps its rows and its order of work; only repeats fold.
- The name of a matter is the model's, so two different asks under one name from one sender would fold. The
  reader still shows both, but closing the newest covers the older one, and that Undo is the way back.
- Each reminder is still read once, on the person's plan. Reading only the newest is later work.
- A series keeps the lateness of its newest mail, even when the matter has long been over: an office that
  stopped reminding is not yet understood here. That is later work too.
- The list read gains a look at the threads that share a name with something listed: a few reads, not one
  per analysis.
