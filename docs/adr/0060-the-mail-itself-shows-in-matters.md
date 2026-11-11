# 0060. The mail itself shows in Matters

- Status: Accepted
- Date: 2026-11-05

## Context

The reader of Matters showed one quoted passage and what the agent prepared. To read the message, the
person had to leave for All mail and find it there. Deciding on a draft or a question without the mail
it answers is asking the person to trust a summary, which the rest of Matters works hard not to do.

## Decision

1. **Under what the agent made, the whole thread.** The thing in the reader shows every letter of its
   thread, with the same component as the thread view: the same folding (the newest and the unread are
   open), the same sanitised rendering, images and link warnings.
2. **It comes after the agent's work,** so that the quote, the map and the draft keep their place and
   nothing moves when letters arrive.
3. **Looking at it does not mark it read,** for now. Matters selects things by itself, and the countdown
   of ADR 0039 belongs to the list of mail. Marking from Matters is a separate decision.

## Consequences

- A thread in Matters that is unread stays unread in All mail until it is opened there or marked.
- `e`, the arrows and the other keys of Matters are unchanged.
