# 0031. The result count is on the active tab

- Status: Superseded by [0093](0093-a-tab-number-is-always-unread.md)
- Date: 2026-11-04
- Amends: [0027](0027-saved-views.md), [0029](0029-query-bar-full-width.md)

## Context

0029 put the message count at the end of the query strip. The count describes the list a view
shows, and the tabs already name that list and carry a number, so the strip was a second place
to look for it. It also took width from a long query.

## Decision

- **The active tab shows how many messages the list holds,** `50+` while more can be loaded,
  and the strip shows no count.
- **The other tabs keep their unread badge** from 0027. Counting all matches of every view is
  not done: the badge's cost is bounded by its cap and by `is:unread`.
- **The active tab's number replaces its unread badge.** The name read by assistive technology
  says which one it is: `3 results` or `3 unread`.

## Consequences

- No new request: the number is what the list has already loaded, so it moves with the keystroke.
- One position means two things, depending on whether the tab is active. A tab's number can
  change when it is selected.
- A tab's width follows its number, so the tabs after the active one can shift while typing.
