# 0114. A refused sign-in says why

- Status: Accepted
- Date: 2026-11-10
- Amends: [0023](0023-lookup-by-mx-and-probing.md) (context: "no table of providers"; a short
  table of hosts' sign-in rules is kept, by server name, and is never used to find servers)
- Relates to: [0113](0113-a-refused-password-is-mended-in-place.md) (what each reason does to a
  saved account's sync: stop, open the password form, or retry slowly)

## Context

- **One sentence for every refusal.** Whatever the server said, adding an account showed "The
  server refused the sign-in. Check the password. Many hosts want an app password, or IMAP turned
  on...". A wrong password, a host that wants an app password, IMAP switched off and a host that
  wants one sign-in on its website first all looked the same. The IMAP adapter kept the server's
  answer in `ImapAuthError`'s message and nothing read it.
- **Servers do say why.** IMAP has response codes for it (RFC 5530: `AUTHENTICATIONFAILED`,
  `AUTHORIZATIONFAILED`, `EXPIRED`, `PRIVACYREQUIRED`, `CONTACTADMIN`, `UNAVAILABLE`, `LIMIT`), and
  SMTP has reply and enhanced status codes (RFC 4954, RFC 3463: 535 / 5.7.8, 530, 538 / 5.7.11,
  454 / 4.7.0). Large providers send a specific sentence with a generic code: *Application-specific
  password required*, *Web login required*, *Please log in via your web browser*, *basic
  authentication is disabled*, *SmtpClientAuthentication is disabled for the Tenant*.
- **Microsoft takes no password over IMAP.** Exchange Online turned basic authentication off for
  IMAP and POP in 2022 and 2023, and Outlook.com followed for mail apps in 2024. Its published
  settings still list `password-cleartext` next to OAuth2, so the setup asked for a password that
  could only fail. The honest "needs browser sign-in" screen showed only when a file listed OAuth2
  alone. A company domain on Exchange Online reaches the same servers through its MX records
  (ADR 0023: `*.mail.protection.outlook.com` leads ISPDB to `outlook.com`).
- **Hints existed for two hosts.** Gmail and iCloud got a line under the password field saying an
  app password is needed; everyone else got "With two-factor sign-in, most hosts want an app
  password here", including hosts where IMAP must be switched on in webmail first.
- **TLS showed Node's text.** "Could not make a secure connection to ...: unable to verify the
  first certificate", and anything unclassified showed "Adding the account failed: <message>".

## Decision

1. **The adapters decide why, as a closed set.** `SignInRefusal` in core is `credentials`,
   `appPassword`, `webLogin`, `imapOff`, `browserOnly`, `notAllowed`, `expired`,
   `encryptionRequired`, `unavailable`, `throttled` or `unknown`; `TlsProblem` is `expired`,
   `nameMismatch`, `selfSigned`, `untrusted`, `noEncryption` or `other`. An adapter's error carries
   them as `detail` (`FailureDetail`) next to its `kind`, and `failureDetailOf` reads it by shape,
   keeping only known values. Logic only looks at these values.
2. **Evidence, in this order.** A provider's specific sentence first (core's `refusalFromWording`,
   since a generic code often comes with a specific sentence), then the protocol's code
   (`imapRefusal`: the RFC 5530 code from imapflow or from the text; `smtpRefusal`: the enhanced code,
   then the reply code), then a text that sounds temporary, else `unknown`. On a host the table
   below marks browser-only, every refusal but `unavailable` and `throttled` is `browserOnly`,
   since Microsoft answers a refused password with a bare "LOGIN failed.". TLS problems come from
   Node's error code and text (`tlsProblemOf`), including the system code nodemailer replaces with
   `ETLS`.
3. **The server's own sentence is a quote, never logic or a log line.** `serverSentence` cuts the
   protocol prefix (IMAP tag, status and `[CODE ...]`, SMTP reply and enhanced codes), replaces
   every secret and every address but the user name the person typed, drops links with a query
   (Gmail's carry a sign-in token), removes control and direction characters and caps the text at
   200 characters. It travels as `detail.serverText` only; `ImapAuthError`'s message no longer
   contains it and says the reason code instead ("... on imap.x.pl (appPassword)").
4. **The wire carries it unchanged.** `ErrorResponse` gets an optional `detail`; the handler adds
   it for any error that has one; `BackendError` keeps it. `OutgoingCheck` and
   `OutgoingServerError` carry it for the outgoing server.
5. **One sentence per reason, the quote under it.** `explainFailure` gives one plain sentence with
   the next step for each reason; `unknown` keeps the old sentence. `failureEvidence` gives the
   smaller line under it: "The server said: “...”" for a refusal, and "Details: ..." with the raw
   error where the sentence had to stay general (TLS, an outgoing failure, an unclassified error).
   TLS and unclassified failures lead with a human sentence; the raw text is only the detail.
   The sentences live in one function (`refusalSentence`) and say a next step that exists where
   they are read: in setup ("the settings above"), in the form that mends a password (only the
   password changes there), and in an account's row, where the sync stopped (*Sync now*) or tries
   again by itself.
6. **Microsoft goes to the honest screen whatever its file lists.** `takesPassword(servers)` is
   false for Microsoft's servers (`needsBrowserSignIn`), so the setup shows "{domain} is on
   Microsoft's mail, which needs browser sign-in." instead of the password step. There is no way
   to try a password anyway on those servers: we know of no case in which a password works there
   over IMAP. "Enter the servers" stays, for a company that runs its own server or gave another way
   in; if the person types Microsoft's servers there, the refusal says browser-only.
7. **A short table of hosts' sign-in rules, in one place.** `HOST_RULES` in core
   (`domain/hosts.ts`) lists, by exact server name, hosts whose sign-in is not "the mailbox
   password works": app password only (iCloud, Gmail, Yahoo Mail, AOL Mail, Fastmail), IMAP to be
   switched on in webmail first (GMX, WEB.DE, WP Poczta, o2 Poczta, Onet Poczta, Poczta Interia),
   browser sign-in only (Microsoft's IMAP and SMTP servers). It gives the line under the password
   field before anything is tried, and names the host in a `credentials` or `appPassword` refusal.
   This amends ADR 0023's "no table of providers": it holds no server settings and plays no part in
   finding servers, and a host that is missing costs a hint, not a setup.
8. **The reason travels with the sync's status too.** A sync or watch that is refused carries
   the adapter's `detail` in its `error` status, so the account's row and the status line say the
   reason, and ADR 0113 decides by it what the sync does: `unavailable` and `throttled` are retried
   on a slow schedule, every other refusal stops background logins until the person acts, and
   only `credentials`, `appPassword`, `expired` and `unknown` open the password form.

## Consequences

- The facts in the table come from the providers' own help pages as of 2026 and can go stale: a
  host may drop app passwords, start requiring them, or rename a server. Only plain statements are
  made (no URLs but the two Gmail and iCloud already showed), and a wrong entry means a wrong hint,
  which the server's own answer and quote then correct. How sure we are, per entry: Microsoft
  browser-only, Gmail, iCloud, Yahoo Mail, AOL Mail and Fastmail app passwords: high. The
  "turn IMAP on" rule for GMX, WEB.DE, WP, o2, Onet and Interia: fairly high. Their exact server
  names (`poczta.o2.pl`, `imap.poczta.onet.pl`, `poczta.interia.pl`, `mail.gmx.net`): fairly high;
  a miss only hides the hint.
- Nothing here was tried against a real server. The wordings and codes are matched from what
  providers and the RFCs document; tests use synthetic answers in those shapes. An answer worded
  differently is `unknown` and shows the old sentence with the server's quote under it, which is
  still more than before.
- A sync error's message no longer holds the server's text for a refused password; it travels in
  the status's `detail` and the account's row quotes it (rule 8).
- A custom domain on Exchange Online whose MX lookup finds nothing (ISPDB down) still reaches the
  manual servers step, as before.
- Microsoft accounts cannot be added until browser sign-in exists; the screen says so up front
  instead of after a failed password.
