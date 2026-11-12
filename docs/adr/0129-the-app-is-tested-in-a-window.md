# 0129. The app is tested in a window, on every change

- Status: Accepted
- Date: 2026-11-13
- Builds on: [0018](0018-accounts-credentials-background-sync.md),
  [0122](0122-security-policy-and-checks-on-every-change.md)
- Amends: [0128](0128-tests-are-not-scanned.md), rule 1 (the end-to-end specs leave the scan too)

## Context

CI checks types, lint, boundaries, licenses and the tests (ADR 0122), and packages the app. It
never starts it. The smoke runs do start it, but they measure: each one checks a budget from a
script inside the page and quits. They run by hand, on macOS, and the ones that need the Docker IMAP
server cannot run on a macOS runner at all.

So the first thing a new user sees, the setup screen, was never used in a window by anything but a
person. The unit tests cover its parts and the integration tests cover adding an account below the
UI; nothing typed an address, waited for the lookup, filled in the servers, connected, and found
the mail in the list. A change that broke that path between the parts would pass every check.

## Decision

1. **Playwright drives the built app.** `@playwright/test` and its Electron support start the app
   from `apps/desktop` as `electron-vite build` left it, the way a developer starts it, and act
   through roles and labels a person would see. No browser is downloaded; Playwright's ffmpeg is,
   for the videos.
2. **The suite lives in `apps/desktop/e2e`.** Specs are named `*.e2e.ts`, so `bun run test` never
   loads them. A fixture gives each test a data folder of its own and starts the app in it
   (`MATTERS_DB_PATH`, `MATTERS_USER_DATA`); a test may start it again on the same folder. Every
   start is filmed and traced, and leaves a last screenshot and the app's output; all of it goes to
   `.e2e/`, which git ignores.
3. **No hook in the app.** The app runs with no smoke mode, no seeded account and no permission for
   plaintext servers. The only things passed in are what a person could pass: Chromium's own
   keychain switch on the command line (a mock keychain on macOS, so the login keychain never asks;
   GNOME Keyring on Linux, which Chromium cannot guess on a runner without a desktop), the demo
   mailbox (`MATTERS_SEED=1`) for the specs that use it, and Node's `NODE_EXTRA_CA_CERTS`.
4. **The setup screen is typed in, against a real server.** The setup screen offers TLS and
   STARTTLS only, and the Dovecot test server speaks plaintext. The UI stays as it is: each test
   puts a TLS front on 127.0.0.1 before the test server, and another before an SMTP server in the
   test's own process, with a certificate from a CA made for that test by `openssl` (as the
   transport tier of the corpus does). The app is told to trust that CA through
   `NODE_EXTRA_CA_CERTS`, and connects as it would to a mail host: TLS from the first byte, the
   certificate checked against the name typed.
5. **What is covered**: the first start (setup screen, account, first sync, the mail in the list,
   the same mail and a working sync after a restart); sending, with the message checked as the SMTP
   server received it; reading and archiving, checked on the IMAP server; and on the demo mailbox
   reading a thread, a search in the query bar, `j` and `k`, and the settings window. AI is not
   covered yet: the demo runtime is not on until it is chosen and tested in the settings, and that
   is a spec of its own.
6. **It runs on every pull request**, in a second CI job on `ubuntu-latest`, which has Docker:
   `bun run test:e2e` under `xvfb-run`, inside a D-Bus session with GNOME Keyring unlocked, so
   `safeStorage` has a real backend and the app saves the password as it would for a person. A
   failed test is tried once more. The report, with every video, trace and screenshot, is kept as
   an artifact for 14 days, whether the job passed or not.
7. **Two commands.** `bun run test:e2e` builds the app and runs every spec inside
   `tools/imap-test-server/run.ts`, which starts the server in Docker. `bun run test:e2e:demo` runs
   the demo specs only, without Docker. Without the server's variables the other specs are skipped
   with the reason; on CI they fail instead.
8. **The specs are not scanned by CodeQL**, like the tests of ADR 0128: `apps/desktop/e2e` is
   added to `.github/codeql/codeql-config.yml`. Biome's Playwright rules apply to that folder only,
   since elsewhere they mistake our own functions for Playwright's.

We chose Playwright over a WebDriver-based runner because it speaks to Electron directly: the main
process, every window and the settings window come with it, with no driver to match to the Electron
version, and its traces show each step with the page as it was. A runner where an agent reads the
screen and decides what to do would need a model and its secrets in CI, would not do the same thing
twice, and would make a failure hard to trust or to reproduce.

## Consequences

- A change that breaks the first start, sending, or moving mail fails its pull request, with a
  video of what happened.
- Playwright's Electron support is marked experimental. An Electron update can break it before
  Playwright catches up; Dependabot's pull requests for either will show that in the `e2e` job.
- CI runs the suite on Linux; Matters is developed and tested by hand on macOS. A fault that shows
  on one only is caught where it shows. On Linux Playwright starts Electron without Chromium's
  sandbox, as it always does there.
- The Linux job depends on GNOME Keyring under D-Bus. If the keyring is not unlocked, the app
  refuses to save the password, and the setup tests fail with the app's own sentence about it.
- A test that types the setup screen waits for the lookup of `example.test`, which asks DNS and the
  web. A slow network makes the test slower, not wrong; the wait allows a minute.
- Sends and moves reach a server only after their undo window of 10 seconds, so the tests that
  check a server take about 15 seconds each.
- The TLS fronts are the tests' and not the app's: the app still never connects in plaintext
  unless `MATTERS_ALLOW_INSECURE_IMAP=1`, and the suite does not set it.
- The suite does not measure. The budgets stay with the smoke runs, which still run by hand.
