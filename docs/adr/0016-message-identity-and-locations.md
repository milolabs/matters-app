# 0016. Message identity and locations

- Status: Accepted
- Date: 2026-11-03
- Refines: [0014](0014-labels-threads-identity.md)

## Context

ADR 0014 keys a message by (account, provider id) and models folders as
exclusive labels. The store fixes a message's key for life on first upsert.

IMAP has no id that is stable across folders by default. A UID belongs to one
folder and one UIDVALIDITY; moving a message produces "expunged here, new
there". Treating the folder UID as the provider id would give a moved message
a new key, drop it from its thread position and re-download it. Stable ids
exist on some servers:

- Gmail: `X-GM-MSGID` (and `X-GM-THRID` for threads), via `X-GM-EXT-1`.
- RFC 8474 `OBJECTID`: `EMAILID` / `THREADID` (Dovecot, Fastmail and others).

Gmail is synced through All Mail only (ADR 0008), so its folders never
duplicate a message.

## Decision

1. **A message and its locations are separate.**
   - A *message* has the store key (fixed for life), the provider id, content
     and labels.
   - A *location* is `(account, folder, uidValidity, uid) → key`. A message can
     have several locations (copies in several folders).
2. **Provider id**, in order of preference:
   1. `X-GM-MSGID` (capability `labels`/`threads` via X-GM-EXT-1),
   2. RFC 8474 `EMAILID` (capability `objectId`),
   3. otherwise a content fingerprint: hash of (`Message-ID` header,
      `Date` header, RFC822 size). Messages without a `Message-ID` fall back
      to the location itself, so they cannot be matched across folders.
3. **Sync applies locations, not deletions.**
   - A new UID whose provider id is already known adds a location to the
     existing message (a move or copy): same key, no re-download of the body.
   - An expunged/vanished UID removes that location.
   - A message is deleted from store, index and bodies only when its last
     location is gone, inside the same unit of work.
   - For providers with real labels (Gmail), labels come from the provider; for
     the others, the message's folder labels are derived from its locations.
4. **UIDVALIDITY change** drops all locations of that folder and resyncs it;
   messages survive if other locations or a matching provider id keep them.
5. **Moves we make ourselves** (archive, move) use `MOVE` (RFC 6851) when
   available, else `COPY` + `\Deleted` + `UID EXPUNGE`; the new location is
   learned from `COPYUID` (UIDPLUS) when offered, otherwise from the next sync.
6. **`SyncBatch`** carries `documents` (new messages with their location),
   `knownLocations` (already-known messages found at a new location, no
   download), `flagUpdates`, `removedLocations`, an optional `resetFolder` and
   the `cursor` — instead of removed provider ids.
7. **Keys are allocated by the core** inside the unit of work (`allocateKeys`),
   because many messages share one `Date` second and adapters cannot pick
   collision-free keys.
8. **Removals wait for additions.** `syncAccount` applies batches that carry
   removals only after every folder has reported its additions, so a move
   seen as "gone from INBOX" before "new in Archive" never deletes the message.
9. **Resumable initial sync.** The IMAP cursor is
   `{uidValidity, lastUid, lowUid, complete, highestModseq}`; newest-first
   initial sync can be interrupted and resumed without gaps or re-downloads.

Measured on Debian's Dovecot 2.4.1: it advertises CONDSTORE, QRESYNC, MOVE,
UIDPLUS and COMPRESS=DEFLATE, but **not OBJECTID**, so plain Dovecot uses the
fingerprint id.

## Consequences

- Moving mail between folders keeps keys, threads and bodies, and costs no
  download when the server offers stable ids.
- The fingerprint fallback can merge two distinct messages with identical
  `Message-ID`, `Date` and size; this is rare and preferable to duplicating
  every moved message. It is never used when a stable id exists.
- The store gets a locations table and a "last location gone" rule, both
  covered by contract tests.
