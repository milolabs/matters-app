# 0039. Marking read and unread

- Status: Accepted
- Date: 2026-11-04
- Refines: [0007](0007-local-first-sync.md) (rule 4)

## Context

ADR 0007 rule 4 says every user action changes local state at once, is queued as an outbox
operation and reaches the server in the background. Of the actions it lists, only sending has
been built. `\Seen` was already stored (a bit of `messages.flags`), `is:unread` works and rows show
it, but nothing writes it: the mail stays unread forever, and IMAP mailboxes are opened read-only,
so even a server-side change from another device only comes back through sync.

Marking read touches four things that pull in different directions:

- **Speed.** ADR 0012 gives mark read one frame (16 ms). The reader must see it before anything is
  said to the network.
- **Intent.** Reading a thread should mark it read, but `j` through a list must not, and
  launching the app must not read the newest mail because the first row opens by itself.
- **Sync.** A sync batch is built from the server's state. If it arrives after a local change that
  has not been pushed, it writes the old state over it and the thread is unread again.
- **The view.** In `is:unread`, a row that is read leaves the list. Doing that while the reader is
  on it would make the list jump under their hands.

## Decision

### Automatic: the dwell

1. A thread becomes read after it has stayed selected for **1500 ms**. It is long enough that
   `j`/`k` through a list reads nothing (a held key repeats about every 30 ms, and glancing at a
   subject takes about a second), and short enough that the reader has not moved on and forgotten.
   The countdown shows: the unread dots of the thread's rows drain linearly over the same time, in
   a faint ring, so the indicator ends as the result it announces, and leaving early puts them back
   whole. No new element takes up room in a row. With reduced motion they fade in place.
2. **Only a deliberate selection counts**: `j`/`k`, the arrow keys in the list, a click. The app
   selects by itself at launch (the first row), when a view or a search replaces the list, and
   when the selected row is deleted and its neighbour takes over. None of these starts the
   countdown; one that is running is cancelled. A click on the row the app selected makes it the
   reader's.
3. **Only with the window in front.** Blur cancels the countdown; focus starts it again for the
   same thread if the selection was deliberate. A repeated focus event does not start it over.
4. A change event that makes the store fetch the open thread again does not restart the
   countdown. Landing on the thread that is already selected changes nothing.
5. **A thread is counted once** each time it is selected. A message that arrives in a thread that
   is already open and was already read **stays unread** until the thread is selected again. This
   is intended: the reader has not seen it, and marking it read behind their back is the worse
   error. (Within the first 1500 ms the new message is part of the thread being read.)

The decision lives in `renderer/autoRead.ts`, a pure module with an injected timer.

### `u`

6. `u` toggles, keyed off the **selected row**: an unread row marks the **whole thread** read, a
   read row marks **only that message** unread. It works with the focus on the list or the reader
   and is held back like every plain key: not in text fields, the query bar, or the composer, not
   with a modifier (`renderer/keys.ts`).
7. `u` cancels the countdown and the thread is **not marked again until the reader selects it
   again**, so the thread they just marked unread does not turn read under them 1.5 s later.

### The row being read is held

8. In a constrained list (`is:unread`, a search, a label), a refresh asks the backend again. If
   the selected row no longer matches (it was just marked read) it **stays in its place** and the
   selection and the open thread do not move. It goes when the reader moves to another row:
   `j`/`k`/click then continue from the logical neighbour (the index shifts by the row that went
   away, so no row is skipped or visited twice). A deleted row is not held, nor is one below the
   window the refreshed page covers. Other rows of the same thread leave at once. A new query
   forgets it. Nothing in this opens another thread or starts a countdown.
9. The active tab shows the length of the list, which includes the held row; the badges of the
   other tabs come from the backend and count again after each change event (ADR 0027), so the
   tab you are on and the badge it will have after you move agree one row later.

### Instant, then the server

10. The renderer patches the list and the open thread **synchronously**, then asks the backend.
    What it asked for is kept on top of every fetch (an overlay) until the command has resolved
    **and** an event at least as new as the commit has been applied (the command returns the
    change sequence of its write), so an older `changes` event cannot flash the old state. An
    intent that no event caught up with is let go after 10 s. If the command fails, the intents
    go and the messages are fetched again.
11. The open thread's letters are keyed by **message key**, not by object. A refetch hands back
    new objects for the same messages, and a list keyed by object would take every letter for a new
    one: open letters fold and the frame of a message sent as designed loads again. Marking read
    folds, reloads and scrolls nothing. `initiallyOpen` still reads the state when the letter was
    made.

### The request for the server

12. **A table of its own**, `flag_operations`: one row per message (`message_key` primary key),
    with account, the wanted state, `previous_seen`, attempts, `next_attempt_ms`, creation time
    and `rev`. The latest request wins; a replacement keeps `previous_seen` (the state the server
    has, before the first unpushed request) and raises `rev`. It is **not the send outbox**
    (`send_operations`, ADR 0020): that one is a state machine around one approved draft that must
    never be sent twice with a different meaning, and generalising it would put "latest intent wins"
    and "never repeat blindly" in one type. Read state is idempotent and last-writer-wins, and a
    separate table says so.
13. `setSeen(keys, seen)` (core use case) writes the flag and the request **in one unit of work**:
    a crash leaves neither or both, bumps `change_seq` once and only for messages that really
    changed, and enqueues only for those. The request is due **1 s after the latest change** (it is
    stored with that time), which coalesces a burst of toggles, or marking a long thread, into one
    `STORE` without any timer state that a crash could lose.
14. **Sync may not undo a request that has not been pushed.** `applySyncBatch` ends its unit of
    work by putting the account's pending requests back over what the batch wrote. The batch may
    have written flags through three paths (a re-ingested document, a known location at a new
    place, a flag update) and one re-application at the end covers all of them. Other flags from the
    server (flagged, answered, draft) still apply. The pending set is normally empty: one indexed
    read per batch and no write; a message that already has the wanted state is not touched, so
    nothing is announced for it.

### Pushing

15. `MailConnection` gets `flags: MailFlagsPort` with a batch `setSeen(locations, seen)`. The IMAP
    adapter groups locations by folder, opens each folder **read-write** under a mailbox lock
    (`getMailboxLock` re-selects when the access mode differs, so a sync on the same connection is
    not left with the wrong mode), and uses `UID STORE +FLAGS.SILENT / -FLAGS.SILENT (\Seen)`, 500
    UIDs at a time. It writes to **every** location of the message: IMAP flags belong to a copy.
    A copy whose UIDVALIDITY changed, or whose folder is gone, is skipped. A read-only folder is
    refused without asking. ImapFlow reports a failed STORE as `false` whether the server said NO or
    the connection broke, so a connection that is no longer usable is raised as an
    `ImapUnreachableError` to retry, and one that is up is a definite refusal. Errors are scrubbed
    of the password like the rest of the adapter.
16. **The push runs in the sync worker** (`backend/flagRunner.ts`, modelled on `OutboxRunner`; ADR
    0019): one timer armed for the earliest `next_attempt_ms`, never sleeping more than 30 s, one
    run at a time, started with the worker, so requests left by a crash or a quit are found again. It
    drains per account over **one connection of its own**, like the send path: the sync's connection
    and the inbox watch are untouched, writes serialise with batches through the unit of work, and
    the cost is one more short connection per account while there is something to push.
17. **Outcomes**, per message (all copies):
    - Success, or the only answer being "stale": delete the request, unless a newer one replaced
      it while the push was on the wire (`rev` is compared before deleting). Some copy taking the
      flag and another refusing counts as success; sync reports each copy.
    - Offline, timeout, a password the server turned down, a vault that could not answer: keep the
      request, back off with jitter from 2 s to a cap of **5 minutes**, with no limit on attempts.
    - Refused for good (the server answers NO, e.g. a read-only folder): **the server wins**. The
      request goes and the message gets back `previous_seen` locally with a change of its own,
      because CONDSTORE will never report a change that did not happen on the server. A message
      with a newer request is left alone.
    - No locations (removed, or not on the server yet), no account, or no password (the demo
      mail): delete the request quietly and keep the local state. No error and no loop.
    - Removing an account discards its requests with its other data.

## Consequences

- Marking read costs one frame in the renderer, one write transaction in the worker, and nothing
  on the network the reader waits for. Offline, the mail stays marked and the push catches up.
- A sync that fetched flags before a push but applies them after the request was deleted can
  briefly show the old state; the server's own change (`CONDSTORE`, and the inbox watch it wakes)
  puts it right at the next sync. It cannot undo a request that is still pending.
- The flag is pushed to each known location only. A copy that sync has not found yet gets the flag
  when sync does: there the server's state wins, as everywhere else.
- A thread opened and left within 1.5 s stays unread, and a reply into an open thread stays unread
  (rule 5). Both are choices; the dwell is one constant.
- The held row means the list can show a row that does not match the query for as long as the
  reader stays on it. The count of the active tab includes it; a badge elsewhere does not.
- The renderer's open thread keeps no flag display of its own; the thread's `unreadCount` and its
  messages' flags are patched, but only the list shows read state.
- `flag_operations` rows are small and normally absent; the due and account lookups are indexed
  (a migration test checks the plans). Watch the cost of the end-of-batch read in ADR 0012's
  large-mailbox runs.
- Other state changes (archive, label, move) are still to do. They will need requests of their
  own; `MailConnection.flags` and `FlagOutboxPort` are for `\Seen` and take other flags with a new
  method, not a wider one.
