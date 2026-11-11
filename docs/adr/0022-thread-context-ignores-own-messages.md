# 0022. Thread context ignores the user's own messages

- Status: Accepted
- Date: 2026-11-03
- Refines: [0020](0020-sending-outbox-and-compose.md) rule 2

## Context

ADR 0020 binds an approval to the thread context, the newest message key of
the thread. That included messages the user sent, so with two replies pending
in one thread the second was voided as soon as the first went out: the user's
own message counted as new mail.

## Decision

The thread context is the newest key of a thread message **not sent by the
user**. Messages from the account's address or the draft's `from` address
(compared case-insensitively) and provisional local `sent:` entries are
skipped, both when the approval is created and when it is re-checked at
hand-off. A thread with only the user's own messages has no context.

## Consequences

- Several replies can be queued in one thread; each is sent exactly once.
- A message the user sends from another client does not void a pending send.
- New mail from anyone else still voids the approval.
