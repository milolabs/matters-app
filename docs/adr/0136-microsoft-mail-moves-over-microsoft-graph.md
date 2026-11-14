# 0136. Microsoft mail moves over Microsoft Graph

- Status: Accepted
- Date: 2026-11-14
- Amends: [0008](0008-imap-smtp-first.md) (IMAP and SMTP are no longer the only way mail
  moves), [0016](0016-message-identity-and-locations.md) (a location's handle on the server is
  the provider's own; IMAP's is the UID), [0133](0133-microsoft-mail-signs-in-through-the-browser.md)
  (a Microsoft mailbox in the cloud is added over Graph; IMAP with a token stays for a
  mailbox added by server name. Rule 11: which accounts sign in through the browser is read
  from the account's transport first)
- Relates to: [0013](0013-dependency-license-policy.md) (no dependency is added),
  [0135](0135-setup-finds-who-runs-the-mail-and-the-person-can-say.md) (how a mailbox is found
  to be Microsoft's)

## Context

- **IMAP is off until asked on Outlook.com.** Microsoft's page *POP, IMAP, and SMTP settings for
  Outlook.com* (read 2026-11-14) says POP and IMAP access is disabled by default. A real trial
  on 2026-11-14 got a token with both mail scopes, and the IMAP server answered *User is
  authenticated but not connected* on a new mailbox, with the switch on. Organisations switch
  IMAP and SMTP AUTH off for everyone.
- **Microsoft Graph reaches the same mailboxes without that switch.** It is an HTTPS API over
  Exchange Online and Outlook.com mailboxes, for work, school and personal accounts, with the
  delegated permissions `Mail.ReadWrite` and `Mail.Send`.
- **Exchange Web Services is not an option.** Microsoft blocks it in Exchange Online from
  October 2026 unless an administrator allows the app, and removes it in 2027; Graph is the
  replacement it names.
- **What Graph gives, from its documentation (read 2026-11-14):**
  - *Delta query* per folder: `GET /me/mailFolders/{id}/messages/delta` returns pages, then a
    link to ask again for what changed since; removed messages come as `@removed`. It takes
    `$select` and `$orderby=receivedDateTime desc`.
  - *Immutable ids*: with the header `Prefer: IdType="ImmutableId"` a message's id stays the
    same when it moves between folders of the mailbox. It changes when the message goes to an
    archive mailbox.
  - *MIME out*: `GET /me/messages/{id}/$value` returns the message as MIME.
  - *MIME in*: `POST /me/sendMail` with `Content-Type: text/plain` takes a whole MIME message
    in base64, answers `202 Accepted`, and saves a copy in Sent Items.
- **Matters is built on MIME.** The parser, threads, sender checks, attachments and the composer
  all work on the raw message. An adapter that hands over the same MIME changes nothing above
  it.
- **The sync contract speaks IMAP in one place.** A location is `(folder, uidValidity, uid)`
  with a numeric UID (ADR 0016). Graph has no number, only an id.
- **A token is for one resource.** The token of ADR 0133 is for `outlook.office.com` (IMAP,
  SMTP). Graph needs a token for `graph.microsoft.com`; scopes of the two cannot be mixed in one
  token.
- **A desktop app cannot take Graph's change notifications**: they are sent to a public HTTPS
  address.

## Decision

1. **A Microsoft mailbox in the cloud is read and written through Microsoft Graph v1.0.**
   Outlook.com, Hotmail, Live and Microsoft 365. IMAP and SMTP stay for every other server, for
   Exchange on a company's own servers, and for a Microsoft mailbox the person adds as *Another
   mail server* with Microsoft's server names (ADR 0133 as it is).
2. **An account has a transport: `imap` or `graph`.** It is stored with the account; accounts
   that exist are `imap`. A `graph` account stores no server settings. Everything that asked
   the host table "does this account sign in through the browser" asks the transport first.
3. **Sign-in is that of ADR 0133** (rules 1 to 8 and 12), with other scopes: `Mail.ReadWrite`,
   `Mail.Send`, `offline_access`, `openid profile email`. No `outlook.office.com` scope is asked
   for, so the token is Graph's. It is a second provider entry with the same registration and
   the same client id; the screens still say *Microsoft*.
4. **A new adapter, `adapter-graph`, behind the ports that exist.** It implements
   `MailConnectorPort` (sync, Sent, flags, moves, attachments, watching) and `MailSubmitPort`
   with `fetch` and nothing else: no SDK (ADR 0013). The backend picks the adapter by the
   account's transport. Core use cases do not learn that Graph exists.
5. **Sync is delta query per folder, and the message is its MIME.**
   - Folders come from `/me/mailFolders` and their children; Microsoft's well-known folders
     give the roles (inbox, sent, drafts, trash, spam, archive).
   - Each folder is asked with delta query, newest first, selecting only what sync needs (id,
     read state, flag, folder). The cursor is the link to ask again; a page link is kept
     mid-round, so a stop resumes.
   - A message the store does not have is fetched as MIME (`$value`) and parsed by the same
     parser as IMAP mail.
   - The provider id (ADR 0016) is the immutable id. A move is a new location for a known
     message: no download.
   - `@removed` is a removed location; a changed read state or flag is a flag update.
   - A row that lacks the read state, the flag or the draft state is completed with one request
     for the message before it is used, so a state that was not sent is never taken for "no"; a
     message gone by then is left to the next round's `@removed`.
   - A page link that comes back a second time in one round ends the round with an error: a
     list that does not advance is not followed.
6. **A location's handle on the server belongs to the provider.** IMAP's stays
   `(uidValidity, uid)`. For Graph it is the message's immutable id, kept with the location; the
   store gives the copy a number of its own within its folder, so everything that addresses a
   copy by number keeps working. No row of an IMAP account changes.
7. **Read state and moves are single requests.** `PATCH /me/messages/{id}` sets read;
   `POST /me/messages/{id}/move` moves, to a well-known folder for Archive, Trash and Junk.
   Deleting for good is `DELETE`, and only for a message Graph says is in Deleted Items when
   asked just before: the id stays the same when a message moves, so one restored meanwhile
   would be reached; it is *stale*, as one that is gone (ADR 0044, rule 16). A `404` is
   *stale*, a `403` is *rejected*, as the port already says.
8. **A file is cut out of the message's MIME.** The part ids are the parser's, so a download
   fetches `$value` again and streams the one part. Graph's own attachment ids are not used.
9. **Sending is `sendMail` with the MIME the composer built.** `202` is *accepted*. Microsoft
   keeps the Sent copy, so the account has the capability `savesSent` and the copy is found by
   `Message-ID`, as with Gmail. Graph reads the recipients from the message, so the adapter
   adds the `Bcc` header the composer leaves out. A refusal before the body is sent is *rejected*; a broken
   connection after it is *unknown*, as with SMTP. There is no login test to run: the outgoing
   check asks Graph for the Sent Items folder with the token.
10. **New mail is noticed by asking.** While the app runs, the inbox's delta link is asked
    every 30 seconds; an empty answer costs one small request. This stands in for IMAP IDLE
    behind the same `watchInbox`.
11. **Graph's refusals become the reasons the screens know.**
    - `401`: the token is noted as refused and the request fails as one that is tried again;
      the next try asks the vault for a renewed token, whatever time the old one had left (ADR
      0133, rule 7). A `401` for that renewed token is `signInAgain`. Work that still holds the
      old token and meets another `401` is tried again, not counted.
    - `403`: `notAllowed`, with Graph's own message as the quote.
    - `429` and `503`: `throttled` or `unavailable`; `Retry-After` is obeyed.
    - Anything else is a failure of the request, retried as a lost connection is.
12. **Requests go to `https://graph.microsoft.com/v1.0` and nowhere else.** A link Graph
    returns (next page, delta) is followed only when it points there. The token is a secret to
    every rule that scrubs secrets. The address of the service can be replaced only by a test,
    and only with a loopback address (as ADR 0133, rule 13).
13. **Setup adds a mailbox found or chosen as Microsoft over Graph** (ADR 0135): *Sign in with
    Microsoft*, no server fields, no IMAP switch to turn on. The sentences of ADR 0133 about
    IMAP being off stay for accounts on the `imap` transport.
14. **The tests use a stand-in Graph service** in the testkit, as they use a stand-in sign-in
    server: folders, delta pages, MIME, moves, send, and the refusals of rule 11.

## Consequences

- An Outlook.com mailbox works without the person touching Outlook's settings, and a Microsoft
  365 mailbox works where the organisation switched IMAP or SMTP off.
- The consent limit of ADR 0133 stays: in an organisation with Microsoft's default rules an
  administrator still has to approve Matters, now for `Mail.ReadWrite` and `Mail.Send`.
- The owner adds the two delegated Graph permissions to the registration once. The client id
  and the repository variable do not change.
- There are two ways into a Microsoft mailbox. Graph is the one setup offers; IMAP with a token
  is reached only by typing server names. An account does not move from one to the other: it
  is removed and added again.
- Storage changes: accounts get a transport, locations get the provider's handle. A migration
  adds both: the accounts table is built again with the same rows, so that a Graph account
  holds no server columns, and the handles get a table of their own. No message is rewritten.
- A file download costs the whole message again, since the part is cut from its MIME. Large
  messages with one small file pay for it.
- Mail arrives up to 30 seconds later than with IDLE, and the app asks Microsoft twice a minute
  per Microsoft account while it runs.
- Not known until tried against Microsoft, and to be tried before this is called done:
  - the largest message `sendMail` takes as MIME (the documentation gives no number);
  - that `Bcc` recipients in the MIME are delivered and the header is not shown to others;
  - how delta query orders and pages a large personal mailbox;
  - how often a normal day's use meets `429`.
- Not covered: Exchange on a company's own servers (IMAP), shared mailboxes, archive
  mailboxes, national clouds, calendars and contacts, categories and the Focused inbox.
- Search stays local, as for every account.
