# 0072. The name is Matters

- Status: Accepted
- Date: 2026-11-08

## Context

The product was called Unclosed while it was being built. The owner chose a new name, Matters, with
the domain getmatters.app. The built-in view that holds the things that matter is already called
Matters, and that stays: the product and its main view now share a name on purpose.

Electron derives two things from `app.name`, which comes from the `name` field of
`apps/desktop/package.json` (there is no `productName`): the userData folder and the macOS Keychain
"Safe Storage" item that encrypts the saved passwords. Renaming either one silently would start
the app with an empty folder and a new Keychain item. The owner would be asked for every password
again and the local data would look gone.

## Decision

The product is called Matters, everywhere a person, a server or a recipient can see it, and in the
code that names it.

Renamed in this step:

- Copy in the app: window title, wordmark, notices, notifications, error messages, the application
  menu label, the quarantine agent name written on received files.
- What reaches servers and recipients: the IMAP ID client name, the default SMTP EHLO name
  (`matters.local`), the class of the compose HTML body (`matters-body`).
- The workspace scope of the 13 library packages: `@unclosed/*` is now `@matters/*`; the root
  package is `matters`. The boundary checker, the build config, the lint globs and the lockfile
  follow.
- Environment variables `UNCLOSED_*` are `MATTERS_*`, including the smoke and security-event stdout
  prefixes and the `--matters-smoke` and `--matters-trace` flags.
- IPC channels and the MessagePort (`matters:*`), window message keys (`mattersXxx`), the utility
  process service name, log prefixes, the savepoint name, temp directory prefixes and the dev CSP
  plugin name.

Deliberately keeps the old name for now:

- The desktop package name `@unclosed/desktop`. It decides the userData folder and the Keychain
  Safe Storage item. `app.setName`, `productName` and the `app.getPath` behaviour are untouched.
- The files inside userData: `unclosed.db`, `credentials.json`, `window.json`,
  `notifications.json` and the directories next to them.
- The persistent localStorage keys that start with `unclosed.` (account colours, list width, pane
  width, agent preferences, the image setting migration).

A later step moves the userData folder and the Keychain item to Matters together, with a
migration that copies the data and re-encrypts the credentials, so nobody has to sign in again.
Only after that step do the desktop package name, the database file name and the localStorage
keys change.

That later step is done: see [ADR 0105](0105-the-app-identity-moves-to-matters.md).

## Consequences

- Imports, scripts and docs use the new scope and variable names from now on. Anyone with an old
  checkout or a shell profile that sets `UNCLOSED_*` has to rename them.
- Until the migration, the code and the data folder disagree on the name. That is a known, listed
  exception, not an oversight; the list above is the whole list.
- Older ADRs keep their text; only the product name and the variable names in them were updated.
