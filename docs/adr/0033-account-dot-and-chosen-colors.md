# 0033. The account is a dot and a name, in a colour the user can choose

- Status: Accepted
- Date: 2026-11-04
- Amends: [0032](0032-account-mark-in-the-list.md)

## Context

0032 marked a row with a letter badge. After trying it on real accounts, the user preferred a
dot and a name: a letter says little when two addresses begin alike. The colours also had to be
explainable and choosable, and the reader did not say which account a letter belongs to.

## Decision

- **A row shows a dot and a name instead of the badge,** on the snippet line, right-aligned.
  The name is the first label of the address's domain in lower case; accounts that would
  share a name use their local part. The full address is in the tooltip and the accessible name.
- **Eight palette colours,** each with a fill for white letters and a theme-aware `--acct-<id>`
  value for the small dot, so the dot holds 3:1 on the light and the dark background.
- **The colour is stored per computer in local storage,** not in the account table: it is a
  display preference, so it needs no migration and no worker command. A default is assigned
  once, from the first free colour, and kept, so removing an account moves no other colour.
- **A legend:** hovering or focusing the footer's account button lists every account with its dot.
- **A picker in the accounts panel:** a swatch per colour next to each account. Two accounts may
  share a colour; the name tells them apart.
- **The reader names the account** whenever there is more than one, whatever the query says.

## Consequences

- Colours do not sync with anything and are lost with the local storage of this computer.
- The row's snippet loses up to about 110px to the name.
- The name is derived: `mail.firma.pl` gives `mail`.
- No colour outside the palette can be chosen.
- The letter remains only in the footer's avatars.
