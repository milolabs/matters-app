# 0046. Startup: reads before the worker, a frame before the data (refines 0005, 0012, 0019)

- Status: Accepted
- Date: 2026-11-05
- Amended by: [0070](0070-the-window-opens-with-the-mail.md) (the window opens with the mail; rule 5 now applies to a slow start only), [0103](0103-the-window-waits-for-the-page-not-a-clock.md) (the loading screen is the mark)

## Context

ADR 0012 promises "launch → inbox visible < 500 ms", a cached first screen and lazy-loaded heavy
modules. The smoke test reported ~300 ms, but it clocks from `Date.now() - process.uptime()`, which
misses the time before Node starts, and its cold phase includes seeding. `tools/bench-launch.ts`
now measures from outside: the clock starts in the driver right before `spawn`, a dev-only trace
hook (`!app.isPackaged`, inert when packaged; no measurable cost: smoke warm median 304 ms without
it, 306 ms with it present and off, 12 interleaved runs each) marks each phase on one epoch clock,
and the end is the frame in which a list row is presented (Element Timing `renderTime`). The window
is really shown. Page cache is warm in every run: a start after a reboot cannot be forced without
sudo and will be slower by whatever the disk costs. "First launch" means an empty userData (no
Chromium or V8 caches); "repeat" means the same userData as before.

Before (HEAD), median of 7, 8k / 100k / 500k messages, ms from spawn, all with a warm page cache:
the list rows came at 398 / 402 / 400 (first launch) and 391 / 382 / 389 (repeat). Size made no
difference: a first read at 500k answers in 2 ms. Nothing real was painted before the rows (the
earlier "first paint" at ~210 ms is a blank frame). The timeline of a repeat launch showed where the
time went:

| ms | phase |
|---|---|
| 74 | main starts (Electron boot) |
| 97–158 | window built (`new BrowserWindow` alone is ~60 ms of main-thread work); backend forked only after it |
| 189–239 | backend script running |
| 330–340 | sync worker up (spawn ~85 ms), reader open, **first answer at 342** |
| 389 | rows painted |

## Decision

1. **Reads do not wait for the sync worker.** When the database file exists, is in WAL mode and
   its schema version equals this build's `LATEST_SCHEMA_VERSION`, the router opens its read-only
   reader at once (`openReaderIfCurrent`) and starts the worker beside it. In every other case
   (no file, older schema to migrate, newer schema to refuse, not WAL, unreadable) it waits for the
   worker as before. A reader never sees a half-migrated schema because it only opens when there is
   nothing to migrate; it still sees committed data only. A command for the worker that arrives
   before the first worker is ready waits for it; after a crash it fails fast as before. Commits
   announced before the change publisher exists are folded in by one touch right after it starts. A
   worker that cannot start ends the backend, as before.
2. **The backend starts before the window.** `utilityProcess.fork` is called before
   `new BrowserWindow`, so the two run in parallel.
3. **The first script holds only what the first screen needs.** CodeMirror (half the bundle), the
   first-run screen and DOMPurify load with dynamic `import()`; the smoke checks load only in smoke
   runs. `preloadHeavyModules` fetches the editor and the sanitizer two frames after the rows were
   rendered, in idle time, so the first `r` or the first HTML message finds them in memory. The
   first script went from 1,389 KB to 300 KB. CSP stays `script-src 'self'`.
4. **A V8 compile cache for the backend and its workers** (`NODE_COMPILE_CACHE` under userData).
5. **The window's frame is in the HTML.** `index.html` carries an empty, themed frame (toolbar,
   query row, list column and footer at their real sizes, the list's remembered width) that paints
   with the first script and is removed in the frame the first real screen arrives. It has no text
   and no data, so it can be neither stale nor wrong, and it never shows the setup screen.
6. **Rejected, with measurements** (100k, 15 runs each, repeat launch rows median; baseline for each
   was the build before it): a custom scheme with `codeCache: true` and a path-checked handler for
   the build folder, with and without cache headers, 268 → 270 / 273 ms (first launch 270 → 282):
   the cache fills but nothing measurable is saved, so file:// stays and `isOwnPage` stays as is.
   `v8CacheOptions: "bypassHeatCheck"` on file://: 268 → 264 ms, noise. Not tried: bundling the
   backend's node_modules dependencies (the worker is off the critical path now); a persisted first
   screen (rows come 30 ms after the frame, not seconds; it would mean mail metadata in a second
   file).
7. **Budgets.** The smoke launch budget drops from 500 to 320 ms (it measures 182–201 ms on its own
   clock, which leaves out ~75 ms before Node starts, so ~265 ms from the spawn). ADR 0012's 500 ms
   stays the user-facing budget, with a measured margin of about 230 ms. The smoke also holds the
   first `r` of a run to 150 ms (21 ms measured, editor loaded on demand).

## Results

Median / p95 of 7 runs, ms from spawn. "Frame" is the first non-blank paint (before: a blank frame;
rows were the first real content).

| mailbox | launch | rows before | rows after | frame after |
|---|---|---|---|---|
| 8k | first | 398 / 411 | 263 / 279 | 224 / 239 |
| 8k | repeat | 391 / 394 | 260 / 266 | 229 / 238 |
| 100k | first | 402 / 423 | 266 / 279 | 225 / 231 |
| 100k | repeat | 382 / 394 | 255 / 267 | 229 / 239 |
| 500k | first | 400 / 537 | 263 / 285 | 225 / 229 |
| 500k | repeat | 389 / 410 | 262 / 264 | 235 / 239 |

Each step on its own (100k, 15 runs, repeat launch rows): backend before window 391 → 337, reader
before worker 337 → 279, split bundle 279 → 268, frame in HTML 268 → 265 (it moves the first real
paint, not the rows), compile cache 265 → 264 (the worker is ready 16 ms sooner, off the critical
path). After: process 0, main 76, backend script 178, reader open 188, page script 208, first
answer 217, frame 235, rows in DOM 233, rows painted 262, worker ready 277.

## Consequences

- The rest is mostly Electron's own boot (76 ms), the window's construction (~60 ms) and the
  renderer's first style, layout and paint (~30 ms). The worker, sync and anything that writes are
  ready ~15 ms after the rows; the first second after launch is the only time a write command may
  wait for it.
- A database the build has to migrate still starts as slowly as before, once.
- The first open of a thread or a reply after a start in which the idle preload did not finish
  would load the chunk then; the smoke holds that case to its budget.
- `tools/bench-launch.ts` (`bench:launch`) is how any later change to startup is judged. The
  database it builds (8k, 100k, 500k; ~30 MB, 0.4 GB, 1.8 GB) is cached in the temp folder.
