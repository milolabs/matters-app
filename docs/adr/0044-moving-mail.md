# 0044. Moving mail: archive, delete, spam and folders, with a way back

- Status: Accepted
- Date: 2026-11-04
- Refines: [0007](0007-local-first-sync.md) (rule 4), [0016](0016-message-identity-and-locations.md) (rule 5), [0029](0029-query-bar-full-width.md)

## Context

Mail can be read and answered, but it can't be put away. ADR 0007 promised archive and move as
outbox operations; only sending and `\Seen` were built. Four things stand in the way.

- **"All mail" is everything, Trash and Spam included, and there is no Inbox view.** Deleting a message
  would change nothing anyone can see. Search would keep finding deleted mail.
- **Folder roles are thrown away.** `roleOfFolder` knows what each folder is during a sync, but nothing
  keeps the answer, and the names differ (`Trash`, `Kosz`, `[Gmail]/Trash`, `Deleted Items`).
- **A sync writes from the server's state.** As with read state (ADR 0039), a batch built before a push
  would put a moved message back.
- **Moving is riskier than a flag.** A mistake with a key that sits next to `r` should cost nothing, and
  the only permanent action must be hard to reach by accident.

## Decision

### Where mail is

1. A `folders` table `(account_id, folder_id, name, role, exclusive)` is written at each sync, from
   `listFolders`, before any folder is read. `exclusive` is what `Label.exclusive` already says: a folder
   is the one place a message is (IMAP), or a label that a message may have among others (Gmail). A sync
   that finds the same list writes nothing. When what a folder is changes, the mailboxes of the account's
   mail are set again in one statement (the first sync after the migration does this for the whole mailbox).
2. `messages.mailboxes` is a bit set of roles (`inbox` 1, `sent` 2, `drafts` 4, `trash` 8, `spam` 16,
   `archive` 32, `other` 64), kept wherever labels, locations or folders are written. It is worked out by
   one function of the core (`computeMailboxes`) from the message's labels: the role of the folder a label
   is the id of, else a system label by its name (`inbox`, `sent`, `draft`, `trash`, `spam`), else `other`.
   With labels as the places (Gmail), `trash` and `spam` come from the folder of the copy, and All Mail
   counts as `archive` only without the inbox label. A partial index, `messages_visible`, holds the mail
   that is not in Trash or Spam by key, so `All mail` is a walk down the chronological key with no sort;
   it is forced with `INDEXED BY` for that one query. A search checks the same bit as a filter and
   deliberately not through the index (a unary plus), so that it cannot take the place of a rarer index
   such as the unread one.
3. **`All mail` leaves out Trash and Spam**, and so does every query that does not ask for them. That is
   what the words mean in every mail client. A new query field `in:` names a role: `in:inbox`, `in:archive`,
   `in:sent`, `in:drafts`, `in:trash`, `in:spam`, and it is the only way, along with `label:` naming such a
   folder, to reach mail in Trash or Spam. It appears in the query bar's suggestions like other fields.
   "Naming such a folder" is by its id or its name, folded; a label is the id of a folder, so `label:trash`
   finds the mail in `Trash` and `label:kosz` for a Trash called `Kosz` asks for the folder and matches
   nothing. A term inside `-` or `NOT` does not ask. Opening a label directly (`listNewest` with a label) is
   asking. The messages of an opened thread follow the same rule: a thread is shown without its messages in
   Trash and Spam unless the view that opened it asks for them (`openThread` carries `hidden`), and a move
   takes what is shown. A reply still quotes the whole thread (`prepareDraft` is unchanged).
4. A migration adds a starter view **Inbox** (`in:inbox`) first among the tabs (after `All mail`, which is
   not a row). It runs once, so a view the user deletes stays deleted (ADR 0029). The migration sets
   `mailboxes` from the labels alone, by the names of the system labels (`inbox` by name, and `sent`,
   `draft`, `trash`, `spam`); every other label is `other`. That hides nothing from `All mail` that was not
   named Trash or Spam already, and the first sync after it sets the real roles (a folder called `Kosz` or
   `Wysłane` is `other` until then).

### Actions

5. There is one action, **move a thread to a target**, and four names for it:

   | Key | Action | Target | Takes from the thread |
   |---|---|---|---|
   | `e` | Archive | archive | everything but Sent and Drafts |
   | `⌫` or `#` | Delete | trash | everything |
   | `!` | Spam | spam | everything but Sent and Drafts |
   | `v` | Move to… | a folder | everything but Sent and Drafts |

   Messages already at the target are left alone. If nothing is left to move, nothing happens and the
   tray says so: *Already archived.* New mail arriving in a thread later is not covered: it is new.

   One function of the core (`planMove`) decides, per message, what it holds after the move or that there
   is nothing to move. Where folders are the places (IMAP), a move takes the message from every folder
   but Sent and Drafts (Delete from all) and puts it in the target; a message in two folders leaves both.
   Where labels are the places (Gmail), the only places are the inbox label and the Trash and Spam
   folders: the person's other labels are tags and stay. Messages in Trash and Spam are left out unless
   the thread is looked at from there (rule 3), so archiving a thread never brings a deleted message back.
6. The same buttons sit beside Reply and Reply all in the reader, with their keys in the title. Spam and
   Move sit behind a `⋯`, so a stray click on a small target is not a spam report.
7. In Trash, `⌫` is **Delete forever**: a dialog that names how many messages, with Cancel focused, and
   no undo. It is the only permanent action in the app. In Trash and Spam, `e` restores to Archive, and
   the Move list always offers Inbox.

### Instant, and reversible

8. A move commits locally in one unit of work (labels, `mailboxes`, change log, and a row per message in
   `move_operations`). The row holds the action, the target (`role:archive` or `folder:<id>`), an
   operation id shared by the action, the labels and `mailboxes` from before, attempts, next attempt and
   a `rev`, the same shape as `flag_operations`. A deletion for good is a row of the same table with the
   action `purge`, due at once.
9. **The list changes in the same frame as the key** (ADR 0012), before the backend answers, and the
   selection goes to the next older row (the row now at that index), or the last row. This is the app's
   selection, so no read countdown starts (ADR 0039, rule 2). A held row (ADR 0039, rule 8) is not held.
   Whether a row leaves is one pure function of the parsed query and the action: Delete and Spam leave
   every view but those asking for them; Archive and Move leave views that name `in:` or `label:`. A row
   that stays in `All mail` simply stays, and the tray confirms. The rows that left stay away from every
   fetch until the event that carries the commit has been applied, as read state does (ADR 0039, rule 10),
   so neither a slow answer nor an older event brings them back; rows deleted for good stay away until the
   server has confirmed. With labels as the places a view that names a tag (`label:work`) may still
   match a thread that was archived, and its rows then come back at that event. If the store knew less
   than the backend and nothing was left to move, the rows come back and the tray says so.
10. **Undo window: 10 s**, the same as a send, and for the same reason. A row is not due until then. The
    tray shows the draining dot of ADR 0039 and one line per action: *Archived · Undo · 7 s*. `⌘Z` takes
    back the most recent of pending moves and pending sends. Undo deletes the rows and restores what they
    held, and the selection returns to the thread if the reader has not moved on.
11. Rows survive a crash and a quit. Unlike a send, a move left over from a closed app is simply done at
    the next start: nothing leaves the account, and putting it away was the instruction.

### Sync and the server

12. Pending moves go back over every batch, like read state (ADR 0039), at the end of the unit of work.
13. The push uses a new `MailMovePort`, on its own connection, with backoff. Non-Gmail: `MOVE`, which
    `ImapFlow.messageMove` falls back from to `COPY` + `\Deleted` + expunge. That fallback expunges every
    `\Deleted` message of the folder unless the server has `UIDPLUS`, so a server with neither `MOVE` nor
    `UIDPLUS` is refused (the message is put back, rule 15). Before moving, the adapter asks the server
    which of the UIDs are still there: one that is not is *stale*, which is what a repeat after a crash
    looks like. The new location comes from `uidMap` (ADR 0016, rule 5) and replaces the old one in one
    unit of work: the new one is added first, so the message is never without a place, and never deleted or
    downloaded again. Without a `uidMap` the old location stays until the sync that the push requests,
    since removing the last location would delete the message. Gmail: Archive removes the `\Inbox` label,
    Move to a label adds it and removes `\Inbox`, Inbox adds `\Inbox`, and Delete and Spam `MOVE` to
    `[Gmail]/Trash` and `[Gmail]/Spam`, which is what those mean there; mail in Trash or Spam goes back
    by a `MOVE` to All Mail or to the inbox.
14. A target folder that does not exist is created at push time for Archive, Trash and Spam
    (`Archive`, `Trash`, `Junk`), and learned by the next sync.
15. **The server wins** (ADR 0007, rule 4). A refusal puts the message back as it was and the tray says
    why: *Couldn't move: the server refused.* A stale location is left to the next sync, which the push
    asks for. Offline, a vault that cannot answer and a password the server turned down only wait. A newer
    request for the same message replaces the older one, keeping the first "before" state. An account
    that is gone, or has no password (the demo mail), settles its rows quietly and keeps the local state.
    Removing an account discards its rows.
16. Delete forever uses the same queue with no window: `\Deleted` and `UID EXPUNGE` on each location. The
    message leaves the store when the server confirms, or at once if it has no location on the server.
    It is refused in three places, each of which stands alone: the core (`deleteForever` takes only
    messages that are in Trash and have no copy outside a Trash folder, whatever asked), the service when
    the row is pushed (the copies may have changed since), and the adapter (it sends nothing for a folder
    that is not the account's Trash, and needs `UIDPLUS`, since a plain `EXPUNGE` would take other mail).
    Each location is confirmed by asking the server which UIDs are still there; a confirmed location
    leaves the store alone, and the message goes with its last one, with its index entry and body.

### Move to…

17. `v` or the menu opens a small list, in the look of `PopMenu`, with a field that filters as you type
    (names that start with the text first, then those that contain it, accents and case ignored).
    Inbox, Archive, then the account's folders alphabetically. Sent, Drafts and the thread's current
    folder are not offered; whether a place is offered is the same question as whether a move would do
    anything, so the Inbox is always there for a thread in Trash or Spam. `↑↓`, `↵`, `Esc`, all in one
    frame: the list comes from the `folders` table, which the window keeps. For Gmail the table holds the
    folders that are synced (All Mail, Trash, Spam), so its list has no user labels yet.

## Consequences

- Mail can be put away with one key and taken back with another, and it reaches the server by itself.
- `All mail` and search change meaning for everyone: Trash and Spam no longer appear. A person looking
  for a deleted message needs `in:trash`, and the Inbox tab teaches `in:` by being there.
- Each write of labels now also writes a bit set. It costs a few bytes per row and is covered by the
  500k bench, which must stay within budget.
- Without `UIDPLUS` a moved message's location is out of date until the next sync. A flag pushed in that
  gap finds a stale location and is dropped safely by ADR 0039's rule.
- We cannot run Gmail in CI. Its path is tested against a stand-in for the client that records what is
  sent, which shows the commands and not what Gmail does with them. **It has not been run against Gmail**
  and needs checking on a real account before a release.
- A server without `UIDPLUS` cannot say where a moved copy went. The old location stays until the sync the
  push asks for; an inbox watch that syncs the inbox alone in between sees the copy gone, and the message
  leaves the store and comes back with the next full sync (its key is then allocated again, and is the
  same one when nothing else has taken its place in the millisecond). Nothing is lost on the server.
- A thread that is reopened from a view asking for Trash shows deleted mail; a reply to a thread still
  quotes all of it. Replies are not changed here.
- Setting the mailboxes of an account again when its folders change is one statement and holds the writer
  for as long as it runs (120 ms at 100k messages, 600 ms at 500k); it happens at the first sync after
  the migration, and when a folder's role changes.
- The migration itself writes every message once: 0.24 s at 100k and 3.6 s at 500k, at the first launch
  after the update only. At 500k that one launch is over the budget of ADR 0012. It is accepted because it
  happens once and a mailbox of that size has already paid far more for its first sync.
- Plain full-text searches read one message row more per result to apply the Trash and Spam filter, about
  0.05 ms on a query at 500k. They are measurably slower, and still well inside the budget.
