# 0089. Storage in Settings: what the app keeps and holds

- Status: Accepted
- Date: 2026-11-09

## Context

The maintainer's data folder is 3.9 GB, and nothing in the app says so, or which part is mail, which
part is the search index and which part could go. ADR 0088 also leaves free pages in the database
that only a `VACUUM` gives back. Measured on that mailbox (197k messages, 3.6 GB database):

| Measure | Cost |
|---|---|
| File sizes, `PRAGMA page_count` and `freelist_count` | under 10 ms |
| Messages per account (`COUNT` by `account_id`) | about 30 ms |
| Size of each table and index (`dbstat`, Electron's SQLite has it) | about 1.6 s, reads the whole file |
| `VACUUM` of the whole database | about 9 s |

## Decision

1. **A Storage section in Settings** shows: the total on this Mac with one bar split into the
   search index, messages as sent (HTML), messages and headers, text, caches, files and free space
   in the database; the mail of each account; the database over time; and the memory of each of
   the app's processes. While ADR 0088's move runs, how much of it is left.
2. **The router reads the cheap numbers each time the section opens**, on the read thread
   (ADR 0070), so no list or thread waits behind them.
3. **The breakdown by table is a measurement**, on the read thread too: `dbstat`, grouped by the
   table each page belongs to. It runs when the person asks (Measure again), and at most once a day
   on its own, 2 minutes after launch at the earliest.
4. **Each measurement is kept**, one row per day in `storage_samples` (migration 42, written by the
   sync worker); a measurement on the same day replaces that day's row. That row draws the bar
   until the next measurement, and the rows draw the database over time. 400 rows at most.
5. **Main measures what only main knows**: the folders under the user data folder (the database's
   files, files, caches, the rest) and `app.getAppMetrics()`. The preload passes the question on
   only for the settings window, and main checks the window that asks. Nothing about paths
   reaches the page: main sends sizes per kind of folder.
6. **Two actions, each explained in place:**
   - *Clear* caches: main clears the session's HTTP and code caches. No mail and no setting goes.
   - *Compact*: the sync worker runs `VACUUM`. It is offered only when at least 10% of the
     database is free, and asks first, because it takes seconds and sync waits for it.
7. Agents run as their own programs and are not counted in memory.

## Consequences

- The person can see where the space goes and give back what can go, without a terminal.
- A measurement reads the whole database once a day, on the read thread: the agent's long reads
  (the list of things that matter) wait for it, about 2 s. With no read thread it is not run at
  all, never on the router.
- During `VACUUM` the WAL briefly grows to the size of the database: compacting needs about as
  much free disk as the database.
- Over time starts on the day this ships; there is no history before it.
