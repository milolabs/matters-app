# 0071. Notifications: banners, notices inside, and the badge

- Status: Accepted
- Date: 2026-11-07
- Amended by: [0106](0106-notifications-that-matter.md) (new mail by arrival, a state kept across a restart with a catch-up, and a fourth kind for what the agent says matters), [0109](0109-the-badge-counts-what-is-in-matters.md) (the badge counts what is in Matters by default)

## Context

Until now nothing told the person that mail came: they had to look. A mail client has three ways to
say it, and each has a cost.
- **A system banner** interrupts and can be read by anyone looking at the screen.
- **A notice inside the window** is seen only while the app is in front.
- **The count on the icon** is seen all day.

The person wants to choose all three: what notifies, which mail, and how much. The mailbox it was
built against holds 197 thousand messages and gets several lists and programs an hour. A rule like
"every new message rings" would ring all day, and "the unread count" on the icon would show
thousands.

## Decision

1. **The router owns notifications.** Its `Notifier` keeps the settings, looks for new mail after
   commits, and says what to show:
   - **to main**, the banners and the badge's text;
   - **to the windows**, the notices inside.

   Main and the page decide nothing but whether their window is in front. The settings are a JSON
   file of this computer next to the database (`notifications.json`), written aside and renamed.
   They are not mail and do not sync. The router writes no database.
2. **New mail** is unread mail dated after the watch began (less ten minutes) that an earlier look
   did not see (`NewMailWatch`). At start the watch takes what is there as seen, so opening the app
   rings nothing. An account added today brings its mail with its old dates, so it never rings.
   The watch remembers 48 hours in memory. Mail delivered with a Date header more than ten minutes
   old when the watch starts, or older than the last 48 hours later, is missed. That is the price of
   not keeping a log.
3. **Three kinds of Inbox mail**, each with its own channels:
   - **Replies to you**: a thread you wrote in. On by default.
   - **Other mail from people**. On by default.
   - **Lists and programs**: by the headers that already decide this for Matters (ADR 0052, rule 4),
     and by the sender's address. Off by default.

   Each kind can be set separately for banner, in-app notice and badge. Your own mail, read mail
   and mail of a muted account never notify.
4. **Saved views can notify,** each with its own channels, wherever their mail is (outside the
   Inbox too). A view adds to the kinds, it does not replace them. A view of everything (no
   constraint) is skipped: that is what the kinds are for.
5. **How much a banner says:**
   - sender, subject and first line;
   - sender and subject (the default);
   - only that mail came.

   The notice inside always says it all: it is shown only while the person is looking at the
   window. Mail that comes together is at most *n* banners (1, 3 or 5). The newest come alone and
   the rest is one summary ("3 more new messages, from Anna, Bartek and 1 other"), with one sound.
6. **Quiet.** *Pause for an hour* or *until tomorrow 8:00*, and quiet hours every day (they may run
   across midnight). While quiet: no banner and no sound. The notices inside and the badge go on,
   since they interrupt nobody. Focus and the lock screen stay the system's. Every field of the
   settings is defended on read: a missing or broken field takes its default.
7. **Notices inside the window:**
   - quiet cards under the search bar at the right, newest on top;
   - three at a time, "*n* more" and *Clear all* under them;
   - each stays 4, 6 (the default) or 10 seconds, or until closed.

   Their time runs only while the window is in front and the pointer is not over them, and the
   hairline at their foot shows it. Without focus they wait, so nothing goes by unseen.
8. **Banners and the badge in main.** A banner shows when the mail window is not in front, or always
   if the person asks. Main holds each banner until it is clicked or closed (Electron forgets the
   click of one nobody holds). The badge is the dock's text on macOS and a count elsewhere where the
   system has one. On Windows there is no badge yet.

   The badge counts one of three things:
   - mail you were told about and have not read (the default until ADR 0109, which adds what is
     in Matters and makes it the default): the kinds ticked in its column;
   - all unread in the Inbox, up to 999;
   - nothing.

   It shows as a number or a dot.
9. **A click opens the message:**
   - in Matters, if it is shown there;
   - in the list, if it is there;
   - otherwise in All mail, where new mail is on top.
10. **Settings › Notifications**, between Agents and Images:
    - a master switch and *Send a test*;
    - *Pause* and quiet hours first;
    - one table of kinds and views against Banner, In app and Badge;
    - what a banner says, beside a preview of it;
    - the badge, the notices' time, and the accounts.

    Every change is kept at once and reaches every window.

## Consequences

- One place decides; main and the page only show. The rules are pure (`planNotices`, `isQuiet`)
  and tested without Electron.
- A look costs one index window of unread mail since the watch began, a thread read per new
  thread (at most 40), and one `matchesAmong` per notifying view. It runs at most once per 700 ms
  of commits, on the router, after the list it may wait behind.
- A badge of the Inbox counts up to two windows of 500 at every look.
- Mail that is new while the app is closed is not announced when it opens. The list shows it; a
  catch-up summary would be a later decision.
- Kinds come from headers, not from the agent: "this matters" (ADR 0052) does not notify yet.
