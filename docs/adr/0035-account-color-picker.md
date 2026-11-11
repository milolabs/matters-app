# 0035. The account's colour is chosen with a colour picker

- Status: Accepted
- Date: 2026-11-04
- Amends: [0033](0033-account-dot-and-chosen-colors.md)

## Context

0033 let the user pick a colour from eight swatches shown for each account. They took a whole
row of the accounts panel for a choice made once.

## Decision

- **A native colour input replaces the dot before the address** in the accounts panel. The
  swatch row is gone.
- **Any colour may be chosen.** The eight palette colours remain only as defaults, handed out
  to new accounts as before.
- **A custom colour is stored as `#rrggbb`,** lower case. A palette id persisted earlier is
  still read.
- **The footer letter is white or dark,** whichever has at least 4.5:1 contrast on the account's
  colour.

## Consequences

- No reserved row and no custom popup to maintain.
- The system picker's look varies by platform.
- A custom colour is not adjusted per theme, so a very dark one is faint on the dark
  background and a very light one on the light background. The 3:1 guarantee of 0033 holds
  only for palette colours.
- Two accounts may end up with similar colours; nothing prevents it.
