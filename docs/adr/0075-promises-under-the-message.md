# 0075. Promises under the message

- Status: Accepted
- Date: 2026-11-08

## Context

The agent already reads a thread and keeps facts: each promise or ask, who owes it, an optional due
date, and the passage of the message it was found in. The code checks that passage against the cited
message (ADR 0052). The thread view showed only the agent's one-line headline, so the person had to
find the sentence a promise came from by reading the whole thread again.

## Decision

1. **The facts reach the renderer with the reading.** `ThreadAgentView` gains `facts`: for each
   fact its kind, who, `dueMs` when there is one, the quote and the `messageKey` it came from. They
   are filled under exactly the conditions that fill `reading` (AI on, consent, the analysis is of
   the thread's last message, and the list's own bar for showing a reading). In every other case the
   list is empty. No new model call is made, and neither the prompts nor `ANALYZER_VERSION` change.
2. **Lines live under the message they came from.** A fact is drawn as one quiet line directly
   below the message named by its evidence `messageKey`: below the row of a collapsed message, below
   the body of an open one. The quote is checked text from that message, so the line sits next to
   its source and needs no jump.
3. **Always shown.** There is no separate mode and no setting. When the reading is shown, its lines
   are shown; when it is not, nothing is.
4. **Statuses.** From `promiseLines` (pure, in core):
   - `late`: the due day is before today. A date is due until its day ends, the same rule the list's
     `daysLate` follows; "today" is the calendar day in the person's time zone.
   - `open`: due today or later; the line shows the date and the days left ("today" on the day).
   - `undated`: the fact has no due date; the line shows no date.
   Lines under one message are ordered by due date, the undated last.
5. **The sentence.** "You promised „quote”", "Promised „quote”" (the other side), "Asks you „quote”"
   (an ask of the person) and "You asked „quote”". The words are fixed; the quote is the mail's own,
   shown as text in ink colour. The right column holds "4 days late" in the late colour, or
   "by 12 Nov · 4 days left", or nothing.
6. **The marker.** On the reader's lead grid, a 6 px marker is centred in the 28 px column: filled
   ink for open, filled in the late colour for late, hollow for undated. A 1 px hairline joins it to
   what is above: the avatar of a collapsed row, the line before, or, under an open letter, a rail
   beside the body. Markers and hairlines are hidden from assistive technology. The lines are a list
   ("Promises in this message").
7. **The strip.** The agent strip keeps "Agent: headline" and appends "Still open: " and up to two
   parts joined by " and ", late first, then by due date, the undated last. A part says whose it is
   and what it is ("their promise", "your promise", "their request", "your request"), then the
   quote cut to six words with an ellipsis in quotation marks, then the date or the days late. The
   kind is named so that a question someone asked never reads as the person's own words. The
   headline ends with a full stop before "Still open:". There is
   no paraphrase, since the model gives none for a fact; the quote's own words are used. Late parts
   wear the late colour. The strip may wrap to two lines, and its button stays centred.
8. **Folding.** A message with a promise line is never folded into "N earlier messages". Such a
   message splits the run, and the longest stretch of messages without a line that is still long
   enough to fold (two or more) is the one that folds.
9. **One block per open letter.** The open letter's header used to have the soft background alone,
   so its body looked detached. The header now has the normal background, like the body: header and
   body are separated by 4 px only, and the body ends with 16 px. An open letter still differs from a
   collapsed one by the header's name weight (semibold against medium) and by having no snippet.

## Not covered

Marking a promise as kept, or setting it aside, is not here. It changes what the agent knows and
what the list shows, so it needs its own decision. Until then a line stays while the analysis holds
the fact, and goes when a newer message makes the analysis stale.

## Consequences

The sentence a promise rests on is next to the promise, and what is overdue is visible without
opening the agent. The view carries a few more strings per thread, all already stored. A thread with
many dated promises keeps more of its messages as rows, so a long thread folds a little less. The
summary uses the quote as it is, so a long or oddly cut quote reads less smoothly than a written
phrase would; a later phrase from the model would have to be checked like any other text.
