# 0073. The thread on one grid

- Status: Accepted
- Date: 2026-11-08

## Context

The reader had grown by steps. The thread view, the received files, the agent strip, the reply
bar and the Matters reader each set their own sizes: 11, 11.5, 12, 12.5, 13, 13.5, 14, 15 and 23 px
for type; 2, 6, 10, 14, 18, 20 px and more for space; radii of 5, 6, 7, 10 and 14 px. Each piece
was reasonable alone. Side by side the names, the dates, the text of a letter and the text of the
agent strip started at different edges, and each letter was a separate card with gaps between them.
The owner asked for the proportions of type and space to be one decision, not many.

## Decision

**One surface.** All the letters of a thread live in one container: radius 12 px, a 1 px hairline
border, and 1 px hairline dividers between the messages. There are no gaps and no card per message.

**One grid for every row.** A message row, an open letter's header, the folded-run row, the agent
strip, the reply bar and the header of the Matters source card are laid out on the same columns:
`28px minmax(0, 1fr) auto`, column gap 12 px, padding 10 px 16 px, items centred.

- Column 1 (the lead) holds the sender's avatar; on the agent strip and the agent cards it holds the
  agent ring, on the reply bar the reply icon, each centred in the 28 px.
- Column 2 holds the sender's name; collapsed, the snippet follows it inline on one line with an
  ellipsis. The old fixed 150 px name column is gone. An open letter holds the name and
  "→ recipients" in secondary.
- Column 3 holds the date. In an open letter it holds the text/original switch and then the date,
  12 px apart, so the open letter's date lines up with the dates of the folded rows.
- Everything under an open letter's header (the text, the signature, the folded quote, the image
  notice, the attachments, the designed mail's frame) starts at the content edge: padding
  `0 16px 16px 56px` (16 + 28 + 12). Plain text is at most 600 px wide; the frame of a designed mail
  uses all the width from 56 px. In the Matters reader the quote and the fact row of the source card
  start at the same 56 px, and the agent's draft and question put the ring in the 28 px column and
  their text at the content edge.

**Five steps of type.** Only 11, 12, 13, 15 and 22 px are used in the reader.

| Step | Used for |
| --- | --- |
| 22 | the thread title (serif, line height 1.25, tracking -0.01em) |
| 15 | what people wrote: the message body (serif, line height 1.6), the quote in the Matters source card |
| 13 | interface text: sender names, snippets, strip text, reply bar text |
| 12 | meta: participants, account line, dates (tabular figures), attachment chips, buttons, signature, image notice |
| 11 | tiny labels: the text/original switch, label chips, the fold toggle, avatar letters, counters |

A size that was between two steps moved to the step the role belongs to. The shared `pill` buttons
and the badge in the file chip live in the composer and settings too; they keep their sizes in this
step.

**Five steps of space.** 4, 8, 12, 16 and 24 px, and 32 px for the reader's side padding. Blocks
stacked in the reader are 12 px apart; the header's meta line is followed by 16 px. Cards (the thread
surface, the agent strip, the reply bar, the Matters source, draft and question cards) have radius
12 px; controls (buttons, chips, attachment chips) 8 px. The 10 px of a row's vertical padding is
the one value off this scale, and it is fixed by the row grid.

**Avatars.** A 28 px circle with one or two letters (11 px, semibold) from `initials()`: the first
letters of the first and the last word of the name ("Anna Kowalska" is AK, "Kalibra" is K); a bare
address is read as a name ("jan.nowak@x.pl" is JN); Polish letters are kept; nothing to read gives
"?". Other people's avatars are neutral: the fill colour, a hairline border, secondary text. The
person's own messages (from one of their accounts, as the reader already decides it) are filled with
that account's colour from `accountMarks`, with the ink the mark has for it. The letters are an
attribute drawn by CSS, so they are not text and the name stays the only text of the row; the avatar
is hidden from assistive technology.

**The fold rule.** When three or more consecutive messages are collapsed before the first open one,
the first stays as a row and the rest of the run becomes one row on the same grid: a 28 px circle
with a dashed border holding the count, "N earlier messages", and the date range of the folded
messages in column 3. Pressing it (click, Return or Space; it is a button) shows them. Nothing else
folds: a collapsed message after an open one is a row of its own. `foldRun()` decides it once per
thread from how each letter starts (the newest and the unread are open) and is tested without a page.

## Consequences

- The names, dates and bodies of a thread, its strip and its reply bar share two vertical lines (the
  lead edge at 16 px and the content edge at 56 px), so the eye has one place to start reading.
- The reader no longer sizes things by feel: a new element picks a step from the two scales. The
  shared `pill` (13 px) and the composer's file badge (10 px) are the known exceptions, to be moved
  when the composer and settings are brought onto the same scales.
- Initials and the fold are computed once per thread render, and a letter's avatar once per letter;
  there is no measuring and no per-row layout work. The letters are keyed by message key as before,
  so a refetch does not fold or reload them.
- A long thread opens with its first message, one fold row and the unread ones, not every old
  message. The cost is one more click to see the middle of a long, already-read thread.
- A message's header is no longer one wide button: the row folds on a click outside its controls, and
  the button holding the recipients is the one for the keyboard.
