# 0007. Local-first: change log, outbox, provider cursors

- Status: Accepted
- Date: 2026-11-03

## Context

Fast mail clients never wait for the network on a click. Superhuman applies
each change locally and synchronously, persists it, and sends it to the server
in a per-thread queue. Linear keeps an in-memory object graph, bootstraps once
and then fetches deltas since a `lastSyncId`.

## Decision

1. **The UI reads only local data.**
2. **Provider cursor per folder** (IMAP: `UIDVALIDITY`, last UID,
   `HIGHESTMODSEQ`) is written **in the same transaction** as the changes it
   produced.
3. **Local change log**: every write bumps a monotonic `change_seq`. The
   renderer holds an in-memory graph (threads, messages, labels, contacts) and
   patches it with `changesSince(seq)`.
4. **Outbox**: every user action (archive, read, label, move, send) changes
   local state immediately, is stored as an outbox operation, and is sent in
   the background with retries. On conflict the server wins and local state is
   corrected.
5. **Sending never retries blindly** (kept from the Swift prototype): after an
   SMTP timeout, look for the `Message-ID` in Sent before deciding.
6. Initial sync goes newest first: headers, then text bodies, attachments on
   demand.

## Consequences

- Instant UI, works offline.
- Conflict handling and outbox recovery after a crash must be tested
  explicitly.
