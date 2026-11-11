# 0093. A tab's number is always its unread mail

- Status: Accepted
- Date: 2026-11-09
- Supersedes: [0031](0031-result-count-on-active-tab.md)
- Amends: [0027](0027-saved-views.md) (badges)

## Context

0031 put the list's message count on the active tab and kept the unread badge on the others, and
accepted that one position would mean two things. In use it read as a bug: `Inbox 99+` became
`Inbox 200+` when selected, and `All Sent 4` became `All Sent 261+`. The `+` meant two things too:
"at least 99" on a badge, "more can be loaded" on the active tab.

## Decision

- **Every tab shows the same number, selected or not: its unread mail**, as 0027 counts it (the
  view's query AND `is:unread`, capped at 99, off the keystroke path). The number follows the
  saved query, not the text being typed, so it does not move when a tab is selected or edited.
- **`All mail` has a badge too**: it counts `is:unread`, first in the run, by the same rules.
- **The result count of a search sits beside the `Results` heading** at the top of the list,
  `50+` while more can be loaded. Inside a view the list keeps its day headings and shows no
  count.

## Consequences

- A tab's number no longer changes on selection, and the tabs after it no longer shift while
  typing.
- Typing in a view gives no count; the list itself is the feedback. A search from `All mail`
  still shows its count, in the list.
- One more count request per run (`All mail`), bounded by the cap like the others.
- 0031 is superseded; its wording in the tab code is gone.
