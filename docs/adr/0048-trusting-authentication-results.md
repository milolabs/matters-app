# 0048. Whose Authentication-Results to trust, and who a message says it is from (refines 0037)

- Status: Accepted
- Date: 2026-11-05
- Refines: [0037](0037-remembering-image-choices.md), [0024](0024-rendering-mail-html.md), [0045](0045-forwarding.md), [0047](0047-hostile-mail-corpus.md)

## Context

The corpus of ADR 0047 left nineteen medium gaps. They fall in four places.

- **0037 read the topmost `Authentication-Results` header and believed it.** A server that does not
  strip the header (or only appends its own) lets the sender write a `dmarc=pass` of its own, and with a
  domain rule for the sender, its images load. RFC 8601 section 4.1 says a consumer should not interpret
  the header unless it comes from an authserv-id the administrative domain uses, and section 7.1 says the
  list of trusted ids should start empty. A result also says what it is about (`header.from`), and we did
  not look.
- **The reader showed a name, not a person.** A display name that is another address hid the real one; a
  bidirectional override reordered it; mail that merely claimed the reader's own address was labelled
  "You".
- **A link's text was compared as typed.** Zero-width characters hid an address from the comparison, and
  text drawn by CSS `::before` is not in `textContent`. A `mailto:` went to the system with every field.
- **A reply's first line used the sender's name as Markdown.** ADR 0045 escaped it for a forward only.

## Decision

### 1. Which Authentication-Results header is read

1. The parser reads an `Authentication-Results` header only if its authserv-id (the first segment) is
   one the account trusts. It walks the headers from the top and uses **the first with a trusted id**.
   All the others are ignored, whatever they say. Inside that header the rule of 0037 stays: a fail wins
   over a pass.
2. With nothing trusted, the verdict is `unknown`: the list starts empty (RFC 8601 section 7.1).
3. `MimeParserPort.parse(raw, context?)` takes an optional `ParseContext` with
   `isTrustedAuthServ(id)`. Without a context nothing is trusted. The IMAP sync builds it per account.
4. The rule is a pure function in `packages/core/src/domain/authServ.ts`. An id is trusted when its
   registrable domain is that of the account's IMAP host, or that of the account's address, or when the
   provider table below maps the IMAP host's registrable domain to it. An id with no registrable domain
   is never trusted.
5. A header that starts with a result and not an id (`spf=pass ...`) has no authserv-id. It is not
   trusted.
6. **A `dmarc=pass` counts only when its `header.from` has the registrable domain of the From the app
   shows.** A pass that names another domain, or none, is `unknown`, and the DKIM fallback does not apply
   (DMARC did answer). `dmarc=fail` stays `fail`. The aligned-DKIM rule for a header with no DMARC result
   stays.

### The provider table

The key is the registrable domain of the IMAP host; the value is the registrable domain of the id.

| IMAP host | Key | Id seen | Value | Read |
| --- | --- | --- | --- | --- |
| `imap.gmail.com` (Gmail, and Google Workspace on any domain) | `gmail.com` | `mx.google.com` | `google.com` | the host: Google's IMAP settings page (developers.google.com/workspace/gmail/imap/imap-smtp); the id: a Gmail header quoted in Fortinet's FortiMail documentation (docs.fortinet.com, "Testing email signing and verification") |
| `imap.mail.me.com` (iCloud) | `me.com` | `dmarc.icloud.com`, `spf.icloud.com`, `dkim-verifier.icloud.com` | `icloud.com` | the host: Apple support, "Mail server settings" (support.apple.com/en-us/102525); the ids: the iCloud headers quoted in an issue of an open-source mail client (github.com/karatektus/pl_mail/issues/462) |
| `imap.fastmail.com` (Fastmail) | `fastmail.com` | `mx1.messagingengine.com` | `messagingengine.com` | the host: Fastmail's help page "Server names and ports"; `messagingengine.com` as Fastmail's own mail servers: Fastmail's DNS help page (MX `in1-smtp.messagingengine.com`, SPF `spf.messagingengine.com`); a header with the id `mx1.messagingengine.com`: a public forum post (communityarchive.victronenergy.com, question 163708) that does not say whose mailbox it was |

Two things were not confirmed and are said plainly. The Fastmail id was seen in a header whose mailbox
the source does not name, so the entry rests on `messagingengine.com` being Fastmail's. The iCloud and
Google ids come from third-party quotations, not from the provider's documentation: none of the three
documents its authserv-id. Providers not listed here were not looked up and are not in the table.

The table is code (`KNOWN_AUTHSERV_DOMAINS`), keyed on the IMAP host because Google Workspace on a custom
domain still connects to `imap.gmail.com`, while its address says nothing about Google.

### What a provider outside the table gets

If the receiving server writes an id under the IMAP host's or the address's registrable domain (a
company's own server, most small hosters), nothing is needed. Otherwise the verdict is `unknown`, and
**images then ask** (ADR 0037: `unknown` is not `fail`, but a domain rule needs a `pass` to load images
without asking when the reader chose "ask"). Nothing is wrongly shown; some mail that was shown now asks.

**iCloud is a special case, stated honestly.** iCloud writes one `Authentication-Results` header per
check, each with its own id (`bimi.icloud.com`, `arc.icloud.com`, `dmarc.icloud.com`, ...). The rule
reads the first trusted header only, so only the topmost of them is read. If that one does not hold the
DMARC result, the verdict is `unknown`. The table entry is correct, and iCloud mail will often still get
`unknown` until the rule reads more than one header. That is not done here, on purpose: reading several
headers is what let a forged one in.

### The Microsoft consequence

Microsoft's header commonly starts straight with `spf=pass ...` and has no authserv-id. By point 5 it is
not trusted. **Microsoft mailboxes (Outlook.com, Microsoft 365) get `unknown`. That is a regression
compared with 0037**, which read the DMARC result of such a header. It is accepted: the alternative is to
read a header whose writer cannot be told from the sender. It can be undone for a provider only by a
rule that knows how that provider writes the header.

For an account on Microsoft's servers (`office365.com`, `outlook.com`) nothing is trusted, not even an id
under the account's own domain. The real header there has no id, so a sender's `mx.corp.example;
dmarc=pass` would be the only header that looks trusted, and would also make a forged own address read
"You".

The same exposure remains for any other server that writes no header of its own and does not remove
forged ones, as RFC 8601 section 5 requires: a forged header that names an id under the account's
domains is believed. Where the server does write one, it is above the forged one and is read first.

### A user cannot configure the list yet

There is no setting and no screen for the trusted ids in this change. The list is the rule and the table
above. A person whose provider is missing gets `unknown`; adding an id needs a code change.

### Stored messages

There is no migration. A message already synced keeps the verdict stored with it, which was read by the
old rule. Only mail synced after this change is read by the new one. A reader who wants the new rule for old
mail can delete the account's local data and sync again.

### What the sender still controls

A trusted server is expected to remove any `Authentication-Results` header that carries its own id before
it adds its own (RFC 8601 section 5). If it does not, and a sender writes a header with the trusted id
above the real one, the topmost wins. The parser's tests document this (`cannot tell a forged header from
the server's when both carry the trusted id`). The corpus has no such case: its forged headers carry the
sender's id (`mx.example.org`), the receiving server's is `mx.example.com`.

### 2. Who a message is from, on screen

1. `displayName` removes bidirectional controls (U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069) and
   nothing else: zero-width joiners and non-joiners stay, since real names in Persian, Arabic and Indic
   scripts need them. If the name then holds something shaped like an address that is not the
   participant's own (case-insensitive), it is shown as `name <address>`.
2. `displayName` is for showing only. The composer and the recipient code build addresses from the
   participant, not from this text.
3. A message's sender reads **"You" only when the message is really the reader's**: its verdict is
   `pass`, or it is in the account's Sent or Drafts folder. Any other message that claims the reader's
   address shows its sender as `displayName` does. A recipient line that names the reader's own address
   still reads "You".

### 3. Links

1. `misleadingHost` removes format characters (`\p{Cf}`), controls other than white space, line and
   paragraph separators and the blank letters of Hangul and Braille from the text before it compares.
2. `MailFrame` reports a link's text with what CSS draws: `::before` and `::after` of the link and of
   every element inside it, read from the computed `content` and decoded from the CSS string. Only plain
   strings count (`none`, `normal`, `counter()`, `attr()`, `url()` and an unterminated string are
   ignored). The work is bounded: nothing is read unless a `<style>` names a pseudo-element, since text
   cannot be drawn without such a rule, and at most 4 000 pseudo-element reads are made per measurement
   (the hit-testing cap of 2 000 rects stays).
3. In main, a `mailto:` is **rebuilt** before `shell.openExternal`: the address list, and only
   `subject` and `body`, whatever the case or percent-encoding of the field's name. `attach`,
   `attachment`, `bcc`, `cc`, `to`, keywords, unknown fields and a fragment are dropped (RFC 6068 section
   4: only `subject`, `keywords` and `body` are believed safe). A malformed address is dropped, the first
   of a repeated field wins, and line breaks are removed from the subject so it cannot become a second
   header. Web addresses pass unchanged. The function is `safeMailto` in `apps/desktop/src/main/mailto.ts`.
   The corpus run records the rebuilt value.

### 4. Replies

`attribution` escapes the sender's name with the Markdown escape of forwarding (ADR 0045, rule 5; the
function moved to `markdownEscape.ts` so reply and forward share it). A name that is the address, or no
name, is written as an address, which keeps its `@`. The text part of a message is the Markdown source,
so the escapes are visible in it: a name with `[`, `]`, `*`, `<`, `>`, `~`, a backslash, an `@`, `://`, or
an underscore at the edge of a word shows a backslash in plain text. Ordinary punctuation does not
(apostrophe, comma, period, hyphen, parentheses, quotes, slash, ampersand). That is the cost already
accepted for forwards.

## Consequences

- A forged `Authentication-Results` header no longer grants a pass. Mail from a provider outside the table
  and outside the IMAP and address domains asks before it loads images; Microsoft mailboxes always do.
- A pass for another From, a name that is another address, and mail that claims the reader's address all
  stop looking like what they are not.
- A `mailto:` link that asked for `cc`, `bcc` or `to` fields opens without them. This is visible to a
  reader who clicks such a link.
- Old mail keeps its old verdict.
- The corpus case `identity-own-address-spoof` reads the sender alone. Its message is addressed to the
  reader too, and the recipient rightly reads "You".
