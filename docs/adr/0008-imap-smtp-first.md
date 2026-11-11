# 0008. IMAP and SMTP as the first provider

- Status: Accepted
- Date: 2026-11-03

## Context

The client must work with every mailbox. Gmail API and Microsoft Graph are
better for their own services but cover only them. Exchange EWS is being
disabled in Exchange Online from 2026-10-01 and shut down from 2027-04-01.

Gmail via IMAP exposes `X-GM-EXT-1` (`X-GM-THRID`, `X-GM-LABELS`,
`X-GM-MSGID`, `X-GM-RAW`), supports CONDSTORE but not QRESYNC, and limits
connections and daily transfer. Google's OAuth scopes for mail (including
`https://mail.google.com/` used by IMAP) are restricted and require a paid
security assessment for a verified public app. Microsoft has disabled password
login for IMAP/SMTP; its OAuth app registration is free.

## Decision

- First provider adapters: `adapter-imap` (imapflow, MIT) and `adapter-smtp`
  (nodemailer, MIT).
- Sync per folder: UIDVALIDITY check → new UIDs → `CHANGEDSINCE` flags →
  deletions via `VANISHED` (QRESYNC) or UID-set comparison.
- Gmail: sync only All Mail, Trash and Spam; labels from `X-GM-LABELS`; thread
  ids from `X-GM-THRID`. Exposed as capabilities, not a special case.
- Connections: one IDLE on INBOX, one for background sync, one reserved for
  user actions so opening a message never queues behind sync.
- Fetch `ENVELOPE`, `BODYSTRUCTURE`, `FLAGS` first; text parts next; attachments
  on demand; always `BODY.PEEK`.
- Use `COMPRESS=DEFLATE` when offered.
- Sending: SMTP, then `APPEND` to Sent unless the server saves a copy itself
  (Gmail does).
- Special folders by `SPECIAL-USE`, falling back to names incl. Polish
  ("Wysłane", "Elementy wysłane", "Kosz", "Śmieci").
- Account setup: Mozilla ISPDB + DNS SRV autodiscovery.
- Auth in the MVP: password over TLS (Gmail app passwords); OAuth (XOAUTH2)
  next, Microsoft first.
- Integration tests against Dovecot in Docker.

Later adapters behind the same ports: Gmail API, Microsoft Graph, JMAP.

## Consequences

- Works with any IMAP server from day one.
- Gmail users without 2FA/app passwords need OAuth, which needs either Google
  verification or a user-supplied client ID.
