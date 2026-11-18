# 0145. Save a message as a file, and back up and restore what Matters keeps

- Status: Accepted
- Date: 2026-11-16
- Amends: [0089](0089-storage-in-settings.md) (Storage gains Backups),
  [0110](0110-one-instance-per-data-folder.md) (a waiting restore is swapped in after the
  database's claim, before anything opens it), [0113](0113-a-refused-password-is-mended-in-place.md)
  (rule 2: an account with nothing saved on this Mac is refused as `notSaved`, and its row says
  so beside its button), [0138](0138-erasing-what-matters-keeps.md) (a holding more: the `restore` folder),
  [0144](0144-print-a-thread-or-save-it-as-a-pdf.md) (rule 1: Save as .eml… beside Print… and
  Save as PDF…)
- Builds on: [0006](0006-sqlite-storage-and-search.md), [0012](0012-performance-budgets.md),
  [0041](0041-attachments-never-block.md), [0043](0043-received-attachments.md),
  [0136](0136-microsoft-mail-moves-over-microsoft-graph.md)

## Context

Read from the code on 2026-11-16:

- A message cannot leave Matters as a file. Matters keeps a message's text and sanitized HTML,
  not its source (ADR 0045), so the source is on the server only.
- Received files are fetched on demand over a connection of their own, in the sync worker, at
  most two at a time per account (ADR 0043, rule 6), through `MailAttachmentPort`. ImapFlow's
  `download(uid)` with no part asks for `BODY.PEEK[]<start.length>` in 64 KB pieces and passes
  them on with no decoding. Graph gives a message's MIME at `/me/messages/{id}/$value`; the Graph
  adapter already fetches it to cut a part out of it, whole, in memory.
- There is no copy of the database. It is one SQLite file in WAL mode (ADR 0006), written by the
  sync worker and read by the router and the read thread.
- `node:sqlite` in Electron 45 (Node 24.22, SQLite 3.53.4) has `backup()`, `enableDefensive()`,
  `setAuthorizer()` and the constructor options `readOnly`, `allowExtension` (off by default) and
  `defensive`. It has no interrupt and no progress handler.
- Measured with `tools/bench-backup.ts` on the generated mailboxes of the launch benchmark (warm
  page cache, M-series SSD, this machine):

  | Mailbox | Database | Copy (`VACUUM INTO`) | Peak memory of the copy | Log during the copy | Write batch p50/p99 before → during | Restore check |
  |---|---|---|---|---|---|---|
  | 100,000 | 376 MB | 0.6 s, 364 MB | 119 MB | 5 MB | 2.4/14.4 → 0.6/2.5 ms | 1.7 s |
  | 500,000 | 1,844 MB | 2.1 s (2.2 s while writing), 1,785 MB | 119 MB | 18 MB | 1.6/12.5 → 0.6/2.1 ms | 10.3 s |

  The writes were 200 rows of 2 KB every 50 ms on the writer connection, as a sync writes. The
  "during" batches are not slower; the first batches "before" include warming up.
- The online backup API with steps (`backup()` with a page rate) restarts from the beginning when
  another connection writes. On the 100,000-message database with writes every 5 ms it restarted
  5,174 times in 20,000 steps and never finished.
- A database in WAL mode opens read-only only beside its `-wal` and `-shm`; `VACUUM INTO` writes a
  file in rollback mode (header bytes 18 and 19 are 1).
- Credentials live in the vault in main, one per account id (ADR 0018). An account with no
  credential at all failed with `CredentialsUnavailableError` (`kind` "credentials"), shown as
  *Password unavailable*: no form opened and nothing said how to mend it.

## Decision

### A. A message as a file

1. **Save as .eml…** acts on the thread open in the reader. It sits in the File menu under Save as
   PDF…, and in the reader's More menu under Save as PDF…, with the same icon, on the same terms as
   ADR 0144 rule 1: on while one thread is open and no rows are chosen, from the mail window only.
   One letter: the system's save dialog (Downloads, as for attachments), one `.eml`. Several: a
   folder dialog, one `.eml` per letter. No mbox in this step: a file per message opens in every
   mail program, while mbox has several dialects (how `From ` lines are escaped, how a message
   ends) that programs read differently.
2. **The file is the message as the server has it**, fetched when asked, since Matters keeps no
   source: `MailAttachmentPort.source(location)`, IMAP `BODY.PEEK[]` in pieces (never sets
   `\Seen`, and the folder is opened read-only), Graph `$value` (reading it does not mark it read).
   Over Graph the bytes are the MIME Exchange writes for the message, which may differ from the
   bytes that arrived; the file says what the service gives. It is streamed from the socket to the
   file a chunk at a time; **there is no size limit**: the server's own limit bounds a message, and
   nothing holds it whole. Matters never opens, parses or renders the file after writing it. It is
   written as a received file is: a temporary name beside the target (`.<name>.part-<random>`,
   made with `wx`, mode 0600, so no execute bit and nobody else reads it), flushed, then renamed
   to the name; never outside the place the dialog returned; marked as from the internet
   (`com.apple.quarantine`, ADR 0043 rule 14). One file: the dialog asked before replacing. A
   folder: **nothing there is replaced**; a name that is taken gets ` 2`, ` 3` before `.eml`
   (ADR 0043 rule 13), and a name taken between the look and the write is refused by the write
   (a hard link that takes the name only if it is free) and the next number is tried.
3. **When it cannot be fetched**, one phrase on the line under the window where print's failures
   show: no longer on the server (also a message no folder of the account still has), the server
   could not be reached, the account needs its password or sign-in again, or it could not be
   written. For a folder: `2 letters of 3 saved. 1 letter not: no longer on the server.` A
   letter of our own that was never on a server is not in the thread's letters (the outbox is not
   the thread), so it is never offered.
4. **Names**: `emlFileName(subject, day)`, by the rules of the PDF's name, which now share one
   function (`subjectFileName` in `fileName.ts`). In a folder, `emlFolderNames` starts each name
   with its place, padded to the same width (`01 Lunch 2026-11-14.eml`), so the folder sorted by
   name reads the thread in order and no two names are the same.
5. **Never blocks.** The fetch runs in the sync worker over a connection of its own, like a
   received file's download; progress is throttled to four a second and goes to main, which tells
   the mail window: `Saving letter 2 of 5 · 14 of 34 MB` with **Stop**. Stop aborts the fetch and
   the write; the temporary file is removed and the letters after it are not started. Quitting
   aborts it the same way. One save at a time.

### B. Backing up and restoring

6. **Back Up…** in Settings › Storage › Backups. The person chooses where (Documents, named
   `Matters backup 2026-11-16.db`). A process of its own (`backupWorker.ts`, a utility process
   started for the job) runs `VACUUM INTO` on a read-only connection: one read transaction, so the
   copy is one moment of the database while sync goes on writing; the copy has no free pages and
   no log, and its temporary data goes to files, not memory. The file is written under a
   temporary name beside the chosen one, made empty with mode 0600 first, flushed after, then
   renamed. **Stop** ends the process at once, whatever SQLite is in the middle of, and the
   temporary file goes; so does a failure. The window shows the bytes written while it runs.
7. **What is in it, said before it is written**: all mail Matters keeps (text, HTML, the search
   index), drafts and mail waiting to be sent, views, settings kept in the database, what agents
   wrote. **What is not**: passwords, sign-ins and API keys (the vault is never copied),
   downloaded attachments and the received cache, kept copies of draft files and spools, your own
   themes, and the files beside the database (`appearance.json`, `window.json`,
   `notifications.json` and its state, the newer-version file): the database only, in this step.
   And plainly: **the file is not encrypted; anyone who can read it can read the mail.** Mode
   0600.
8. **Restore from a Backup…** The chosen file is untrusted. It is copied into the data folder
   (`restore/incoming-<random>.db`, mode 0600) and only that copy is read; a WAL header on the
   copy is set to rollback so it opens read-only alone. The worker opens it read-only,
   `allowExtension: false`, `defensive: true` plus `enableDefensive(true)`, `trusted_schema = OFF`,
   `cell_size_check = ON`, `mmap_size = 0`, `query_only = ON`, and an authorizer that allows only
   `SELECT`, reads, functions and a fixed list of pragmas. It then reads, in this order: the
   header (`SQLite format 3`); `sqlite_schema`, which runs nothing of the file's; that
   `schema_version` is our plain table; the version (newer than this build is refused); **the
   schema compared object by object with the schema our own migrations make for that version**,
   built in memory by running them (`expectedSchema`), not kept by hand: type, name, table and
   statement (white space aside) must match, and any object we do not make (a trigger, a view, an
   index, an index on an expression, a virtual table, a table) or make otherwise, or one of ours
   that is missing, is a refusal. SQLite's own `sqlite_sequence` and statistics tables are allowed
   with SQLite's own statements. Only then `PRAGMA integrity_check`. Each refusal is one phrase.
9. **Restoring never destroys.** A restorable copy is made ready at once, while the window is
   open: older versions are carried forward by the normal migrations (a failure is told now, not at
   the next start), and it is left as one file in rollback mode. It becomes `restore/pending.db`
   with `restore/pending.json` (the set-aside folder's name, the accounts to hold, counts). The
   window says what it will do and offers **Restart to Restore** and **Cancel Restore**; quitting
   is the normal quit. At the next start, inside the single-instance lock and after the database's
   claim (ADR 0110), before the backend starts, `swapPendingRestore`: the accounts to hold are
   written to `restore/held.json`; the database's set (`-wal`, `-shm`, `-journal`, then the file)
   is moved into `restore/set-aside/<time>/`, so no log is ever left beside a database it does not
   belong to; `pending.db` takes the database's name; the notes go. Each step can be repeated, so
   a start that breaks off is continued by the next. When a step fails, what was moved is put back
   and `held.json` is as it was: the current database stays and the restore still waits. With no
   restore waiting, the start pays one `stat`. After a swap the received cache is emptied: it is
   keyed by message keys, which the restored database gives out on its own.
   The set-aside database is kept until the person removes it: Storage lists it with its date and
   size, **Put Back…** restores it the same way (its log checkpointed into it first, then the same
   checks), **Remove…** asks first. Erasing everything removes the `restore` folder and the review
   names what a restore set aside or waits to put in place.
   **Credentials**: a backup carries none; accounts are whatever the vault on this Mac holds for
   their ids. An account of the backup whose id is here too but whose server, user name, address or
   transport differs from the account here is held back (`accountsToHold`): main answers it as
   having nothing saved until a new password or sign-in is saved for it, so a backup cannot send
   this Mac's password for an id to another server. An account with nothing saved (held, or simply
   not in this vault) is refused as `notSaved` ("This Mac has no password saved for this account,
   as after a restore from a backup. Enter it to sync again."), marked like a refused password so
   nothing logs in with it on its own (ADR 0113, rule 4). Its row says that sentence with *Change
   password* (or *Sign in again* for a browser sign-in) beside it, and a new one verified and saved
   ends it. Unlike a refused password the form does not open by itself: every account of the demo
   mailbox and of window tests has nothing saved, and a form over each would be noise. Before
   this, such an account said *Password unavailable* and nothing on how to mend it.
   **Sync after a restore** goes on from what the restored database knows, as after an app closed
   since then: IMAP compares UIDVALIDITY per folder and starts the folder afresh when it changed;
   with CONDSTORE it asks for changes since the stored modseq; expunges come from QRESYNC
   `VANISHED` only when the counts agree, otherwise from comparing `UID SEARCH ALL` with the stored
   UIDs (`adapter-imap/src/sync.ts`); Graph lists a folder anew when its delta link has expired
   (`isExpiredSync`, ADR 0136 rule 5). No new handling was needed.
10. **The outbox on restore**: mail that waited to be sent in the backup (`pending`) is **held**,
    with the warning "Restored from a backup. It may have been sent after the backup was made, so
    it waits for you." Nothing is sent by a restore; the person sends or discards each. A send that
    was being handed off is settled at start as any interrupted send is (held, or unknown and
    reconciled against Sent). Read state and moves that waited are pushed as they would have
    been; one the server already has changes nothing.
11. **Not in this decision**: scheduled or automatic backups, encrypted backups, backing up
    attachments' files and the vault, exporting a whole mailbox or folder, mbox, importing `.eml`
    or mbox into Matters, restoring into a build older than the backup.
12. **Where it lives.** Core: the names (`fileName.ts`), the rules of a backup (`backup.ts`:
    `compareSchema`, `judgeBackup`, `accountsToHold`, the phrases), `MessageSources`, the ports
    (`MailAttachmentPort.source`, `SourceFilesPort`, `DatabaseBackupPort`), the `notSaved`
    refusal. Adapters: `source` in IMAP and Graph (`GraphClient.stream`), the writer
    (`adapter-files/src/sources.ts`), the copy, the checks and the preparation
    (`adapter-sqlite/src/backup.ts`). Backend: `saveSource`/`stopSource` in the sync worker, which
    only main's own line may ask (a page cannot send a path); `backupWorker.ts`. Main: the dialogs
    and the jobs (`emlSaves.ts`, `backupJobs.ts`), the swap and the folders (`restore.ts`), the
    hold (`restoreHold.ts`), the menu. Preload: `emlBridge.ts`; Storage's bridge gains its
    actions. Renderer: `emlSave.ts`, `backupView.ts`, `backupSection.tsx`.
13. **Tests.** The contract of `source` (`describeMessageSourceContract` in testkit: byte for
    byte, not marked read, gone) runs against the fake, IMAP on hoodiecrow, IMAP on Dovecot
    (`test:imap`) and Graph on its stand-in. Unit: names and order, the collision rule, a stopped
    or broken write leaves nothing, the job (stop, busy, summaries); a backup taken while a
    transaction is open is the moment before it and passes the checks, 0600; refusals (not SQLite,
    damaged, foreign, newer, a trigger, a view, a table, an expression index, a virtual table, our
    trigger with another body, a missing index), versions 1, 20, 40, 56 and 59 of ours pass, an older one
    is carried forward, the outbox held, the swap (one look when nothing waits, the set moved
    together, a failure put back, a broken-off swap continued), set-aside listing and removal, the
    hold of credentials, a full back-up/change/restore/swap/put-back run with the real adapter. Window
    tests on the demo mailbox (`eml.e2e.ts`, `backup.e2e.ts`) through dev-build stand-ins for the
    dialogs (`MATTERS_TEST_SAVE_DIR`, `MATTERS_TEST_BACKUP_PATH`, `MATTERS_TEST_RESTORE_PATH`) and
    for the relaunch (`MATTERS_TEST_NO_RELAUNCH`); a packaged app reads none. `smoke-erase` checks
    that the `restore` folder is declared and erased.

### Not tried, and why

- **The online backup API in steps.** It restarts on every write of another connection: under a
  sync it may never finish (measured above). In one step it is `VACUUM INTO` without the
  compaction and still cannot be stopped.
- **The backup on the writer connection**, where steps would not restart: it would hold the
  writer, which sync and every change wait for.
- **Copying the database file and its log.** Not consistent while the writer writes, and the log
  would have to be checkpointed by a connection we do not own.
- **Swapping the database while it is open.** The backend, two threads and their statements hold
  it; a restart is the honest point.
- **Trusting a backup because it has our version number.** A crafted file can carry triggers that
  run inside our own writes later; the comparison of the whole schema is the defence.

## Consequences

- A message can be kept or handed on as a file every mail program opens, and Matters' mail can be
  copied and brought back.
- A backup is as large as the mail Matters keeps (1.8 GB for 500,000 messages) and needs that much
  free disk where it goes. Checking a backup of that size takes about ten seconds.
- A backup on a disk others can read hands them the mail; the window says so.
- A restore costs a restart and leaves the database before it on disk until removed. Draft files
  kept for the database set aside may be swept by the restored one, so putting it back can find
  them missing; the composer then says so (ADR 0041).
- The demo account and any account with nothing in the vault now say *No password on this Mac*
  and the sentence in Settings › Accounts, where they said *Password unavailable*.
- A database that went through migrations differently from a fresh one (a dev branch that numbered
  a migration otherwise) has another schema text and its backup is refused as not ours.
- Not verified: a real IMAP or Graph account, a real 500,000-message mailbox (only the generated
  one), a cold page cache, a restore on a real data folder, a backup to an external or network
  disk, Windows and Linux.
