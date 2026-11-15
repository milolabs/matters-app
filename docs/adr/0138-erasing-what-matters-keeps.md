# 0138. Erasing what Matters keeps: one account, or everything

- Status: Accepted
- Date: 2026-11-14
- Amends: [0089](0089-storage-in-settings.md) (Storage gains *Erase everything*),
  [0105](0105-the-app-identity-moves-to-matters.md) (an erase leaves a marker so the earlier
  copy is not brought back in), [0110](0110-one-instance-per-data-folder.md) (an erase order is
  read before the database is claimed)
- Relates to: [0013](0013-dependency-license-policy.md),
  [0018](0018-accounts-credentials-background-sync.md), [0041](0041-attachments-never-block.md),
  [0043](0043-received-attachments.md),
  [0133](0133-microsoft-mail-signs-in-through-the-browser.md),
  [0134](0134-appearance-a-mode-and-themes-that-are-data.md)

## Context

A person must be able to take their mail off a computer for good: before selling it, when leaving
a job, or because they stop using Matters. Today the only way is *Remove account*, and it leaves
things behind. Read from the code on 2026-11-14:

- **Where data lives.** One SQLite file for all accounts (`matters.db` with `-wal`, `-shm` and
  the `.owner` file); the folders `attachments/`, `spool/`, `received/`, `paste/`,
  `compile-cache/`, `themes/`; the files `credentials.json` (encrypted with a key Electron keeps
  in the Keychain as *Matters Safe Storage*), `appearance.json`, `window.json`,
  `notifications-state.json`, `identity-migration.json`; Chromium's own storage in the same
  folder (localStorage keys `matters.*`, caches); and temporary folders `matters-agent-*`,
  `matters-codex-*`, `matters-identity-*` in the system's temp directory.
- **What *Remove account* misses.** `removeAccount` clears messages, the search index, bodies,
  cursors, pending work, attachments, received copies and the credential. It does not clear most
  `agent_*` tables (analyses, journal, talks, ledger, prepared work), and the fate of
  `attachment_text`, `file_fts`, `people`, `counters` and `storage_samples` rows was not traced.
  Deleted rows stay readable in the file's free pages until the database is compacted.
- **No sign-in is ever taken back.** Nothing calls a revoke. Microsoft's identity platform has no
  endpoint with which an app like ours can revoke its own refresh token; the person does it on
  Microsoft's page.
- **The earlier copy.** `~/Library/Application Support/@unclosed/desktop` and the Keychain key
  `@unclosed/desktop Safe Storage` are kept as a backup (0105). At start, `moveData` copies that
  folder in when the new one has no marker saying it is done. An erase that empties the new
  folder would therefore bring the old mailbox back at the next start.
- **What deleting a file means here.** On an SSD with APFS, overwriting a file does not destroy
  the old blocks, and snapshots and Time Machine may hold copies. We cannot promise destruction
  of the bytes; we can promise that Matters keeps nothing and say what is outside its reach.
- **Open files.** While the app runs, the database and Chromium's storage are open, and the
  backend is a separate process. Deleting them from a running app is unreliable.

## Decision

1. **Two acts, in the places people already look.** *Remove account* stays in Accounts and
   becomes complete. *Erase everything* is new, in Storage, as a bar that stays at the bottom of
   the section while the rest scrolls above it. Its button is plain; the red one appears only on
   the confirmation. There is no third level.

2. **Every holding is declared.** `packages/core` gets one list, the *holdings*: each has an id,
   the group it is shown under, how to measure it and how to erase it. A holding is a path under
   the data folder, a path elsewhere (the database when `MATTERS_DB_PATH` points away, temp
   folders), or a Keychain key. The groups are the ones on the review screen: saved passwords and
   sign-ins; mail and the search index; attachments and files; what agents wrote; views, people
   and settings; caches. A test runs a seeded build, lists everything it created in the data
   folder, and fails when an entry belongs to no holding. Adding a store without declaring it
   breaks the build, which is the point.

3. **Erase everything runs at the next start, before anything opens.**
   - Confirming writes an *erase order* (a small file in the data folder: when, and whether the
     earlier copy is included) and restarts the app.
   - At start, after the single-instance claim and before `moveData` and `claimDatabaseFile`,
     the main process looks for the order. If there is one, it does not start the backend, does
     not open the database and opens no mail window.
   - For that run Electron is pointed at a throwaway data folder in the temp directory, so
     Chromium holds nothing open in the real one and the real folder can be removed whole
     instead of file by file.
   - Order of erasing: credentials and the Keychain key first, then the database files, then
     attachments and files, then settings, then caches and Chromium's storage, then temp
     folders, then the earlier copy if asked. The order file goes last.
   - It is safe to interrupt: each step is a delete that can be repeated, and while the order
     exists every start continues it before doing anything else.

4. **The earlier copy is the person's choice, off by default.** The review screen offers it only
   when it exists. Left alone, the erase writes a fresh "done" marker so `moveData` never brings
   it back; that marker (no personal data) is then the one file Matters leaves, and the result
   screen says so. Ticked, the old folder and its Keychain key are erased too.

5. **Remove account removes all of the account.** Every store with rows that belong to an
   account implements a discard for that account, including the agents' tables, the text read
   from files and its index, and people who no longer appear in any remaining mail.
   `removeAccount` calls all of them through the holdings list, so a new table cannot be
   forgotten. Shared things (views, settings, themes) stay.

6. **Freed pages are dropped by compacting, not by `secure_delete`.** After an account is
   removed, the database is checkpointed and compacted (the existing compaction of 0089).
   `PRAGMA secure_delete` would make every delete in normal use slower, and speed is the
   foundation. When the disk has too little free space to compact, the removal still succeeds
   and says that the space, and traces of the removed text, stay in the file until it is
   compacted.

7. **The Keychain key is deleted with the system's own tool.** Electron has no call for it. On
   macOS the erase runs `/usr/bin/security delete-generic-password` for the service name. If the
   Keychain refuses, the key is reported as left; it protects nothing once `credentials.json` is
   gone. On Windows there is no key to delete; on Linux the keyring entry is reported with where
   to find it.

8. **Sign-ins are thrown away, and the screen says what that does not do.** Tokens are deleted
   locally. For Microsoft accounts the review, the result and the account confirmation link to
   Microsoft's page where the person takes the permission back. The exact address is to be
   verified for personal and for work accounts when this is built. If a provider with a revoke
   endpoint is added later, its adapter revokes before the token is deleted.

9. **The words promise only what is true.** The review lists what goes, with sizes measured just
   then, and separately what stays or is out of reach: mail on the servers, the provider's
   permission, files saved elsewhere, backups and snapshots of the Mac, and what agents already
   sent to the AI provider. Nowhere do we say "securely" or "shredded".

10. **Confirmation.** The person types `erase`; Cancel has the focus. Mail waiting to be sent is
    named with its count and is dropped. There is no undo and no cancel once the restart has
    happened.

11. **The result is shown once and kept nowhere.** All gone: what was erased, how much, that it
    was checked (the folders and keys are looked for again), then *Start again* (the first-run
    screen, unchanged) or *Quit Matters*. Something left: each thing with the reason in plain
    words and a way to see it; *Try again*; the order stays, so every start retries. *Leave them
    and start again* removes the order and starts empty with those things still on disk.

12. **Not in this decision.** Encrypting the database so that erasing is deleting a key. It is
    the only strong guarantee on an SSD, it costs speed and a dependency under the license
    policy (0013), and it gets its own ADR. Until then the advice in the docs is FileVault.
    Also not here: deleting mail on the server, and the agent programs' own files outside
    Matters' folders.

## Consequences

- A person can hand a Mac on knowing Matters holds nothing, and reads exactly what is outside
  its reach.
- *Remove account* gets slower on a large mailbox because it ends with a compaction that needs
  free disk the size of the database. Sync waits meanwhile, as in 0089.
- The holdings list is a new thing every adapter author must touch. The test makes forgetting
  loud.
- The start sequence gains a branch before the identity move. It must stay first: anything that
  opens a file before it can make a delete fail.
- Calling `/usr/bin/security` is the first use of that tool; it is macOS-only and can be refused
  by the person or by policy. We report, never retry in a loop.
- After *Leave them and start again*, residue stays that Matters no longer tracks. That is the
  person's stated choice.
- The earlier copy's default (kept) means "Erase everything" can finish with 4 GB of old mail
  still on disk. The review shows it with its size so that this is seen, not assumed.
- To watch: Chromium or Electron adding files to the data folder in a new version (the test
  catches it); Windows file locks; a data folder on a network or external drive.

## How it is checked

- Unit tests for the erase plan: order, repeatability, an interrupted run continued.
- The "nothing undeclared" test of rule 2.
- A smoke run (`tools/smoke-erase.ts`): seeded build with two accounts and a fake earlier copy;
  remove one account and assert no row, file or index entry of it remains and the other is
  whole; erase everything and assert the data folder is gone, the next start is the first-run
  screen and the earlier copy is not brought back.
- Screens: the design boards "Matters — erase data" (Storage entry, review, account removal,
  erasing, all gone, something left), in the app's own tokens, light and dark.

## Appendix: the tables, as built (2026-11-14)

Traced when this was built, from `packages/adapter-sqlite/src/database.ts` (schema 56; 57 added
`location_items`, see the notes below). The list
lives in `packages/adapter-sqlite/src/holdings.ts` (`TABLE_RULES`); a test fails when a table of
the schema is missing from it. Two corrections to the Context above: the agents' rows of a thread
were already removed with an account (`removeForThreads`: analyses, prepared work, feedback,
journal, thread instructions, talks of a thread, prompt verdicts), and people seen only in its
mail were no longer suggested. What was left: the ledger's lines of the account, answers across
all mail that quoted it, the kept bundle reads, prompt searches naming its threads, words of the
index (`message_terms`, and the words in the index's old segments), queued HTML repacking, and
every freed page.

| Scope | Tables | On removing an account |
| --- | --- | --- |
| Account | `accounts`, `message_locations`, `location_items`, `message_refs`, `folders`, `cursors`, `drafts`, `send_operations`, `flag_operations`, `move_operations`, `attachments`, `agent_ledger`, `agent_consents` | `DELETE … WHERE account_id` (`id` for `accounts`) |
| Account, by its store | `messages` | `removeAccountMessages` (tombstones and index entries with it) |
| Account, by cascade | `message_labels`, `message_attachments`, `attachment_text` | foreign key on `messages`, `ON DELETE CASCADE` |
| Derived, by the stores | `body_blocks`, `body_index`, `html_blocks`, `html_index`, `html_kinds`, `message_fts` (and its `_data`, `_docsize`, `_idx`), `file_fts` (and its shadow tables), `file_starts` | `removeBodies`, `removeMessages`, the trigger `file_index_gone`; then both indexes are merged (`optimize`) so removed words leave their segments |
| Derived, pruned | `agent_analyses`, `agent_prepared`, `agent_feedback`, `agent_journal`, `agent_instructions` (a thread's), `agent_talk`, `agent_prompt_verdicts` | rows of a thread with no message left |
| Derived, pruned | `agent_talk` across all mail, `agent_talks` | every agent answer across all mail goes, whatever it cites (see the notes); the person's question stays; an empty talk goes |
| Derived, pruned | `agent_prompt_searches` | a kept search naming a thread with no mail goes; the next run makes it again |
| Derived, cleared | `agent_bundle_reads` | a cache of what a model said; read again when needed |
| Derived, rebuilt | `people`, `people_words` | built again from the mail that stays |
| Derived, rebuilt | `message_terms` | built again from the merged index |
| Derived, pruned | `html_repack` | keys with no message left |
| Shared | `saved_views`, `view_searches`, `image_rules`, `image_setting`, `agent_rules`, `agent_settings`, `agent_runtime_records`, `storage_samples`, `counters`, `html_repack_state`, `removed_messages`, `schema_version`, `sqlite_sequence`, `*_config` | stay: the person's own, or numbers with no mail in them (`removed_messages` holds keys only, for the change feed) |

Then the database is checkpointed and compacted when the disk has room for the rewrite (rule 6);
a test on a real file finds none of the removed account's words in the file's bytes afterwards.
The account's colour in localStorage goes with it too.

## Notes as built (2026-11-14)

- Microsoft's pages (rule 8) are one constant, `MICROSOFT_PERMISSION_PAGES` in
  `packages/core/src/domain/providerPermission.ts`. For work and school accounts Microsoft's own
  support article names My Apps, `https://myapplications.microsoft.com/`. For personal accounts
  `https://account.live.com/consent/Manage` is named only by community and third-party guides; it
  is marked unverified there. A password account grants no permission and gets no link.
- The erase window cannot read the accounts (nothing opens the database), so the order carries
  the names of the provider pages to show, never an address.
- Only the person's own run (a packaged app on the real folders) asks the Keychain. Dev, test and
  smoke runs leave every Keychain item alone; a smoke run uses a fake key store.
- On Windows the single-instance lock is a file held open in the data folder; it cannot be removed
  by the run that holds it and would be reported as left. Not tried on Windows or Linux.
- Built before Microsoft sign-in (0133, 0136) reached main and rebased onto it the same day. The
  provider links of rule 8 are now live: whether an account signs in through Microsoft is read
  from what the account already records, its transport and its server
  (`browserSignInProvider`, the same answer the Accounts pane uses), by `signInKind` and
  `accountPermissionPages` in `providerPermission.ts`. `AccountInfo` gains no field for it. A
  Graph account, or one on Microsoft's IMAP servers, gets the link in the account confirmation,
  the erase review and the result screen; any other gets none.
- Rewritten after review (2026-11-15): the account kind is not read from the address any more.
  A personal Microsoft account may use any address (a Gmail one, say), and nothing the account
  records says which kind it is: the sign-in's token is not kept past setup, and setup records no
  tenant. So `accountPermissionPages` gives the personal page alone only for an address on
  Microsoft's own personal domains (outlook, hotmail, live, msn), which no organisation can claim,
  and both pages, each named for whom it is, for any other address.
- What Microsoft sign-in keeps was traced: its tokens live in the vault (`credentials.json`,
  already the holding `secrets.vault`); the sign-in and Graph adapters write no file, folder or
  temp folder of their own. Migration 57 added the column `accounts.transport` and the table
  `location_items` (a Graph copy's handle), declared with scope account and discarded by
  `account_id`; `removeAccountMessages` clears it as well. The removal test seeds it for both
  accounts.

## Notes after review (2026-11-15)

The principle: the erase order goes only when every final outcome is known and nothing is left,
and an error is never read as "gone" or "absent".

- **Reading the order has three outcomes, which the start cannot confuse** (a tagged result).
  Nothing there (ENOENT, ENOTDIR): a normal start. An order read, including one that is there but
  cannot be parsed: an erase, without the earlier copy, the safe default (the file is there, so
  the person confirmed). Any other failure (EACCES, EIO, ...): whether there is an order is not
  known, and a read error proves no confirmation, so the start neither erases nor opens anything:
  no backend, no database, no mail window, nothing deleted. On a throwaway Electron data folder,
  the erase's window says that Matters could not read its folder, why in plain words, and where,
  with *Try again* (which reads again and, once the answer is known, starts afresh) and *Quit
  Matters*. An earlier version of this note treated such a failure as an order; that would have
  let an unreadable folder delete the Keychain key and whatever else it could reach.
- **A look that fails is a thing left.** `EraseFs.entry` and `list` throw on anything but "not
  there"; the holding is then reported left with the reason, and the order stays.
- **Keys are checked as they are erased,** not after the order went: a key the store says it
  deleted but still lists is left before the order is decided.
- **When anything is left, the sweep of undeclared entries does not run:** it would take what was
  left, a database another run owns included. It runs on the try that finds nothing left.
- **`runErase` does not throw.** A marker that cannot be written is reported left and the order
  stays; a run that breaks off anyway is shown as one thing left, with *Try again*.
- **Rule 4 holds on every path.** *Leave them and start again* writes the "done" marker first
  whenever the earlier copy (or part of it) is still there; when the marker cannot be written,
  or the order cannot be removed, the order stays and the next start erases again.
- **A database a live run owns is not erased (ADR 0110).** `MATTERS_DB_PATH` can share one
  database between two data folders, whose locks differ. Before deleting the database's files the
  erase takes its owner file with the same claim a normal start takes; when another live run
  holds it, each of its files is left with the reason "another copy of Matters has this mailbox
  open". The claim is held from the database step until the data folder has been swept: released
  earlier, another run could claim the database in between and write an owner file and database
  files the sweep would then delete. The sweep passes over the claim's own owner file; that file
  goes last of all the erase deletes, by releasing the claim, and is then looked for again (a look
  that fails is a thing left), before the order. On every other way out (something left, a step
  that breaks off) the claim is released too, and only the erase's own file is ever removed. The
  data folder itself goes after the order, and only while it is empty, so what a run started
  after the release has written keeps it. While the claim is held, no delete of the run (a
  declared holding or the sweep) takes the owner file or a folder above it, compared by real path
  as the guard compares: such a folder (a database at `<data>/shared/mail.db`) is emptied around
  the file instead, is not counted as left, and goes after the release, deepest first, only while
  empty and through the guard.
  The claim is taken before the first deletion of the run (taking it deletes nothing; sign-ins
  still go first), and the rule covers the database's whole family (the database and every
  declared suffix, the owner file included) and the folders above it: under the erase's own claim
  until the release, and for the whole run when another live run holds it, whose files are then
  each left once as in use and nothing is swept. Otherwise a sign-ins holding, or a declared
  folder such as `<data>/attachments/` holding a database another run owns, would take it.
- **Rule 7's words on a refused key are not on the screens.** The key protects nothing only once
  `credentials.json` is gone, and that file can be left in the same run; the result names the
  key and where to delete it, and promises nothing about it.
- **Compaction asks for twice the database (rule 6),** with its log: VACUUM writes a temporary
  copy and then the log of the rewrite. A checkpoint a reader kept from truncating the log (the
  log still holds removed pages) makes the compaction `failed`; the removal itself holds.
- **Answers across all mail go whole on any removal (rule 5).** An answer can carry mail in
  facts (senders) that name no thread, and in text the agent wrote from what it searched; which
  account a fact came from is not kept. Deleting answers too many is preferred to keeping one
  that may quote removed mail. The person's questions stay, and so do the talks of a thread.
- **Microsoft's personal domains are an exact list** (outlook.com, hotmail.com, hotmail.co.uk,
  live.com, msn.com), compared on the whole domain without case. A pattern such as `outlook.*`
  also took `outlook.example.com`, whose work accounts would have been shown the personal page
  alone. A domain missing from the list gets both pages, which is the safe side.
