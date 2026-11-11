# 0034. A row marks its account with the dot alone

- Status: Accepted
- Date: 2026-11-04
- Amends: [0033](0033-account-dot-and-chosen-colors.md)

## Context

0033 put a dot and a derived name on the snippet line. On real accounts the name took room from
the snippet and added little: a personal domain gives a long word, and with few accounts the
colour alone is enough.

## Decision

- **A row shows only the dot,** at the end of the snippet line. The name is gone from the row
  and from the account mark.
- **The full address stays available:** the dot's tooltip, the accessible name of the row, the
  footer's legend and the reader.

## Consequences

- The snippet gets its room back, apart from the dot.
- In the list, colour is now the only visible difference. 0033 let two accounts share a colour
  because the name told them apart; now such rows look the same, and only the tooltip separates
  them. The same holds from the ninth account on, when colours repeat.
