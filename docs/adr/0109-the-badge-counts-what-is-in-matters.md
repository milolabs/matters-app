# 0109. The badge counts what is in Matters

- Status: Superseded by [0117](0117-matters-is-a-view-with-a-prompt.md)
- Date: 2026-11-10
- Amends: [0071](0071-notifications.md) (rule 8: what the badge counts by default)
- Amended by: [0112](0112-what-you-answered-waits-for-its-reading.md) (consequences: what the
  person answered leaves the backend's list, and the windows hear counts that mail changed)

## Context

- **The badge's number had no place in the app.** By default (ADR 0071, rule 8) it counted mail
  the app had told about and that was still unread in the Inbox. No list, tab or view shows that
  number, so the person could not tell what the Dock meant or what to do to clear it.
- **The Matters tab has a number.** It is `total` of the list of things (`listThings`, read on the
  read thread, ADR 0070), the same list the tab draws: every thing that shows, loaded or not, after
  rules, feedback and series. The window subtracts what the person just dealt with until the next
  read of the list drops it.
- That read walks the agent's readings and opens each thread that may show. It is fine after an
  agent write, which already makes every window read it again; it is too much for every commit of
  a sync on a large mailbox.

## Decision

1. **A count must have a place in the app that shows the same number.** A new badge source
   `matters` counts what is in Matters, and it is the default. *Mail you were told about*, *All
   unread in the Inbox* and *Nothing* stay as they were. A settings file that names another source
   keeps it; a missing or unknown source is `matters`.
2. **The router counts with the tab's own read.** The notifier asks the read thread for the list of
   things with no rows (`limit: 0`): only `total`, no prepared work is read. With AI off, without
   consent, or with nothing found, the read is 0 and there is no badge.
3. **When it counts.**
   - At the start, and when the settings change.
   - After an agent write (a reading, feedback, a closing, a rule), coalesced as the writes already
     are (1.5 s), and at once after that pause.
   - After mail commits, because mail that leaves (Trash, Spam) takes its thing along: at most once
     every 5 s, one count at the end of the gap however many commits came.
   - Nothing is read while the badge counts something else. A failed read keeps the last count.
4. **Settings.** *What is in Matters* is first under *Badge on the icon*, with the hint that it is
   the same number as the Matters tab. The Badge column of the kinds table still applies only to
   *Mail you were told about*.

## Consequences

- The Dock and the Matters tab agree once the list has caught up with what the person did: within
  about 1.5 s after an action the agent records, within 5 s after mail that moved away. A count
  after mail commits that changed tells every window to read the list again (ADR 0112).
- The badge stops at 999+ where the tab does not.
- (Amended by ADR 0112: a reply in the outbox or in the thread takes the thing out of the
  backend's list until the thread is read again, so the Dock, every window and a reload leave it
  out together.) A thing the window hides after *Send* stays in the backend's list until the agent
  reads the thread again; until then the Dock counts it and that window's tab does not.
- A settings file saved before this change names `notified` and keeps it; the person picks the new
  source once in Settings.
- The count costs one read of the list of things per agent pause and at most one per 5 s of
  commits, on the read thread, not on the router.
