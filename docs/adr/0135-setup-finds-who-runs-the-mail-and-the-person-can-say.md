# 0135. Setup finds who runs the mail, and the person can say

- Status: Accepted
- Date: 2026-11-14
- Amends: [0023](0023-lookup-by-mx-and-probing.md) (lookup also names who runs the
  domain's mail, from DNS; "no table of providers" now has a short table of DNS signs),
  [0114](0114-a-refused-sign-in-says-why.md) (the host table also says which providers can be
  chosen by hand)
- Relates to: [0018](0018-accounts-credentials-background-sync.md) (the lookup order),
  [0133](0133-microsoft-mail-signs-in-through-the-browser.md),
  [0136](0136-microsoft-mail-moves-over-microsoft-graph.md) (what a Microsoft mailbox is added
  as)

## Context

- **Setup knows a provider only through a server name.** Lookup (ADR 0018, 0023) ends in an
  IMAP host; the host table of ADR 0114 then says what that host wants. A company address
  (`jan@firma.pl`) reaches Microsoft only when its MX record leads to settings that ISPDB
  publishes.
- **That fails where a mail gateway stands in front.** With Proofpoint, Mimecast or Barracuda the
  MX record names the gateway. Lookup then finds nothing or probes the wrong names, and the
  person has to type Microsoft's servers before *Sign in with Microsoft* appears.
- **The domain says more than its MX record.** A domain on Microsoft 365 nearly always has
  `autodiscover.<domain>` as a CNAME to `autodiscover.outlook.com`, and an SPF record that
  includes `spf.protection.outlook.com`. Google Workspace has `_spf.google.com` in SPF. All of it
  is public DNS, asked about the domain only.
- **There is no way to say it by hand.** *Not right?* opens the server fields. A person who knows
  "this is Microsoft 365" cannot say so; they have to know server names. Thunderbird lets the
  person pick the kind of account.
- **A sign is not proof.** An SPF include only says the domain may send through that provider; a
  company can send newsletters through Microsoft and keep its mailboxes elsewhere.

## Decision

1. **Lookup also answers "who runs this mail".** Besides servers, lookup gives a provider when
   the domain shows one. The signs, in the order of their weight:
   - **the mail exchanger's name**: `*.mail.protection.outlook.com` and
     `*.olc.protection.outlook.com` are Microsoft; `*.google.com` and `*.googlemail.com` are
     Google;
   - **`autodiscover.<domain>`** as a CNAME ending in `outlook.com`: Microsoft;
   - **the SPF record** (`TXT` on the domain) including `spf.protection.outlook.com` or
     `_spf.google.com`.
   The first two decide. SPF alone is a hint: it puts that provider first in the list of rule 3
   and decides nothing.
2. **Only the domain is asked about, and only DNS is asked.** Three more questions go to the
   system's resolver: the `TXT` records, and the `CNAME` of `autodiscover.<domain>`; the MX
   records are already read. Nothing is asked of Microsoft or Google: not their tenant lookups,
   not Autodiscover itself. The address and the password still do not leave (ADR 0023, rule 2).
3. **The person can always say who runs the mail.** Under what setup found, *Not right?* opens
   a short list in place of the server fields:
   - the providers Matters knows how to add by name (Microsoft 365 or Outlook.com; Google);
   - *Another mail server*, which opens the server fields as today.
   Choosing a provider sets everything that follows from it: how the mailbox is reached and how
   the person signs in. No server name is typed. When lookup found nothing, the list is shown
   at once instead of empty server fields.
4. **What the person says wins over what was found.** The choice is kept for this setup until
   the address changes. The login test still has the last word (ADR 0023, rule 3).
5. **The line says what was found, in the provider's name.** *Found Microsoft 365 for
   firma.pl*, not a server name, when a provider was found; the server name is shown only for
   *Another mail server*.
6. **The signs live in one table, next to the host table.** A provider's entry lists its DNS
   signs and whether it can be chosen by hand. Server names for a provider chosen by hand come
   from the same place lookup would have found them (ISPDB for the provider's own domain), not
   from the table, so the table still holds no server settings.

## Consequences

- A company on Microsoft 365 behind a mail gateway is found. One with unusual DNS is one click
  from the right answer, not a search for server names.
- A wrong sign (a domain that only sends through Microsoft) offers Microsoft first; the person
  picks *Another mail server*. The login test catches the rest.
- The table of signs has to be kept: a provider that renames its exchangers is no longer
  found, which costs a click, not a broken account.
- Three more DNS questions per setup. They run beside the lookup that is already there and are
  dropped after the same wait.
- Only two providers can be chosen by name at first. Others (iCloud, Yahoo, Fastmail) are
  found through ISPDB as before and can be added to the list later; none needs code beyond a
  table entry.
