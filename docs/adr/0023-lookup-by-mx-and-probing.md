# 0023. Lookup through MX and probing, outgoing test before saving

- Status: Accepted
- Date: 2026-11-04
- Amended by: [0113](0113-a-refused-password-is-mended-in-place.md) (an account's password can be
  replaced, verified first; nothing else of an account is editable yet)
- Amended by: [0114](0114-a-refused-sign-in-says-why.md) (a short table of hosts' sign-in rules,
  keyed by a server already found, never used to find one)

## Context

ADR 0018 finds servers through the domain's own autoconfig, Mozilla's ISPDB and
DNS SRV. All three ask about the address's domain, so a company domain hosted
elsewhere (Zoho Mail, OVHcloud) or running its own server usually finds nothing,
and its owner has to type server names. Only the incoming server was tested, so
a wrong outgoing setting showed up at the first send, and accounts cannot be
edited yet. (Amended by ADR 0113: the password can be replaced in place, after the
same login tests; the address, user name and servers still cannot.)

We keep no table of providers in the code: server names change, and the list
would never be complete. (Amended by ADR 0114: a few hosts' sign-in rules, such as
"app password only" or "browser sign-in only", are kept by server name; finding
servers still uses no table.)

## Decision

1. **Two more lookup steps follow ADR 0018's order**, all from public data:
   - **MX**: resolve the domain's MX records and ask ISPDB about the domain of
     each mail exchanger, from the most specific name down
     (`mx1.mail.ovh.net`: `mail.ovh.net`, then `ovh.net`). A domain on a host
     gets the host's published settings. This is what Thunderbird does.
   - **Probing**: connect to `imap.<domain>`, `mail.<domain>` and a mail
     exchanger inside the domain, on 993 and 143, and to `smtp.` and the same
     names on 465 and 587. A server counts if it greets in the right protocol,
     with a valid certificate on the TLS ports or by offering STARTTLS.
     Nothing is logged in to.
2. **Only the domain leaves the device during lookup**, and exchangers' domains go
   to ISPDB. The address and the password do not.
3. **The login test has the last word.** A published setting can be wrong for a
   given account, and then the screen opens the server settings.
4. **The outgoing server is tested too**: connect and log in, nothing is sent. If
   it fails nothing is saved and the error says incoming mail works; the user can
   correct the settings or add the account without sending.

## Consequences

- Most mailboxes need an address and a password, without us maintaining a list.
- Results are only as good as ISPDB. For example it lists `imap.zoho.eu`, while
  Zoho documents `imappro.zoho.eu` for organization accounts. Those users may
  have to correct the server by hand; the fix belongs in ISPDB, not in this code.
- Probing opens up to a dozen short connections to the domain's own servers.
- A temporarily unreachable outgoing server blocks adding unless the user chooses
  to add without sending.
