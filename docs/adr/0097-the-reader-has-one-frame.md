# 0097. The reader has one frame

- Status: Accepted
- Date: 2026-11-09

## Context

A single message read as three nested boxes: a card around the letters, a frame around the
message as sent, and the window itself. Under the subject sat "you · 1 message", a separate
"Account" line and the labels on a line of their own, while the letter below named the same
sender and recipient again. It looked busy and less professional than a plain mail client.

## Decision

1. No card around the letters: letters are separated by a hairline only, aligned with the header.
2. The message as sent has no border and takes the full width under its header row.
3. Under the subject, one quiet line: who else and how many messages (only for more than one
   message, since a single letter names both already), the account's dot and address, the labels.

## Consequences

Less chrome and more room for the message. The sender still appears both in the thread header and
in the letter row; folding those for a single-message thread is left for a later change.
