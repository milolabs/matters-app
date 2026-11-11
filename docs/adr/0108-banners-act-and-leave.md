# 0108. Banners act and leave; the system's part is said

- Status: Accepted
- Date: 2026-11-10
- Amends: [0106](0106-notifications-that-matter.md) (rule 1: old mail that only moved; rule 5:
  deadlines), [0107](0107-matters-runs-on-macos-as-its-own-app.md) (what Settings says)

## Context

- **Nothing said why no banner came.** Run as `electron apps/desktop`, the app is the stock
  `Electron.app` (`com.github.Electron`), and macOS shows it no banners (ADR 0107). Run as
  `Matters.app`, banners also need the person's yes in System Settings. Electron 45 has no call
  that reads that answer, and `show` fires whether or not anyone saw the banner. `failed` fires
  only when the system refuses to add the request.
- **A banner could only open the mail.** Electron 45 gives macOS banners buttons (`actions`, each
  `{ type: "button", text }`); a press arrives as the `action` event with `actionIndex`. Its docs
  still ask for `NSUserNotificationAlertStyle` in `Info.plist`, a rule of the old
  `NSUserNotification` API: Electron 45 posts through `UNUserNotificationCenter` with categories,
  and its framework no longer names that key. A notification may carry an `id`;
  `Notification.remove(ids)` takes delivered ones out of Notification Center, and `close()`
  dismisses one that is held.
- **A banner stayed after its mail was read**, in the app or by another client.
- **Pause lived only in Settings.**
- **Two faults of ADR 0106.**
  - A due day is a date, kept as its midnight UTC. Taken as an instant, the day opened at 01:00 or
    02:00 in Poland, inside the default quiet hours, and the banner was dropped while the deadline
    was kept as said.
  - Arrival is a UID above the mark, so old unread mail moved into a folder (a server filter,
    another client, the person) rang as new.
- **System Settings.** The Notifications pane is the extension
  `com.apple.Notifications-Settings.extension` (legacy id `com.apple.preference.notifications`).
  Its `Info.plist` allows the `x-apple.systempreferences:` scheme, and it reveals an app by bundle
  id. `?id=<bundle id>` is the form reported to open the pane at an app; it is not documented by
  Apple.

## Decision

1. **Settings say what is known, and only that.**
   - Main tells the settings window, and only it, the platform and how the app runs: `own` (the
     running bundle's `CFBundleIdentifier` is `app.getmatters.Matters`), `runtime`
     (`com.github.Electron`) or `unknown`. It reads the `Info.plist` of the bundle the executable
     runs from, and no system preference file.
   - Run as the stock runtime on macOS, a line by Pause says that macOS shows no banners for it,
     that `Matters.app` (`bun run bundle:macos`) does, and that notices inside the window and the
     badge still work.
   - Run as the bundle, a quiet line says banners also need to be allowed in System Settings, with
     *Open System Settings*. Main opens one fixed address,
     `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=app.getmatters.Matters`;
     the page names no URL.
   - Nothing claims to know whether banners are allowed. When the system refuses the test banner
     (`failed`), its reason is the section's problem line.
2. **A banner of one message has two buttons**, *Mark as Read* and *Archive*, where the system has
   them (macOS). A summary, the catch-up, a deadline and the test get none.
   - A press goes from main to the router on main's own line as the page's own request: `setSeen`
     for the message, `moveThread` with `archive` for its thread, so archive keeps its undo and
     outbox. The router validates them as it does the page's. Main sends only what it built from a
     banner it holds; the window stays where it is.
   - A click on the banner's body still opens the message.
3. **A banner leaves when its mail is read, archived or deleted**, anywhere.
   - The router keeps the single-message banners it handed to main (at most 50, for 48 hours), with
     whether the mail was in the Inbox. After every look it checks them in the read the badge already
     makes; when the badge does not follow told mail, in a read of their own. With no banner out,
     nothing more is read.
   - It is over when the message is gone, read, in Trash or Spam, or out of the Inbox it was in.
     Main closes the banner if it still holds it and removes the id (`mail-<key>`) from
     Notification Center either way.
4. **Pause from the menu.** The app menu's *Notifications* has *Pause for an Hour* and *Pause Until
   Tomorrow*, or the pause's end ("Paused until 14:30") and *Resume*.
   - The router tells main the pause at the start and when it changes. Main sets it through the
     router (`pauseNotifications`), which changes only that field and tells every window.
   - The times come from one pure rule in core (`pauseUntil`, `pausedText`), used by Settings and
     the menu: an hour from now, or 8:00 local time the next day.
5. **A due day is the person's local day** (amends ADR 0106, rule 5): from local midnight to the
   next. A deadline whose banner quiet or a pause held back is kept as owed: the router looks again
   when banners may go (`quietEndsAt`), on a resume, and every hour; the banner goes then, and the
   notice inside the window, already shown, does not repeat.
6. **Old mail that only moved never notifies** (amends ADR 0106, rule 1): mail dated more than 7
   days ago (`CATCH_UP_DAYS`, the catch-up's reach) gives no banner, notice or badge, wherever it
   arrived.

## Consequences

- **Mail late by more than 7 days, or with a Date that far off, is not announced.** Delivery late
  by hours or a day still rings. A wrong Date in the future still rings.
- **The menu's pause end is written when the menu is built**: at a change and when the pause ends.
  A pause until tomorrow keeps saying "tomorrow" after midnight.
- **A look with banners out costs no more** when the badge follows told mail; otherwise one
  primary-key read of at most 50 keys.
- **Whether the buttons show, and whether a press brings the app forward**, is the system's.
  Electron gives no option for either.
- **The deep link is not documented by Apple.** If `?id=` stops working, the pane opens without
  Matters selected, and the person finds it in the list.
- The router sends the catch-up again only to a window that opens in its two minutes, not to every
  window.
