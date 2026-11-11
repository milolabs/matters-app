# 0106. Notifications that matter: by arrival, across a restart, and from the agent

- Status: Accepted
- Date: 2026-11-10
- Amends: [0071](0071-notifications.md) (rule 2 and its consequences; a fourth kind for rule 3)
- Amended by: [0108](0108-banners-act-and-leave.md) (rule 1: old mail that only moved; rule 5: the
  person's local day, and a banner held back by quiet)

## Context

ADR 0071 left three gaps.
- **New mail was judged by its Date header.** Mail delivered late, or with an old or wrong date,
  was missed without a word.
- **The watch lived in memory.** After a restart the badge was empty, and mail that came while
  the app was closed was never announced.
- **Kinds came only from headers.** What the agent found matters (ADR 0052) did not notify.

What the store knows about arrival:
- The message key is chronological by the Date header (ADR 0006), so it says nothing about
  arrival.
- `change_seq` grows with every write, a flag change too, so it cannot tell new mail from an
  update.
- IMAP INTERNALDATE is fetched but not stored.
- Each copy of a message has a location `(account, folder, UIDVALIDITY, UID)`, the primary key of
  `message_locations`. The server gives UIDs in the order mail arrives in a folder, and never
  gives one again under the same UIDVALIDITY.
- The sync cursor of each folder names its UIDVALIDITY and `lastUid`, the highest UID stored. It
  is committed with the mail it covers (`applySyncBatch`). For a folder that is empty on the
  server it is 0. A backfill fetches UIDs below the region and leaves `lastUid` where it is.

## Decision

1. **New mail is mail stored above a folder's mark.** A mark is a folder's `(UIDVALIDITY,
   lastUid)` as its cursor says. A look reads every cursor (one small table) and asks the
   locations' primary key for the unread mail in each span `(old mark, new mark]`. The Date
   header plays no part.
   - **At start,** without a kept state, the marks of now are taken, so opening the app rings
     nothing.
   - **A folder without an earlier mark** brings nothing: an account added today, a folder synced
     for the first time, a new UIDVALIDITY. Its mail was not seen arriving.
   - **A backfill** stores UIDs below the mark, so it never rings.
   - **Old mail that only moved** never rings (ADR 0108): a message dated more than 7 days ago
     (`CATCH_UP_DAYS`, the catch-up's reach) is above the mark only because it was moved in.
   - **A message in two folders,** or arriving again in another, is told once: the watch keeps
     the keys of the last 48 hours.

   No schema change is needed. A column of arrival time would need a migration of 197 thousand
   rows and its own index. It would still have to tell a backfill from new mail, which the UIDs
   already do. The marks rest on the cursor fields of the IMAP sync, the only sync there is. A
   sync whose cursor does not name them gives no marks, and its mail does not notify.
2. **The watch keeps a state file** next to the database, `notifications-state.json`. The rule is
   that of `notifications.json`: JSON, read field by field, written aside and renamed, mode 0600,
   and in memory for `:memory:`. It holds:
   - the time of the last look and the marks;
   - the keys the badge follows;
   - the mail told in the last 48 hours, with the channels each went through (at most 500);
   - the deadlines already said, and those whose banner is still owed, until their day is over.

   It is written after a look that changed any of these. The router still writes no database.
3. **What came while the app was closed is one catch-up.**
   - **No state file** (a first run, a new install): nothing is announced.
   - **With a state,** the marks of the last run stay. Every look gathers what is above them,
     until each account's first sync since the start is done, or two minutes have passed.
   - **The sync brings mail in several commits,** and the store does not keep when it arrived, so
     a short settle window would only guess. The end of the first sync is a fact the router
     already hears. Mail that truly comes in those first minutes joins the catch-up: that is the
     price.
   - **The catch-up is one notice inside the window,** with no banner and no sound: "12 new
     messages while Matters was closed", "From Anna, Bartek and 3 others". It counts the unread
     mail that would notify now through a banner or the window, dated within the last 7 days. The
     badge follows those its column covers.
   - **A window that opens within two minutes** still gets the notice: the first sync can end
     before the window is there.
   - The badge of `notified` is restored from the state, minus what was read since.
4. **A fourth kind: What matters.** It is mail the agent decided matters: a reading of its thread
   made after the mail came, that shows in Matters by the list's own bar (`shownPath`, consent,
   rules, not hidden; ADR 0066).
   - **Channels:** it has its own banner, in-app and badge, all on by default. An older settings
     file gets the default.
   - **What triggers it:** the agent's write (the router's `agentChanged`) triggers it, never the
     look for new mail. A pass reads the latest readings of up to 40 threads with undecided mail.
     Only a thread read after its mail came (less a minute of slack) is asked whether it shows.
     Each message is decided once.
   - **No channel twice:** a message goes only through the channels of `matters` it did not
     already go through. Mail that rang as "mail from people" gets no second banner. Lists with
     their channels off get the banner from this decision.
   - **What never notifies still doesn't:** read mail, your own and that of a muted account.
     Quiet hours and pause hold the banner back as for other mail.
   - **The banner says the reading's headline.** Full: sender, headline, and the person's own ask
     as the mail words it. Subject: sender and headline. Minimal: "Something matters".
5. **A deadline is said once.** A promise or an ask of the person (`who` is `you`) with a due day
   is said on that day: from the person's local midnight to the next (ADR 0108; a due day is a
   date, not a UTC instant). It must be of a thing that still shows. It goes through the banner and
   in-app channels of `matters`, at start and every hour, and it is kept in the state so a restart
   does not say it again. A banner that quiet hours or a pause held back is still owed: it goes
   when banners may go again, and the notice inside the window is not shown twice. Facts the other
   side owes do not count. Neither does the end of an offer (`windowEndMs`).

## Consequences

- **A look costs** one read of the cursors (one row per folder), a primary key range per folder
  whose mark moved, a thread read per new thread (at most 40), and one `matchesAmong` per
  notifying view. There is no index window of unread mail any more.
- **A "matters" pass costs** one indexed read of the latest readings of up to 40 threads. The
  list's bar, which may read the thread's signals, runs only for threads read since their mail
  came.
- **The deadline pass** reads every latest reading once an hour.
- **A move moves the mark.** A message moved into a folder by another client, or by Matters, gets
  a new UID there and counts as arrived if it is unread, not told in the last 48 hours, and dated
  within the last 7 days (ADR 0108).
- **An empty folder's first chunk.** A folder first synced while empty and then given more than
  one sync batch of mail at once announces only the newest batch.
- **Some mail is not announced.** Mail of an account whose cursor names no UIDVALIDITY is never
  announced. A look takes at most 200 new messages, so more than that in one look, or in one
  catch-up commit, is not announced or counted.
