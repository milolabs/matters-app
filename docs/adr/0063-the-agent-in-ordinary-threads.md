# 0063. The agent in ordinary threads

- Status: Accepted
- Date: 2026-11-06
- Amends: 0052
- Amended by: [0117](0117-matters-is-a-view-with-a-prompt.md) (no stored reading in a thread; what the agent has there is work asked for)

## Context

Reply suggestions, questions from the agent and the rest of what it makes lived only in Matters. A
person reading an ordinary thread, one the agent never judged to matter, had no way to ask it for a
reply, and could not tell whether it already had something for that thread. Making drafts for all mail
ahead of time would spend the plan on mail nobody asked about and would send far more mail to a model
than ADR 0051 allows without a reason.

## Decision

1. **Nothing is spent until the person asks, here too.** Opening a thread starts no turn. The thread
   view offers `Write with the agent`, with an optional line for what the reply should say; one click is
   one turn on the plan's allowance (`P0`), by the gates of ADR 0051: AI on, consent for the thread's
   account, a ready runtime, room in the plan.
2. **No reading is needed for a person's ask.** The ask is one turn, with the thread alone. When the
   thread has a reading of its last message, it goes into the turn as before; when it has none, or only
   one of an earlier message, the request says there is no earlier reading. There is no separate turn to
   read first. The fixed instructions and the version of the reading are unchanged, so no mailbox is read
   again.
3. **Work is kept under the thread's current last message.** What the turn makes is stored for the
   message the thread ends with now, whether or not a reading exists. A new message makes it disappear by
   itself, and the backend's store, not the window's memory, is what the thread view shows.
4. **What the agent already has shows by itself.** The thread view reads, from the local store and
   without a model, the thread's reading (when current, on the person or waiting, sure enough, not set
   aside and not covered by a rule) and any prepared work. A reading shows as one line under the header;
   prepared work shows as the same draft or question as in Matters, with the same Send, which only the
   person presses. This read says nothing while AI is off or the account has no consent.
5. **Drafts prepared ahead stay limited** to the best few (ADR 0055). This decision adds no drafting
   ahead for ordinary mail.
6. **`Dismiss` lives in this window and is not feedback.** It stops showing the work for that last
   message and records nothing, so it does not lower a sender's score and hides nothing in Matters.
   `Not important`, `Later` and `No reply needed` belong to things in Matters and are not offered here.
7. **A key never sends what is out of sight.** The draft sits under the letters, so it can be off
   screen when it was made ahead. `⌘↵` sends only while the draft's Send button is on screen; otherwise
   it brings the draft into view and sends nothing.
8. **The plans line stands at the bottom in every view while AI is on.** A turn can be asked for from
   any thread, so the model that writes and what is left of the plan stay in sight, not only in Matters.
9. **The rules that were already there still hold.** Mail is hostile input; the model proposes and code
   decides; the person's words are the only way to close a thread; `closed` needs them. Model text is
   shown as text only.

## Consequences

- Any thread can get a reply suggestion on request, at the cost of one turn each, and never more.
- A thread nobody has read can be asked about; its answer is stored under its current last message, so
  the reading that comes later does not hide it.
- Dismissed work comes back in a new window until the last message changes, since a dismissal is not
  stored.
- The header gains one button and the thread view one key, `g`; no other key changes, and Matters is
  as it was.
