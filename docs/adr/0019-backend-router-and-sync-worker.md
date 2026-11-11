# 0019. Backend: a read router and a sync worker thread

- Status: Accepted
- Date: 2026-11-03
- Refines: 0005 (backend process), 0018 (background sync)

## Context

ADR 0018 rule 7 measures search and open-thread latency while a 5,000-message initial sync
runs. Medians passed (search 9 ms, open 8 ms) but single requests spiked to 50-68 ms. The
backend utility process has one JavaScript thread, and `node:sqlite` is synchronous: while a
sync batch writes (about 60 ms for 500 messages) requests wait in the event loop, although the
reads already use their own connection. Awaits inside the unit of work resolve as microtasks and
never let a message event run, so the sync cannot yield.

## Decision

The backend utility process runs two threads.

- **Router** (main thread, `backend/main.ts`): serves every renderer request that reads
  (`listNewest`, `openThread`, `search`, `getMessages`, account list and status) on the
  read-only SQLite connection, discovers servers, pushes `changes` / `syncStatus` /
  `accountsChanged` to the renderer, and supervises the worker. It never opens a write
  transaction and never talks to a mail server.
- **Sync worker** (`node:worker_threads`, `backend/syncWorker.ts`): owns the writer connection,
  the unit of work, all write ports, the IMAP connector and IDLE, the MIME parser, the
  `SyncScheduler`, and the account commands (`addAccount`, `removeAccount`, `syncNow`). The
  database is created and migrated here; the router opens its reader after the worker reports
  `ready`.

The two talk over the worker's message channel with the typed messages of
`backend/protocol.ts`: commands in, and `status`, `committed`, `synced`, command results and
`stopped` out. After `committed` the router reads `changesSince` on its own connection and
publishes, as before. The worker does not read a change sequence itself: on the shared writer
connection that read could land inside another account's open unit.

Credentials: the dedicated port to main stays on the router. The worker's `CredentialPort`
requests are relayed to main and the answers back, untouched and with renumbered ids so a
restarted worker never receives a predecessor's answer. The password still never reaches
SQLite, logs or the renderer.

Shutdown: the router asks the worker to stop (the scheduler closes IMAP and finishes or aborts
the open unit, then the writer closes), waits up to 3 s, terminates it otherwise (SQLite
discards an open transaction), then closes the reader and exits. Main keeps its own, longer
timeout.

Crash: the router publishes a sync `error` status for every account, keeps serving reads, and
starts a new worker with exponential backoff (500 ms doubling to 30 s, reset after 30 s of
health). The new worker resumes from the stored cursors; a batch commits atomically with its
cursor (ADR 0007), so nothing half-written is ever visible.

Build: electron-vite resolves `?modulePath` in the main bundle only (nested builds skip the
plugin), so `main/index.ts` imports the worker entry with `?modulePath` and passes its path
to the backend in `MATTERS_SYNC_WORKER`, as it does the database path.

Attachment worker (ADR 0041, rule 4): a third thread, started by the sync worker on first use
and retired after 30 s idle. It is built like the sync worker: `main/index.ts` imports
`backend/attachmentWorker.ts?modulePath` and passes its path in `MATTERS_ATTACHMENT_WORKER`, with
the two directories it works in (`MATTERS_ATTACHMENTS_DIR`, `MATTERS_SPOOL_DIR`). The router
turns the renderer's grants into paths (they reach it over a port of their own from main) and
hands them to the sync worker in a command; the paths go no further.

## Consequences

- Reads no longer wait for writes. During the 5,000-message initial sync the largest search
  work was 4.5 ms (was 49 ms) and the largest open-thread work 2.6 ms (was 59 ms), with
  sync throughput unchanged (about 2,250 messages/s against 2,060).
- Account add and remove are one hop longer (router, worker).
- Reads see a batch only after its commit, as before; the router learns of it from `committed`.
- The worker can die independently of the router; the crash test (`syncWorker.test.ts`)
  kills it with a batch open and checks that no half batch is stored and reads never fail.
- Startup now includes starting the worker before the first read (warm launch to list about
  250 ms against the 500 ms budget).
- `smoke:desktop:sync` fails when, during the sync, search work exceeds a 5 ms median or
  16 ms max, open-thread work exceeds 16 ms max, fewer than 40 samples of each were taken, or
  throughput falls below 1,760 messages/s.
