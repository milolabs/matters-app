# 0036. Settings live in a window of their own

- Status: Accepted
- Date: 2026-11-04

## Context

The accounts panel was a modal over the mail, and accounts are only the first of several things
to configure. A modal hides the mail it configures, and every further topic would have competed
for the same dialog.

## Decision

- **Settings are a second `BrowserWindow`, one at most.** Asking again brings it forward. It has
  the same lock-down as the mail window and a page of its own, `settings.html`, under the same
  content security policy.
- **Sections run down the side of the window;** Accounts is the first. Adding a section is one
  more entry in the list in `settings.tsx`.
- **It opens from a gear beside the accounts footer,** from the footer itself, and with ⌘, (the
  app menu on macOS, Ctrl+, in the mail window elsewhere).
- **The window has its own port to the backend,** which already broadcasts to every port. A port
  that closes is dropped.
- **Colours reach the mail window through `localStorage`'s `storage` event:** they remain a
  preference of this computer.
- **The mail window is the app.** Closing it quits, and takes the settings window with it.

## Consequences

- The mail stays visible and usable while settings are open, so a change shows at once.
- Each open settings window costs a renderer process; it loads only the accounts store and is
  closed when not in use, so the mail window's budgets do not change.
- Anything that used to be blocked by the modal can now happen alongside settings, so a setting
  must not assume the mail window is idle.
