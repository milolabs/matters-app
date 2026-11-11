# 0032. Rows mark their account when a view mixes accounts

- Status: Accepted
- Date: 2026-11-04

## Context

A row did not say which account a message belongs to. With several accounts in one view, the
same mail sent to two of them looks like two identical rows, and nothing tells which inbox a
message will be answered from.

## Decision

- **A round 16px badge with a letter sits in the row's meta area, right before the date.** The
  row stays 68px high.
- **The letter is the first letter of the address's domain** (`G` for `alex@gmail.com`). When
  two accounts would share that letter, those accounts use the first letter of the local part
  instead. If they still collide, the colour tells them apart.
- **The colour is a position in a fixed palette of six,** by the account's place in the list
  (ordered by creation). The seventh account reuses the first colour.
- **The footer avatars use the same letter and colour,** so they are the legend.
- **Badges show only when the view mixes accounts:** there is more than one account and the
  query does not pin exactly one (`account:` with one id, alone or inside `and`; `or` and `not`
  do not pin). The rule reads the query, never the results, so badges do not flicker while typing.
- Assistive technology reads `Account <address>`; hovering the badge shows the address.

## Considered and rejected

- **Tinting the unread dot:** one mark would mean two things, unread and account.
- **A dot beside the date:** that is where the flag sits.
- **Sections per account:** they break the single timeline.

## Consequences

- No backend change and no change to the row height.
- Removing an account shifts the colours of the accounts after it.
- The letter and colour have to be learned; the footer and the hover title help.
- A letter can change when an account is added and a domain letter starts to collide.
- Beyond six accounts, colours repeat. The footer shows only the first three accounts, so from
  the fourth on the legend is incomplete and the hover title has to do the work.
