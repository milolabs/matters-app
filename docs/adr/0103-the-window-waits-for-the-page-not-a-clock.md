# 0103. The window waits for the page, not for a clock (amends 0046, 0070)

- Status: Accepted
- Date: 2026-11-10

## Context

ADR 0070 shows the window when the page says its first screen is ready, or 800 ms after the window
was created, whatever the page is doing. The built app meets that easily: on a copy of the owner's
mailbox (197,000 messages, 3.8 GB, AI on) the window is shown at about 371 ms from spawn. But the
owner runs the app every day with `electron-vite dev`, and there the page waits for the dev server to
transform and serve its unbundled modules: its script started about 760 ms after the window was
created (median of 5: renderer-script-start 1,246 ms from the CLI start, window created at 496).
The 800 ms deadline therefore fired 80–200 ms before the first screen in every dev start: the frame of
ADR 0070 flashed and was replaced. The same race waits for any start that lands near 800 ms.

In dev that frame also had no styles when it showed: its CSS lived in `styles.css`, which arrives with
the script graph. And on the slow path the page cannot say what is happening: an update of the schema
(47 so far, one after most builds the owner tries) shows the same time-based words as a cold disk.

## Decision

1. **The backend says how far startup is.** The router tells main its stage as it goes: `starting`,
   `opening` (the reader opens at once, or it waits for the worker), `updating` while the worker
   updates the schema of a database that holds mail, with step n of m (the migration runner calls back
   before each pending migration; a new database is created, not updated, and says nothing), and
   `ready`. Main forwards it to the window; the preload, which runs before any script of the page, puts
   it on `<html>` (`data-boot-stage`, `--boot-step`, `--boot-total`), so the loading screen's words
   change with no page script. A stage is a name and two integers checked at each boundary
   (`readBootReport`): main still sees no data (ADR 0005).
2. **The reveal is a policy** (`main/revealPolicy.ts`). The fast path is unchanged: the page says its
   first screen is ready and main shows the window; a normal start never shows the loader. The page
   says when its script starts (`scriptStart.ts`, its first module), and then the deadline becomes the
   later of 800 ms after the window was created and 350 ms after the script started: a page that is
   about to finish is not pre-empted. From script start to first screen takes 135–150 ms built on the
   real mailbox with AI on and 55–150 ms in dev, so 350 ms is more than twice that. An update is a long
   wait whatever the page does and shows at the 800 ms deadline; so does a page that has not started.
3. **A loader that was seen does not flash.** Main tells the page, before it shows the window, that the
   loader is on screen; the page keeps it up at least 300 ms from then and lets it go into the complete
   first screen with a 140 ms cross-fade, opacity only, and none for reduced motion. An unseen loader
   goes in the frame the mail arrives, as before; the mail never waits for a loader nobody saw.
4. **The loading screen is the app's mark** ("Weight"). The M of the icon on the window's background,
   the icon's violet dot drops into its valley, the M gives a little under it, and while the wait goes
   on the dot lifts and settles every 2.8 s. Only the real header bar stays from ADR 0070's frame, so
   the traffic lights sit on the same strip before and after; the list's shape, its remembered width and
   the agent's column are gone, and so is the code that measured them. The motion starts when the
   window is shown (the preload's `data-boot-shown`), so the drop is seen rather than over before
   anyone looks. The words are those of ADR 0070, rule 4, still pure CSS from the page's start; with an
   update they say "Updating your mailbox…", "Step 2 of 3" under the mark when the runner can count, and
   after 8.2 s "This happens once after an update." They speak only of the app.
5. **Its styles come first.** `boot.css` is linked from the head of `index.html` on its own, so it is
   there before any script in dev as in a build; it keeps its own copies of the few colours it needs
   for both schemes (they mirror the tokens in `styles.css`) and depends on nothing else. CSP is
   unchanged (`style-src 'self'`; the preload sets custom properties through the CSSOM).
6. **Dev starts sooner.** The dev server transforms the page's module graph while Electron starts
   (`server.warmup`), so the page finds it ready.
7. **The benchmark can judge all of it.** New marks: the stages, `script-start-received`,
   `boot-shown`, `boot-hidden`, and how long a seen loader stayed. Three dev-only
   knobs, inert in a packaged app like the trace itself: `--never-ready` (ADR 0070's forced slow page,
   which also keeps the loader), `--force-wait` (the backend waits for the worker on a database that
   needs nothing), and `--rewind-schema` (each launch gets a clone of the database with its newest
   schema step undone, so the worker really updates it; valid while that step can run again, as 46
   can). `--theme` and `--shot` take a picture of the loader in either scheme.

## Results

Median, ms from spawn, warm page cache, the build before and after alternated in the same session
(order switched every round, so neither side always ran second).

| case | runs | window shown before | after |
|---|---|---|---|
| Real, 197k, AI on, repeat | 24 + 24 | 362 | 372 |
| Generated, 100k, AI off, first | 15 + 15 | 267 | 272 |
| Generated, 100k, AI off, repeat | 15 + 15 | 270 | 272 |

Dev, ms from the CLI start, same mailbox, median of 5 each: before, the page's script started at 1,246
and the window was shown at 1,302 by the deadline, before its first screen (1,300), in every run. After,
with the warm-up, the script starts at 1,058 and the window is shown at 1,122 with the mail, no loader in
any run; without the warm-up (same build otherwise) 1,232 and 1,290, also no loader, because the
deadline now waits for a page that has started.

The slow path. `--never-ready`, 100k, 5 runs: the loader shows 800 ms after the window was created (966
ms from spawn), as in ADR 0070, and stays. `--force-wait`, 100k, 5 runs: the worker is ready at 291,
the window shown with the mail at 333; no loader. `--rewind-schema`, 100k, 5 runs: `updating` from 282,
the update ends at 344, the window shown with the mail at 387; no loader. On the real copy the same
update ran long once (3 runs, page cache cold for the clone): `updating` at 357 ms, the loader shown at
978 saying so, the update over at 1,655, the mail complete at 1,880, the loader faded by 2,022 (on
screen 1,026–1,044 ms); with a warm cache it ends at 486 and the window opens with the mail at 634.

Tried and not kept, with numbers:

- Pre-bundling `@matters/core` and `@matters/contracts` for the dev server: renderer script start
  1,080 → 1,096 ms (3 and 4 runs), no gain, and edits to core would need a forced re-optimise.
- Running the built app instead of the dev server (`electron-vite preview`, which builds first): window
  shown at 1,331 ms from the CLI start against ~1,150–1,300 in dev; nothing gained for a daily start.
- The read thread starting the list of things as soon as it is up, before the window asks, and cutting
  it to the page on the question (B4): it starts 16 ms sooner and the window was shown at 362 against
  ~374 (11 runs), below the 20 ms this change had to earn. The 117 ms are spent in the build itself
  (33 ms for the first reads, 76 ms reading each analysed thread, cold), not in waiting for it.
- Not built: answering the agent's status from stored settings before the worker. The worker is up at
  ~313 ms and the status leaves it at ~560: reading the stored part takes under 1 ms, looking at the
  runtime (the program) 150 ms and counting what shows 100 ms. The prompt row and the tab need
  `runtime` and `progress`, which only the worker knows; an early answer would have to invent a
  progress (a count of 0 of 0, or a state) it does not have, which ADR 0070's rule 4 forbids for words
  and is as wrong for numbers.

## Consequences

- Nobody sees a loader in a normal start, in dev too; a start that is slow for a reason the backend
  knows says the reason. A seen loader costs at least 440 ms of screen time, by design.
- A built start shows its window later by 2–5 ms on the generated mailbox and 8–10 ms on the real one
  with AI on, inside the ±10 ms this change was allowed. Bisected: it comes from the page's own script
  (with the old markup, without the new stylesheet and without any boot message it stays), and shows
  as the list of things answering later; its cause was not found. It is the first thing to look at
  when startup is next worked on.
- Main re-arms one timer when the page starts and when the stage changes. It tells the page nothing in
  a normal start: only a seen loader or an update is worth a message.
- The first script is 488 kB (300 kB in ADR 0046). What grew is first-screen code (the app, the list of
  things, the query bar, the store, the virtualiser's new modules); the static imports it pulls in bring
  about 850 kB to the first screen. Splitting what it does not need (move picker, list menu, drop
  overlay, map) is about 20 kB; ADR 0046 measured 11 ms for 1.1 MB, so it was not done here.
- A migration that cannot report its steps would still show `updating` without a count.
