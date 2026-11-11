# 0070. The window opens with the mail (amends 0046)

- Status: Accepted
- Date: 2026-11-07
- Amended by: [0103](0103-the-window-waits-for-the-page-not-a-clock.md) (rule 4: the deadline waits for a page that started, the frame is the mark, stages are said)

## Context

The owner saw, at every start, the empty frame of the window before any mail. ADR 0046 had measured
that frame at 30 ms before the rows, on a generated mailbox with AI off. On a real mailbox of about
197,000 messages and 5,300 sent, with AI on, it lasted about 3.6 s: rows came 3,904 ms from spawn.

The list of things asked the database about each company on it, for what the person wrote to them
(137 walks of Sent mail, 1.1 s) and what they received from them (153 walks, 2.1 s). Each answer is
cheap and their number follows the list, against the promise that the cost follows the candidates.
All of it ran synchronously on the router, the one thread that serves every read, so the list of mail,
which answers in 1 ms, queued behind it. A list that takes long also ran again after each push.

The benchmark had not seen this: its generated mailbox has no agent readings, and it stopped at the
first row.

## Decision

1. **One walk for a list, however many companies are on it.** `listSentSubjects` and
   `listReceivedSince` give way to `listSentMail` and `listReceivedMail`. The first question of each
   kind in a list build walks that mail once and files it by company (`CompanyIndex`); every other is a
   look in a map, so its cost no longer grows with the list. The list itself did not change: on the
   owner's mailbox the old and the new code gave byte-identical results for the list and the ranking.
2. **Reads that walk a lot of mail have their own thread.** The list of things, what the agent has for
   a thread and the count for the consent screen run on the read thread (`readWorker.ts`), which has a
   read-only connection of its own, no secrets and writes nothing. It starts beside the sync worker when
   the database can already be read, after it when the worker must make it so. A list or a thread never
   queues behind these reads again. If the thread cannot start or dies, whatever it had not answered is
   answered on the router, as everything was before. It is not restarted: slower is still right.
3. **The window opens with the mail.** It is created hidden and main shows it when the page says the
   first screen is on its way to being presented: accounts, list and open thread, and with AI on the list
   of things. An opened letter's settling animation is finished first, since a window opening with it has
   nothing to settle from. A maximized window maximizes at that moment, because maximizing also shows it.
4. **A slow start shows a frame, and then says so.** If the page has not said so 800 ms after the
   window was created, main shows it anyway. This replaces rule 5 of ADR 0046 and refines its "no text":
   the frame now has the agent's column at its remembered width, and the quiet shape of a list. From
   1.2 s after the page started it says "Opening your mail…", and from 8.2 s that a large mailbox or an
   update can take a moment. Those words speak only of the app, so they cannot be wrong about mail, and
   they are CSS animations, so they come with no script, even from a cold disk.
5. **The benchmark takes a real database.** `--db` measures a copy of one, and `--settle-ms` stays after
   the rows for what comes next. New marks: `thread-open`, `stores-ready`, `agent-ready`, `first-screen`,
   `window-shown` and the read thread's. Startup is judged on real mail too from now on: a generated
   mailbox cannot show a cost that depends on the readings.

## Results

Median / p95 of 11 runs, ms from spawn, repeat launch, warm page cache. The real mailbox is a copy, with
reading paused and no credentials, so it neither called a model nor reached a mail server.

| mailbox | list rows before | list rows after | window shown after |
|---|---|---|---|
| Real, 197k, AI on | 3,904 / 4,045 | 370 / 379 | 361 |
| Generated, 100k, AI off | 263 / 271 | 262 / 272 | 252 |

Building the list of things once, warm, on the real mailbox: 3,258 → 60 ms. Forcing the page never to
say it was ready showed the window 813 ms after it was created.

## Consequences

- With AI on, the first answer of the read thread takes about 110 ms against 60 ms warm, probably code
  that has not warmed up, and is now what the window waits for. That is the next thing to shorten.
- The agent's status is answered by the sync worker at about 590 ms, after the window opened. Its parts
  of the prompt row come then, in space kept for them.
- The window is hidden for its first 250–360 ms, where it used to show from about 160 ms. The Dock shows
  the app starting in that time, and what opens is complete.
- What the agent has for one thread may now walk as much mail as a whole list does. It does so on the
  read thread, where it blocks no list; its time alone was not measured.
- One more thread and read connection for the life of the backend.
- `bench:launch` in its `first` mode does not end on a real database with AI on: that launch has no
  remembered AI setting, the list changes while it opens, and the benchmark's first row never reports.
  Use `--modes repeat` there. Only a fresh userData, not a person's second start, is in that case.
- What the first frame of the shown window looks like could only be checked by capturing the page at
  the moment it is shown, not by filming the screen.
