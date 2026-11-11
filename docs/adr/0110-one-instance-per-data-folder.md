# 0110. One running copy per data folder

- Status: Accepted
- Date: 2026-11-10
- Amends: [0105](0105-the-app-identity-moves-to-matters.md) (the move keeps this start's lock),
  [0107](0107-matters-runs-on-macos-as-its-own-app.md) (the bundle and a dev run no longer both
  open one folder)

## Context

- **Nothing stopped two copies.** The bundle `dist/Matters.app` and `electron apps/desktop` use the
  same userData, database and Keychain item (ADR 0107, rule 4). `open -n`, a second dev run or the
  bundle started next to a dev run each opened the same SQLite database and started their own
  sync. Two routers writing one mailbox, each with its own idea of what is pending, can lose work.
- **Electron's lock is keyed on userData.** `app.requestSingleInstanceLock()` takes Chromium's
  process lock in the userData folder as it is when the call is made. A second call on the same
  folder fails, and the first process gets `second-instance`. A crashed holder is recognised: the
  lock names a host and a pid, and a pid that is gone is taken over.
- **The database can live elsewhere.** `MATTERS_DB_PATH` (honoured in every build) puts the database
  anywhere; `MATTERS_USER_DATA` (unpackaged builds, the bundle included) moves userData. So two
  processes can have different userData folders and one database, which the userData lock does not
  see.
- **The identity move runs before ready** (ADR 0105) and fills the new userData folder by renaming
  a complete copy into place. Leftovers in that folder are set aside first.
- **The app reads nothing from its command line.** It registers no URL scheme and handles no
  `open-url` or `open-file`; a mailto link is opened by the system for another app (ADR 0048).

## Decision

1. **The userData lock comes first.** Right after `MATTERS_USER_DATA` is applied and before
   anything reads or writes the folder (the identity move included; on Windows right after it, see
   Consequences), main asks for the single-instance lock. Without it the start writes one line (`matters-instance: …`) to stderr
   and exits with 0: before the database, the backend, the credential store and the Keychain.
2. **The first copy comes forward.** On `second-instance` the mail window is restored if it is
   minimised, shown if it is hidden, and focused; on macOS the app is also unhidden and activated.
   Before the window's first reveal (ADR 0103) nothing happens: it shows itself when the mail is
   in it. The second start's argv and working directory are not read, because the app opens
   nothing from them; a later decision that adds a URL scheme or file opens forwards them here.
3. **The database has an owner file.** After the identity move and before ready, main writes
   `<database>.owner` next to the database: pid, the process's creation time, the host name, a
   random token, and the userData folder. It is created only if it is not there (written aside and
   hard-linked into place, so it is never seen half written). Main removes it on quit, and only if
   it still holds its own token.
4. **An owner file that is there is judged.** It is stale, and taken over, when
   - its process is gone,
   - its pid is this process's own, or belongs to a process created at another time (more than 5 s
     apart; `ps -o etime=` on macOS and Linux),
   - where no creation time can be read (Windows), it was written before the machine last started,
   - it cannot be read and is at least 10 s old.

   Everything else is held: a live process, a younger unreadable file (a start in progress), a file
   written on another host. A held database stops the start with a dialog that names the other
   copy's data folder, the database and the owner file to remove if no copy runs anywhere, and an
   exit code of 1 (a smoke run gets only the stderr line).
5. **Taking a stale file is race-safe.** The stale file is renamed to a name of this start's own,
   so of two starts that judged it stale only one moves it; if what was moved is not the file that
   was judged, it is put back, and the start looks again. Five tries, then held.
6. **The identity move keeps this start's lock.** `SingletonLock`, `SingletonCookie` and
   `SingletonSocket` in the new folder are this start's, not leftovers: they move into the copy
   before it is renamed into place, and back if the move fails. An owner file in the old folder
   stays behind like the old app's own locks.

## What happens

| userData | database | result |
| --- | --- | --- |
| same | same (the default) | the second start exits at once; the first comes forward |
| same | different (`MATTERS_DB_PATH`) | the same: the vault, attachments, received files and spool live in userData, so one folder has one copy |
| different | same | the userData locks do not meet; the owner file stops the second start with a dialog |
| different | different | both run; parallel smoke runs on temporary folders do this |

## Consequences

- The bundle and a dev run on the real folder can no longer run together: the one started second
  brings the first forward and quits. To try the bundle next to a dev run, give one of them its own
  `MATTERS_USER_DATA` and `MATTERS_DB_PATH`.
- A crash leaves both locks behind and the next start takes both over without asking.
- A database on a volume shared between computers is never taken from the other computer; after a
  crash there the person removes the owner file, which the dialog names.
- On a volume without hard links the owner file is created with an exclusive open instead; a
  reader may then see it empty for a moment, which counts as a start in progress.
- On Windows Chromium's lock is a file held open in the folder, which the move could not carry
  or set aside; there the lock is taken right after the identity move instead of before it, so two
  starts during the one-time move are not kept apart.
- The owner file adds one small file next to the database while the app runs.
- `tools/smoke-instance.ts` checks the built app in temporary folders: a second start on the same
  folder leaves with 0, one on another folder with the same database is refused with 1, a copy
  killed with -9 is taken over, and a quit removes the owner file. The dialog of a refused start
  outside smoke runs is not driven there.
- Not covered: the backend outliving a main process that was killed. The next start sees main's pid
  gone and takes the database while the orphan may still be closing it.
