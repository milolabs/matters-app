# 0018. Accounts, credentials and background sync

- Status: Accepted
- Date: 2026-11-03

## Context

The desktop app syncs only through a dev tool. Users need to add an account in
the app, keep their password safe, and have mail arrive while the app runs,
without the UI ever slowing down (ADR 0012). Electron's `safeStorage`
(OS keychain-backed encryption) is available in the main process only, while
sync runs in the backend utility process (ADR 0005).

## Decision

1. **Account setup** asks for the email address and password (an app password
   for Gmail; ADR 0008). Server settings are discovered in this order:
   the provider's own autoconfig (`autoconfig.<domain>`), Mozilla's ISPDB,
   DNS SRV (RFC 6186), then manual entry. Only the **domain** leaves the
   device during discovery, never the address or password. The connection is
   tested (login + list folders) before the account is saved.
2. **Transport security**: TLS (port 993) or STARTTLS is required.
   Plaintext connections are refused unless `MATTERS_ALLOW_INSECURE_IMAP=1`
   is set, which only the test server uses.
3. **Credentials** live in the main process: encrypted with `safeStorage`,
   stored in a file in `userData`, never in SQLite, logs or the renderer's
   storage. The backend reads them through `CredentialPort`, implemented as a
   request over a dedicated `MessagePort` to main. The renderer sends the
   password once, during setup, and never receives it back.
4. **Accounts** (address, display name, server settings, no secrets) are
   stored in SQLite.
5. **Background sync** in the backend:
   - full `syncAccount` at startup and every 15 minutes,
   - IDLE on INBOX on a dedicated connection; a new-mail event syncs INBOX,
   - one sync per account at a time; reconnect with exponential backoff,
   - status (idle / syncing with progress / error) pushed to the renderer,
     which updates its list from `changesSince`.
6. **Removing an account** asks for confirmation and deletes its messages,
   bodies, index entries, cursors and credential.
7. **Budgets hold during sync**: a dedicated smoke run measures search and
   open-thread latency while a large initial sync is in progress.

## Consequences

- Users can add an account without knowing server names in most cases.
- Discovery reveals the email domain to Mozilla and to DNS; this is stated in
  the setup screen.
- If `safeStorage` is unavailable (e.g. Linux without a keyring), the app
  refuses to store the password and says why, instead of saving it in plain
  text.
