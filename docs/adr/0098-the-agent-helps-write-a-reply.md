# 0098. The agent helps write a reply

- Status: Accepted
- Date: 2026-11-09

## Context

The reply editor (ADR 0096) leaves the writing to the person: gaps in square brackets for what is
still missing, the quote of the message below. The agent could already prepare a whole draft
(ADR 0052, 0063) or talk about a thread (ADR 0064), but not help with the draft the person is
writing: make it shorter, more formal or English, answer what the other side asked, say what is
still unanswered, or find the values for the gaps in the thread.

## Decision

1. Four requests, each one turn for one thread, made in the sync worker like `agentPrepare` and
   `agentTalk` and behind the same gates: AI on for the runtime, the thread there, its account
   agreed, the runtime ready, room in the plan. They are `P0`: the person asked for them.
   - `agentRewriteDraft { threadId, text, how }`, with `how` one of `shorter`, `formal`,
     `english`, gives `{ text }`: the person's lines rewritten that way. Only those lines go to the
     model, no mail. Model for writing.
   - `agentAnswerQuestions { threadId, text }` gives `{ text }`: the draft with a short answer or
     acknowledgement added for each question or request in the other side's last message that it
     does not answer yet. Where an answer needs a fact the thread does not state, the model leaves
     a gap in brackets instead of inventing it. With nothing left to answer, the text comes back
     exactly as it was sent. Model for writing; the thread goes with it.
   - `agentCheckReply { threadId, text }` gives `{ asked, answered, missing }`: how many asks the
     other side's last message holds, how many the draft answers, and a short phrase for each one
     it does not. Cheap: only that one message (without what it quotes) and the draft, on the model
     for understanding with low effort.
   - `agentFillGaps { threadId, text }` gives `{ suggestions: { token, value, source }[] }`: a
     value from the thread for each gap of the person's lines, as `gaps()` finds them (quoted lines
     and bracketed links are not gaps). Gaps with nothing found are left out. Model for
     understanding with low effort; no gap, no turn.
2. `text` is the composer's whole Markdown body. The person's lines are the ones above the first
   quoted (`>`) line; the line just above it goes with the quote when it ends in a colon (the
   "On …, Anna wrote:" line). Everything from there down, the person's inline words among quoted
   lines included, is the quote: it is never rewritten and is joined back as it was, one empty
   line under the person's lines.
3. Every gap in brackets the person left is kept exactly. A rewrite that drops one, or adds one,
   is not used; nor is an answer that drops one. An answer that writes a quoted line, or one that
   keeps less than most of the person's draft, is not used either.
4. The answers are JSON with a schema, checked by the code (ADR 0051, rule 9). A value for a gap
   must be found, word for word, in the message it names, or it is left out; its `source` ("Anna's
   message, 6 Nov") is written by the code from that message, never by the model. A shape that is
   not accepted is an `AgentUnavailableError` with a sentence for the person, shown as the error's
   message (`agentUnavailable` on the wire), never a crash.
5. None of these sends mail or changes a stored draft: the result goes back to the composer, and
   the person decides what to keep. The agent has no send tool here, as nowhere else.
6. Each turn is counted in the ledger as `prepare` (no new purpose, so no migration): `threads` is
   0 for a rewrite, which sends no mail, and 1 for the others.
7. The demo runtime (`MATTERS_SEED=1`) answers all four from canned rules over the demo mailbox: it
   finds the seeded asks (confirm the documents, move the meeting, pay by Friday) and any line
   ending in a question mark, answers them with a sentence or a gap, swaps a few phrases for a
   rewrite, and fills gaps such as `[telefon]` or `[godzina]` with passages it finds in the mail,
   so the checks above run for real.

## Consequences

The composer can offer the four as buttons without its own model code, and what it gets back is
held to the same rules as every other answer. The thread's stored facts (ADR 0075) are not used to
fill gaps yet; a gap is always one small turn. The check runs one turn per press, so the composer
should call it when asked or after a pause, not on every keystroke.

## Addendum (2026-11-09)

The same help is in the full composer for any message that answers a thread (a new message has no
thread, so no agent). ⌘J opens the menu in both; arrows, Home and End move in it, Esc and Tab close
it and give the focus back to the text.

## Addendum 2 (2026-11-09): the check and the answer agree

The check found an ask that "Answer each of the questions" then did not see, and the note said
every question was answered. The ask was a newsletter's "stop promotional emails".

- A last message from a list or a program (`Message.automated`, or an automated address) asks the
  person nothing: the check returns nothing and the answer changes nothing, with no turn.
- The check does not count what a newsletter, an advert or a notice says to every reader (buy,
  register, click, unsubscribe, stop these emails, rate us).
- The answer is given the check's open asks and answers each of them. When it still adds nothing,
  the note names what is open and says to answer it by hand; it never says all is answered.
- After an answer the check runs again at once. A message that asks nothing gets no check line.
