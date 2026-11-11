# 0105. The app identity moves to Matters

- Status: Accepted
- Date: 2026-11-10

## Context

ADR 0072 renamed everything a person can see and kept the app identity on the old name on
purpose: the desktop package was still called `@unclosed/desktop`, and Electron derives two things
from that name. The userData folder was `~/Library/Application Support/@unclosed/desktop` (a 3.8 GB
database, its write-ahead log, received files, window and notification settings, the page's
localStorage) and the macOS Keychain item that holds the key of the saved passwords was
`@unclosed/desktop Safe Storage` (account `@unclosed/desktop Key`). The database file was
`unclosed.db` and the page kept its settings under `unclosed.*` keys.

Changing the name alone would start the app on an empty folder with a new Keychain item: the
mailbox would look gone and every password would be asked for again.

What we checked on Electron 45.2.1 on macOS, with throwaway app names and the real Keychain:

- `app.setName(name)` before ready selects the Keychain item `"<name> Safe Storage"` (account
  `"<name> Key"`), and a blob encrypted under one name does not decrypt under another.
- Called after ready, `app.setName` no longer changes the item: the process keeps the one it
  started with. One process cannot read with the old key and write with the new one.
- With `productName` in `package.json`, the name, the default userData folder and the Keychain item
  all follow `productName`.
- Chromium creates nothing in the default userData folder before the main script runs;
  `app.getPath("userData")` itself creates the folder, empty.
- A top-level `await` before `app.whenReady()` in the ES module main script never lets the app
  become ready; the helper below therefore uses `then`.

## Decision

The desktop package is `@matters/desktop` with `productName` `Matters`: userData is
`~/Library/Application Support/Matters` and the Keychain item is `Matters Safe Storage`. The
database file is `matters.db`, the localStorage keys are `matters.*`. A one-time move carries the
old identity's data and passwords over, so nobody signs in again.

The move holds five rules, in this order of importance:

1. **The old folder and the old Keychain item are never modified or deleted** by any code. They
   are the backup. The old database files are only read to be copied, never opened as a database.
2. **No half-moved state is ever visible as done.** The copy is built in a sibling folder
   (`Matters.migrating`) and renamed into place in one step, with its marker
   (`identity-migration.json`) already inside. A crash during the copy leaves a staging folder that
   the next start throws away and builds again. The marker's states are `fresh`, `kept-existing`,
   `credentials-pending` and `done`; every step can run again from its start.
3. **Plain-text passwords never touch disk** and never appear in a log, in argv or in the
   environment.
4. **Runs with data of their own behave as before.** A fresh install (no old database and no old
   passwords) only writes the marker `fresh`. A run with `MATTERS_USER_DATA` or `MATTERS_DB_PATH`
   (dev, smoke, tests) never looks at the real old folder. A dev build may point the move at a
   pair of folders of its own with `MATTERS_OLD_USER_DATA` and `MATTERS_USER_DATA` together; a
   packaged build ignores both.
5. **Failure is loud and safe.** If a step fails, the app says what failed in a dialog, leaves the
   old data as it is and quits; the next start tries again. It never opens on an empty mailbox as
   if nothing happened.

The move has two steps.

**The data, before ready.** Before Chromium has created anything in the new folder, main copies
the old folder synchronously with `COPYFILE_FICLONE` (an APFS clone, a real copy elsewhere) and
fsyncs each file. Caches, locks and what lives for one session stay behind (`Cache`, `Code Cache`,
`GPUCache`, `GPUPersistentCache`, the Dawn and Graphite caches, `ShaderCache`, `Shared Dictionary`,
`compile-cache`, `blob_storage`, `Session Storage`, `Singleton*`); everything else is copied,
including what we cannot prove to be regenerable. The three `unclosed.db*` files become
`matters.db*` together. The old `credentials.json` is copied as `credentials.unclosed.json`, a name
the credential store never reads, so a failed second step can never look like "no passwords
saved".

The old app must not be running with its database open. Before copying, main asks the system who
has the old database files open (`lsof` on macOS, `/proc` on Linux) and refuses with "quit the
other copy" if any process does. After the copy it asks again and compares the size and time of
the old database files with what they were before: if anything changed, the copy is thrown away.
Windows has no probe here and relies on that second check.

A new folder that already holds a mailbox (with no marker) is never copied over: both folders stay
as they are, the person is told once (marker `kept-existing`), and the app starts with the new
folder. Only a mailbox counts: `matters.db` or its `-wal`/`-shm`, `credentials.json` or
`credentials.unclosed.json`. Anything else in a new folder without a marker is what a start that
never got going left behind (a refusal, a failure, a crash, a quit during a long copy; Chromium's
`Local State`, `Preferences` and the like). It is not deleted and it does not block the move: once
the copy is complete and both probes have passed, it is renamed aside to
`Matters.set-aside-<time>` next to the new folder, one `matters-identity:` line says so, and the
copy takes its place. A refused or failed move leaves it exactly as it was; a set-aside that fails
is a failure like any other, reported and retried. Removing a set-aside folder is a manual step.

What a refused start leaves in the new folder: in a smoke run (no dialog) nothing at all, not even
the folder, because a userData set with `app.setPath` is not created by `app.getPath`. A normal
refused start, which shows its dialog before ready, was not observed on the development machine
(the dialog would have blocked on the owner's screen); the rule above does not depend on it.

**The passwords, after ready and before the credential store is first used.** The key of the old
item can only be had by a process that took the old name before ready, so main starts a helper:
the same executable (plus the app path in a dev build) with `--matters-identity-helper`. In that
mode main does nothing else: it checks its arguments, calls `app.setName("@unclosed/desktop")`,
uses an empty scratch userData that its parent made in the temp folder, opens no window, decrypts
`credentials.unclosed.json` through `safeStorage` and writes the plain values, once, to file
descriptor 3, a pipe its parent made. Nothing goes to stdout or stderr. The parent encrypts them
again with its own `safeStorage` (which creates `Matters Safe Storage`), writes `credentials.json`
in one atomic replace, reads every password back, and only then sets the marker to `done` and
removes the staged copy. A smoke run's `--use-mock-keychain` is passed on to the helper.

The helper answers only when file descriptor 3 is a pipe, when the vault it is given is the staged
copy, and while the marker next to it says the passwords are pending. Once the move is done it
decrypts nothing, whoever starts it. It is not a boundary against other code running as the same
user: such code can already run the app's executable, and in a dev build any script under
Electron's own signature reads the old item the same way.

A password that does not decrypt under the old name either is dropped (the old app would have asked
for it again). If none of them decrypts, nothing is written and the step fails: that is the old
Keychain item refusing, not a password to forget.

We do not copy the Keychain secret itself with the `security` command-line tool. It reads the item
outside the API that owns it, shows the person a Keychain prompt for a tool they do not know, and
would put the key in a child process's output. The helper keeps the secret inside `safeStorage` on
both sides.

**localStorage, at page start.** The first module of the mail window and of the settings window
(`keyRename.ts`) copies every `unclosed.*` value to its `matters.*` key and removes the old key,
synchronously, before any module reads one. It never overwrites a `matters.*` value that is already
there and never throws. `unclosed.imagesFrom` keeps its name: it is the input of an older migration
(ADR 0037), which still reads it under that name.

The pure logic (what is copied, the state machine, the key rename) lives in
`apps/desktop/src/main/identityMigration.ts` and `apps/desktop/src/renderer/keyRename.ts`, with the
file system and the probe passed in; the Electron side (the helper, the probe) is
`identityHelper.ts`, and `index.ts` only wires them. `tools/smoke-identity.ts` runs the whole move
against temporary folders.

## Consequences

- The old folder and the old Keychain item stay behind as a backup, 4 GB of it. Removing them is
  a manual step for the person, once they trust the new folder; the app never offers to do it.
- While the old app is open, the new one refuses to start until it is quit. A person with both on
  the screen sees one clear message, not two apps syncing one mailbox.
- The first start after the update takes longer: the copy (an APFS clone is quick, a real copy of
  3.8 GB is not) and one short-lived helper process. Only the first one.
- A later packaged build signed with another identity than the binary that created the old item
  gets one Keychain prompt in the helper ("Matters wants to use … `@unclosed/desktop Safe
  Storage`"); the helper waits up to two minutes for it. A dev build runs under Electron's own
  binary and gets none.
- If the old Keychain item is missing while old passwords exist, Chromium creates an empty item
  under the old name in the helper; the passwords cannot be decrypted, the step fails loudly and
  says so.
- Older ADRs keep their text; ADR 0072 points here.
