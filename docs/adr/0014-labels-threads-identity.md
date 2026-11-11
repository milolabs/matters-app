# 0014. Labels, threads and message identity

- Status: Accepted
- Date: 2026-11-03

## Context

Gmail has labels (a message can carry many); IMAP has folders (a message is in
one). JMAP models both as mailboxes with membership. Gmail provides thread ids;
plain IMAP does not. The same message can arrive in two accounts or two
folders.

## Decision

- **Everything is a label internally.** An IMAP folder is an exclusive label;
  moving a message in IMAP is a label change.
- **Threads**: provider thread id when the `threads` capability exists
  (Gmail `X-GM-THRID`); otherwise computed locally from `References` /
  `In-Reply-To` (JWZ algorithm), with subject matching as a fallback.
- **Identity**: a message is keyed by (account, provider id); `Message-ID`
  links duplicates across folders and accounts.

## Consequences

- One data model for every provider; later Gmail API / Graph / JMAP adapters
  map into it.
- Local threading must be tested against real-world broken headers.
