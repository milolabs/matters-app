# 0133. Microsoft mail signs in through the browser

- Status: Accepted
- Date: 2026-11-14
- Amends: [0018](0018-accounts-credentials-background-sync.md) (rule 1: setup asks for a
  password; on Microsoft's servers it asks for a sign-in in the browser. Rule 3: the vault also
  keeps tokens, and renews them),
  [0113](0113-a-refused-password-is-mended-in-place.md) (an account that signs in through the
  browser has *Sign in again* where the others have *Change password*),
  [0114](0114-a-refused-sign-in-says-why.md) (`browserOnly` is no longer a dead end on Microsoft's
  servers; one reason is added, `signInAgain`)
- Relates to: [0008](0008-imap-smtp-first.md) (the mail still moves over IMAP and SMTP),
  [0013](0013-dependency-license-policy.md) (no dependency is added)

## Context

- **Microsoft takes no password from mail apps.** Exchange Online and Outlook.com refuse a
  password over IMAP and SMTP (ADR 0114). Setup stops at "takes only browser sign-in, which
  Matters can't do yet". These are the only large hosts that do not work at all.
- **What Microsoft asks for instead** (its page *Authenticate an IMAP, POP or SMTP connection
  using OAuth*, read 2026-11-14): an application registered with Microsoft Entra, the OAuth 2.0
  authorization code flow, the scopes `https://outlook.office.com/IMAP.AccessAsUser.All` and
  `https://outlook.office.com/SMTP.Send` with `offline_access` for a refresh token, and the SASL
  mechanism XOAUTH2 on both protocols. It holds for Microsoft 365 and for Outlook.com.
- **A desktop app is a public client.** It cannot keep a secret, so it has none: it proves itself
  with PKCE (RFC 7636). RFC 8252 says to use the person's own browser, not a window of the app,
  and to take the answer on a loopback address. Microsoft accepts `http://localhost` with any port
  for such apps and does not support `[::1]`.
- **Half of it was already there.** `Credential` has an `oauth2` shape, the vault's wire format
  checks it, and the IMAP connection takes an access token. The IMAP connector and the SMTP
  adapter refuse anything but a password, nothing gets a token, and nothing renews one.
- **An access token lasts about an hour; a refresh token is replaced when used.** Every place
  that logs in asks the vault first (the scheduler, sends, moves, read state, downloads), so the
  vault is where a fresh token can be handed out.
- **Consent has a limit that code does not remove.** Since November 2020, in an organisation
  that keeps Microsoft's default consent rules, a person cannot agree to an app from a publisher
  Microsoft has not verified when the app is registered elsewhere and asks for more than sign-in.
  Verification needs a Microsoft AI Cloud Partner Program account and a registration made with a
  work account. Personal accounts (Outlook.com, Hotmail, Live) are not under this rule.

## Decision

1. **The person signs in in their own browser.** Matters opens the system browser at Microsoft's
   authorization endpoint (`https://login.microsoftonline.com/common/oauth2/v2.0/authorize`) with
   a PKCE challenge (S256), a random `state`, the address typed as `login_hint`, and
   `prompt=select_account`. Matters never shows Microsoft's page in a window of its own and never
   sees the password or the second factor.
2. **The answer comes to a loopback port.** For one sign-in, main listens on a port the system
   picks, on `127.0.0.1` and, where it can, on `::1` with the same port; the redirect is
   `http://localhost:<port>/`. A port that another program holds on `::1` is not used: another
   is picked, so the browser cannot hand the answer to that program. It takes one request whose `state` matches, answers with a plain
   page that says to go back to Matters, and closes. Matters then comes to the front by itself, so
   the person need not find its window; a cancelled sign-in or one that ran out of time moves
   nothing. Anything else gets 404. The listener closes
   after 5 minutes, when the person cancels, or when the window that asked closes. One sign-in
   runs at a time; a second one cancels the first.
3. **The code is traded for tokens by main, over TLS, with the PKCE verifier and no secret.** The
   scopes are the two above, `offline_access`, and `openid profile email`, so the answer says who
   signed in: its mail address, or its sign-in name, which in an organisation can differ from
   the mail address. If the address typed is neither (any case), nothing is kept and setup says
   which account was signed in and which was asked for.
4. **A release signs in as Matters' own registration; the source names none.** The client id is
   given to the build in `MATTERS_MICROSOFT_CLIENT_ID`: the release workflow passes Matters' own
   from a repository variable, and a copy built by someone else has none unless they bring a
   registration of their own, so a changed copy does not sign people in under Matters' name by
   default. The same variable, set when the app starts, replaces what was built in. The id is
   not a secret and is not treated as one: it is in every released app and in the address of
   the sign-in page; keeping it out of the source only means using it is a choice. With no id,
   browser sign-in is not offered and setup says what it said before. The registration is for accounts in any organisation and personal
   Microsoft accounts, platform *Mobile and desktop applications*, redirect `http://localhost`,
   with the two delegated Exchange permissions.
5. **Tokens stay in main; the refresh token goes nowhere else.** They are kept in the vault of
   ADR 0018 as the account's credential, with the provider's name. The renderer gets neither. The
   backend gets, from `CredentialPort.get`, the access token and when it ends, never the refresh
   token.
6. **A sign-in is held until it has been tested.** What a sign-in gave is held in main's memory
   under a random handle for 10 minutes. Setup passes the handle, not a password, to the backend.
   The backend reads the access token by that handle, logs in to the incoming server and the
   outgoing one as it does with a password (ADR 0018, ADR 0023), stores the account, and asks the
   vault to move what the handle holds to the account's entry. A failure drops it.
7. **The vault hands out a token that still works.** On `get`, when the access token ends within
   5 minutes, main renews it at the token endpoint first, saves what came back (the new refresh
   token too) in the one atomic write of ADR 0018, and answers with the new one. Renewals for one
   account are joined: several callers wait for one request. A renewal that cannot reach
   Microsoft is an `unreachable` failure and is retried as any other.
8. **A sign-in that has ended says so.** When Microsoft refuses the refresh token
   (`invalid_grant`: withdrawn, a changed password, unused for too long), `get` fails as a
   refused sign-in with the reason `signInAgain`. It is treated as the refusals of ADR 0113,
   rule 4: marked, not tried again on its own.
9. **IMAP and SMTP log in with XOAUTH2.** The user name is the server's user name from the
   account's settings and the token is the one token: both scopes belong to one resource. The
   token is a secret to every rule that scrubs secrets from errors and logs.
10. **On Microsoft's servers a refusal means something else now.** With a token, a refusal there
    is no longer `browserOnly`. A provider's own sentence still wins (ADR 0114, rule 2:
    *SmtpClientAuthentication is disabled for the Tenant*); a bare refusal of a token that is
    not about to end is `notAllowed`: IMAP is switched off for the mailbox or the organisation.
    Outlook.com keeps it off until the person turns it on (Microsoft's page *POP, IMAP, and SMTP
    settings for Outlook.com*, read 2026-11-14), so the sentence names the setting and where it
    is, and so does a refusal that gives no reason. No sentence or label about such an account
    speaks of a password: there is none to check or change.
11. **Which accounts sign in this way is read from the host table.** An account whose servers
    are Microsoft's (ADR 0114's table, `browserOnly`) signs in through the browser; there is no
    column for it and nothing to migrate. Setup shows *Sign in with Microsoft* in place of the
    password field, a line that the browser opens, and *Cancel* while it waits. Settings ›
    Accounts shows *Sign in again* in place of *Change password* for such an account, and the
    row opens it by itself on `signInAgain`. It runs rules 1 to 3, tests both servers and
    replaces the entry as a new password is replaced (ADR 0113, rule 3: not when a server
    refused the token; an outgoing server that could not be asked says nothing about it), then
    reconnects (rule 5 there).
12. **What Microsoft says in the browser comes back as a reason.** A person who cancels,
    declines what Matters asks for (AADSTS65004), or closes the tab, gets "The sign-in was not
    finished" and can try again. An organisation that
    does not let its people agree (`access_denied`, `consent_required`, AADSTS65001, AADSTS90094)
    gets a sentence that says an administrator of the organisation has to approve Matters, with
    Microsoft's own description under it as a quote (ADR 0114, rule 3).
13. **No library for it.** The flow is `node:crypto`, `node:http` and `fetch`, in an adapter
    behind a port, so main is the only place that opens the browser and the flow can be run
    against a stand-in server in tests. The authorization server's address can be replaced only
    by a test, and only with a loopback address.

## Consequences

- Outlook.com, Hotmail and Live accounts can be added. Microsoft 365 accounts can be added where
  the organisation lets its people agree to the app, or where an administrator approved it;
  elsewhere the person is told to ask. Publisher verification would end that and is not done.
- Two things leave the computer that did not before, both to Microsoft and only for a Microsoft
  account: the address, as a hint on the sign-in page, and the requests for tokens.
- The owner has to register the application once and set its id as the repository variable
  `MATTERS_MICROSOFT_CLIENT_ID`. Until then the code is there and the screen says what it said.
- Someone who builds from source, a contributor included, has no Microsoft sign-in until they
  register an application of their own and set the variable. The tests need none: they use a
  stand-in server.
- Anyone can still read the id out of a release and use it. Microsoft sends the answer only to
  `localhost` on the computer where the sign-in ran, so that takes a program already running
  there.
- Removing an account deletes its tokens here (ADR 0018, rule 6) but does not withdraw the
  consent at Microsoft; the person does that in their Microsoft account. Setup says so nowhere
  yet.
- Gmail could use the same port and adapter with another provider entry. It is not done: Google
  wants its own review for mail scopes, and an app password works there.
- A token that ends while a connection is open does not close the connection; the next
  connection asks the vault again. An inbox watch open for days has not been tried against
  Microsoft and should be watched.
- A sign-in withdrawn at Microsoft while its access token still has time left shows as "not
  allowed" until the token ends (rule 10), and as `signInAgain` after.
- A person who types an alias of their mailbox is told another account signed in (rule 3), and
  has to type the address Microsoft knows the account by.
- A person with an Outlook.com mailbox has to turn IMAP on there before the first sign-in
  works, as with every mail app that reads Microsoft's mail over IMAP. Only reading through
  Microsoft Graph would spare them that.
- Shared mailboxes, national clouds and reading mail through Microsoft Graph are not covered.
