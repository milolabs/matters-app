# 0132. The agent helps write a new message, and writes as the person asks

- Status: Accepted
- Date: 2026-11-13
- Amends: [0098](0098-the-agent-helps-write-a-reply.md), rule 1 (a rewrite takes a thread or an
  account) and its first addendum (a new message has an agent too)

## Context

The agent's help while writing (ADR 0098) is one turn for one thread: its gates start from the
thread, and the menu only exists for a message that answers one. A new message and a forward have
no thread, so they had no agent at all, not even for a rewrite, which never sends mail. And the
menu offers fixed moves only: shorter, more formal, in English, answer the questions, fill the
gaps. There was no way to tell the agent in one's own words what to write ("an invitation to
Friday's review, keep it short") or what to change ("add a paragraph about the price").

## Decision

1. A message with no thread is gated by the account it goes out from: AI on for the runtime, that
   account agreed to it, the runtime ready, room in the plan. These are the gates of a turn for a
   thread (ADR 0063), by account instead of by thread, and the code shares them.
2. `agentRewriteDraft` takes exactly one of `threadId` and `accountId`. Only the person's lines go
   to the model, as before. The ledger counts it as `prepare` with `threads` 0.
3. A new request, `agentWriteDraft { threadId | accountId, subject, text, words }`, gives `{ text }`.
   Exactly one of `threadId` and `accountId`. `words` is what the person asks, in their own words,
   at most 1000 characters and not blank. The model gets the words, the subject, the person's own
   lines (which may be empty) and, only when there is a thread, the thread, rendered as for the
   other help. It gives the person's whole lines back, written or changed as asked.
   - The person's words go in the request under their own heading, marked as theirs, as the words
     of a talk do (ADR 0064). The subject, the draft and the thread are data, as everywhere. The
     standing instructions for writing go with the fixed text.
   - A fact the model was not given (a date, an amount, a name, a decision) is left as a gap in
     square brackets, never invented.
   - Every gap the person already left is kept, as often as it was there; new gaps are allowed.
   - The answer never has a line that starts with `>`: the quote never goes for writing and is
     joined back as it was.
   - The answer has no subject line at the top: a first line that is `Subject: …` or the subject
     itself is not used. Nor is an empty answer.
   - It runs on the model and effort for writing. It is `P0`, counted as `prepare`, with `threads`
     1 when the thread went and 0 when it did not. An answer the code does not accept is an
     `AgentUnavailableError` with a sentence for the person.
   - It never sends mail and never changes a stored draft; the text goes back to the composer.
4. The composer offers the agent for every message while AI is on. A new message and a forward get
   the field and the rewrites; only a message that answers a thread gets the help that reads it
   (the check, the answers, the gaps filled), and only it runs the check while the person writes.
   The help for a new message asks for the account the message goes out from when it is asked, so
   a changed sender is the one gated.
5. The menu (⌘J) opens on a one-line field, "Tell the agent what to write or change". Enter runs it;
   an empty field does nothing. The arrows move between the field and the items. What is typed in
   the field stays in it: neither the menu, the composer nor the window acts on it, and Esc, Tab
   and ⌘J still close the menu and give the focus back to the text. The note says "The agent wrote
   it as you asked." with Keep and Undo, or "The agent changed nothing.". A request that fails
   keeps the words in the field for the next try.
6. The demo runtime (`MATTERS_SEED=1`) answers the new request from canned rules: a line made from
   the person's words with gaps for the date and the time, above the closing of the draft, or a
   short message around it when the draft is empty. So the checks above run for real.

## Consequences

A person can start a new message from a sentence and then shape it with the agent, without a
thread. A new message sends no mail to the model, only what the person wrote and asked. The
person's words are free text, so the model may do something other than what was meant; the checks
keep the gaps and the quote, and Undo takes the rest back. The field is one line; longer asks fit
in the talk about a thread. The check, the answers and the gaps still need a thread.
