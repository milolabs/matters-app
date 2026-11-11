# 0065. A closing covers only its own ask

- Status: Superseded by [0117](0117-matters-is-a-view-with-a-prompt.md)
- Date: 2026-11-06
- Amends: [0061](0061-a-series-is-one-row.md) (what a series is, and what the newest decides)

## Context

ADR 0061 lets one closing cover the older threads of its series, keyed only by the sender and the
model's name of the matter. On the owner's mailbox on 2026-11-06, 36 open threads had no feedback of
their own and 35 of those were covered, each by one earlier click; 33 of the 36 have money or a contract
at stake. Most were rightly folded reminders, but three things were wrong:

- `collapseSeries` skipped threads the person wrote in, as rule 1 says, and `coveredBySeriesEnd` did not.
  Closing one row silently removed another row that had never folded into it. Three such threads were
  hidden.
- One name held different obligations. The model called Orange invoices 005, 006, 007 and 008 all
  `Faktura Orange 11.2026`, so closing one covered unpaid older ones.
- Nothing said any of this had happened. The line read `Closed, no reply needed`.

Anchors (ADR 0058), copied from the thread, can tell the repeats apart. Over all 254 pairs of threads
with one sender and one name on that mailbox:

- 73 pairs have a thread without anchors, 28 of them with none on either side. The monthly accounting
  reminders are among them: three of one month's reminders have no anchors at all, with the same subject
  and the same ask as those that do. So do the Netflix and Orlen repeats. Treating missing anchors as a
  difference would break up exactly what ADR 0061 folds.
- Sharing no anchor is not enough on its own. Orange's invoices 005 and 007 from one address also share
  the customer's number and bank account, so they share anchors and still are different debts.
- Equal text is too strict. `mtu24.pl` and `MTU24`, or `Autohero` and `Autohero Polska`, are one name in
  two forms, and a survey with no stakes came back as a row of its own when compared as equal text.

## Decision

1. **A conversation is never covered.** `coveredBySeriesEnd` skips a thread the person wrote in, as
   `collapseSeries` does. That thread can still end a series for the reminders older than it.
2. **Two threads under one name are repeats unless their anchors say otherwise** (`repeatsOneAsk`). All of
   this is code, on anchors folded as `foldText` does, ignoring those under four characters as bundles do:
   - If either thread has no anchors, they can be repeats. Missing anchors prove nothing.
   - If both have a numbered anchor of the same pattern, each digit counted, and no value in common, they
     are different obligations, whatever else they share.
   - Otherwise they are repeats only if they share an anchor, whole words of one inside the other.
3. **One row per ask.** Going from the newest, a thread joins the newest row of its series that it can
   repeat, or starts a row of its own. A closing covers what is older in the series, the same ask as it
   and not written in.
4. **A closing says what it took along.** The backend counts the threads this feedback newly hides, before
   writing it, so the count is what happened and not what the row showed. The tray says
   `Closed, no reply needed · also 8 older mails`, for closing, not important, later, a group, and the
   agent's closing from the person's words. The journal keeps the number on the line (`also_covers`, schema
   32) and shows `Closed by you · also 8 older mails`, including after Undo, since it says what was done.

## Consequences

- On the owner's mailbox the covered threads go from 35 to 29, and the list from 0 rows to 5: the three
  conversations, Orange's invoice 005 as one row of two threads, and invoice 006. Every accounting reminder
  stays folded.
- A thread without anchors folds into the newest row, and any newer closing in its series covers it, even
  the closing of a different row. It stays a judgment on missing evidence, and the count says so when it
  happens.
- A different amount or date of the same pattern also separates two threads, so a reminder that adds a fee
  and names the amount gets a row of its own. That errs towards showing more: an extra row is one click,
  a hidden debt is not. None appeared on the mailbox but the invoices and two parcels.
- Rewordings can still split one ask: of the 36 pairs that share no anchor, most are truly different
  (invoices, statements, weekly tables, flat listings), but some are not, such as Netflix's per-mail
  references. Those cost a row, not a hidden thread.
- Lines written before this say nothing about what they covered. Counting them later would be a guess.
- Undo of a line takes back that feedback. Threads a newer closing of the same ask also covers stay hidden
  until that line is undone too, as under ADR 0061.
