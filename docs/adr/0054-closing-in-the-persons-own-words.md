# 0054. Closing a thing in the person's own words, and what the agent remembers

- Status: Superseded by [0117](0117-matters-is-a-view-with-a-prompt.md)
- Date: 2026-11-05
- Amends: 0052

## Context

When the agent stops and asks what to write, the person sometimes answers that nothing should be
written: the thread is an automatic notification, or a no-reply address. Words given to the agent
always ended in a draft, because the instructions and the schema allowed nothing else. The person
then had to dismiss a draft they had just said they did not want, and `Not important` also lowers the
score of that sender, which says something else.

The owner also wants the agent to keep what it is told: rules it sets itself, instructions in general
and per operation, and a record of what was done and remembered, overall, per message and per type of
message.

Mail is hostile input (ADR 0047). Anything the agent keeps is read again in later turns, so one mail
that could write to it would outlast the thread it arrived in.

## Decision

### Closing a thing

1. **A third answer.** When the person typed words, the model may answer `closed` with a one-line
   reason instead of a draft. Choosing one of the offered directions is not enough: those were written
   by a model that read the mail, so they still give a draft.
2. **Code holds the line.** `closed` is accepted only on a turn where the person typed words. On any
   other turn, including drafts prepared ahead, it is refused and nothing is recorded. The schema asks;
   the check decides (ADR 0051, rule 9).
3. **`closed` is feedback, not prepared work.** It is recorded in the feedback log with its reason. It
   hides the thing, does not lower the sender's score, and moves no mail. A newer message in the thread
   makes a new thing, as with other feedback.
4. **Never silent.** The thing leaves the list with a line saying why, and an Undo. A mail that talks a
   model into closing itself is therefore visible and can be reversed. The reason is shown as text only.
5. **The same without a model.** `No reply needed` beside `Not important` and `Later` records the same
   feedback with no reason and spends nothing.

The rule for `closed` lives in the guidance block, not in the fixed instructions, so `ANALYZER_VERSION`
does not move and nothing is read again.

### What the agent remembers (the steps after this one)

6. **One local log.** What was done, who decided it, and on what grounds. Undo works from it. Entries
   about a thread go when its mail goes (`removeForThreads`).
7. **Scopes.** General and per operation (understanding, writing), and for one thread: text for the
   model. Per sender and per type of message: rules in code, which cost no tokens and give the same
   result every time.
8. **What writes a rule never reads the mail.** A rule or instruction is written by a separate turn
   that receives the person's words and facts from code (the sender, the type), and no message text.
   This is what lets the agent set them without asking each time.
9. **Never wider than was said.** Saying "this is no-reply" closes this thread. A wider rule is offered
   with one click, because silently closing a sender can hide a real invoice.
10. **New instructions do not read the mailbox again.** They apply to what is read from then on.
    Reading the window again is a separate choice, since it spends the plan. Types start with what
    headers and addresses can tell, because a type from a model means bumping `ANALYZER_VERSION`.

## Consequences

- `agent_feedback` gains the `closed` kind and a `reason`, which SQLite can only do by rebuilding the
  table in a migration.
- On a turn where the person typed words, a message in the thread can still try to talk the model into
  `closed` when the person meant something else. Rule 4 makes that visible; it does not prevent it.
- The local filter of ADR 0052, rule 4 is unchanged. Notifications it misses still reach the list, and
  are the first use of per-sender rules.
- Rules 6 to 10 are code now (see the sections below). Where the build is stricter than the rule, the section says so.

### Built, 2026-11-05: the log

Rule 6 is code. The log holds one line per closing, `Not important` and `Later`: when, what, who
decided (the person or the agent), the thread and the message it was about, the sender, the headline
of the reading, the words the person typed, the reason the agent gave, and when it was undone. Undo
marks the line and leaves it.

- It is written in the same transaction as the feedback row, and undone in the same transaction that
  takes the feedback back, so the two cannot disagree.
- Migration 26 backfills it from the feedback already stored, so nothing closed before is invisible:
  a row with a reason is the agent's, the rest the person's. Words were never kept, so they are empty.
- It is shown in Settings > Agents as `What the agent did`, with Undo on the newest line of a thread
  and kind, which stays after the tray's eight seconds. The page reads it on the reader connection.
- It never leaves the machine and is not sent to a model, in analysis or in preparing. Mail text in it
  (headline, words, reason) is drawn as text only. Its lines go with the thread (`removeForThreads`).

### Built, 2026-11-05: rules in code

Rule 7 is code for senders and one type. A rule is a scope, a subject, the action `noReply`, who made
it and the person's own words if any. It holds an address or a type, never mail.

- **A thread stays if anyone else writes in it.** A rule hides a thread only when every sender in it
  other than the person is matched by some rule. A real person in the thread keeps it in the list: that
  is the guard against hiding a real conversation (rule 9).
- **Nothing is read or shown.** A covered thread is dropped before choosing what to read, so it is
  never sent to a model, and a reading that already exists stops showing. Hiding is decided when the
  list is built, so removing the rule brings the thing back and reading of what it kept resumes.
- **Only clicks make rules so far.** `Always for <address>` on the tray after a closing, and the
  Rules row in Settings > Agents. No instruction and no agent turn writes one yet. Adding writes a
  line in the journal in the same transaction; removing marks it undone. Rules and their lines are not
  tied to a thread, so `removeForThreads` leaves them. Migration 27.
- **The one type is addresses that look like programs** (`alerts@`, `updates@`, `status@`...). What
  headers and the no-reply pattern catch never reaches the list anyway (ADR 0052, rule 4), so a type
  rule on those would do nothing; `looksLikeProgram` stays out of that filter and does nothing without
  a rule.
- **`domain` is new.** Rule 7 named sender and type. A domain is a wider form of a sender, so the
  person has to type it; the tray never offers it.

### Built, 2026-11-05: instructions and what writes them

Rules 7, 8 and 10 for text kept for the model: general, when reading, when writing, and for one thread.
The person adds them in Settings > Agents (`Instructions`), or the agent keeps them from words they typed.

- **Where they go.** Lines for the operation go into the request's `instructions` (the system prompt),
  under a heading that says the person wrote them and that they never change the rules above, the
  answer format, or what counts as data. They never go with the mail. Reading gets general, reading and
  that thread's lines; a draft gets general, writing and that thread's. The block holds at most 4000
  characters, oldest dropped first. The fixed texts and `ANALYZER_VERSION` do not change, so a new
  instruction reads nothing again (rule 10). With none, a request is what it was.
- **The writing turn takes only typed words.** Stricter than rule 8, which allowed facts from code:
  the model gets none. Its request is built by a function that takes the words string and nothing else,
  so mail cannot be passed by type. If the answer is a rule for a sender, code takes the address from the
  store by thread id; the model never names one. A test asserts that a marker from a thread's body,
  subject and headline is not in the request.
- **Only typed words start it.** A direction chosen from the offered list was written by a model that
  read the mail, so it does not start the turn. Only a non-empty `answer` does. It is a separate request
  after the reply, so the reply is shown at once and nothing waits for it.
- **What it costs.** One background turn on the understand model, `P1`. When the plan refuses, or AI
  is off, or the account has no consent, it is skipped and not retried. A failed turn or an answer that
  does not fit gives nothing and never an error. It shows in `What was sent` as `remember`, with no
  threads.
- **It can misjudge.** A model decides what holds from now on, so every result is shown: a line in the
  tray (or added to the line of the closing) with an Undo that removes exactly what was added, and a
  line in the journal. Only what is not already there, and at most 30 not tied to a thread, is added.
  Instructions for one thread go with its mail. Migration 28.

