# 0140. The app installs a newer version when asked

- Status: Accepted
- Date: 2026-11-16
- Amends: [0137](0137-the-app-says-when-a-newer-version-is-out.md), rules 1 and 11 (About can
  install the newer version, when the person presses it; Download stays)
- Builds on: [0123](0123-releases.md), rule 11 (stage 2, its second half),
  [0139](0139-an-installer-in-one-line.md) (the same source, checks, names and lock as
  `site/install.sh`), [0110](0110-one-instance-per-data-folder.md) (one running copy per data
  folder), [0020](0020-sending-outbox-and-compose.md) (what happens to a send on quit)

## Context

ADR 0137 made the app say that a newer release is out, with Download and Release notes links
that open the browser. It left installing for a record of its own, because an alpha is signed ad
hoc and there was nothing to check it against.

ADR 0139 then defined a checked install without a Developer ID: `site/install.sh` downloads the
release from this repository's releases on GitHub, checks the image's SHA-256 against the
release's `SHA256SUMS.txt`, checks the build record with `gh` when it is installed, copies the
app beside the old one, checks its signature seal, and swaps it in. A copy that arrives that way
carries no quarantine mark, so macOS does not stop it.

A person who already runs Matters should not need Terminal for the next alpha. What they need is
the same install, started from About.

Where the release files are, read on 2026-11-16 with `curl -sIL` (headers only) for
`v0.1.0-alpha.5`: the image, `SHA256SUMS.txt` and the `.intoto.jsonl` record each answer at
`https://github.com/milolabs/matters-app/releases/download/<tag>/<file>` with one `302` to
`https://release-assets.githubusercontent.com/github-production-release-asset/…`, which answers
`200`. The image is 191,807,259 bytes.

The running app cannot be swapped under itself. Electron starts its helpers (a renderer for a new
window, the GPU process) from the bundle while it runs, so after a swap the old app would start
new helpers from the new bundle. And the new app cannot start before the old one has quit: the
single-instance lock of ADR 0110 would hand its turn to the old one and leave.

What quitting does today: `before-quit` stops the backend, which closes the database, and then
the app quits. A send waits in the outbox as soon as Send is pressed (ADR 0020, rule 4); one whose
undo window ends while the app is closed is held at the next start, not sent (rule 5). Drafts are
saved 500 ms after the last change and when a composer closes.

Tried on 2026-11-16 on macOS 26.6: the checks against stand-ins (a wrong checksum stops it, Cancel
stops a download, nothing is downloaded before the press), and the helper against temporary
folders with a stand-in bundle. Not tried: a whole install of a real release into a real
`Matters.app`, because it would replace the owner's app; and the restart into it.

## Decision

1. **Never by itself.** Nothing is downloaded or installed until the person presses Install and
   Restart in Settings › About. The app menu's item opens About, as before. There is no download
   in the background, no install on quit, and nothing at start (ADR 0137, rule 13 stands).
2. **Only where it can be done.** Install is offered only by a release build (as in ADR 0137, rule
   5), on macOS with Apple silicon, and only when the running copy is a real `Matters.app` (the
   program's path, links resolved, ends in `Matters.app/Contents/MacOS/Matters`) that is not under
   App Translocation and sits in a folder the person can write to, with a bundle they can move.
   Otherwise About keeps Download and says in one phrase why it cannot install here: not made by
   the release workflow; not a Mac with Apple silicon; not running as Matters.app; run from a
   temporary folder by macOS; run from the disk image; a folder that cannot be written. Where the
   copy is is found out once, when Settings first opens: never on the way to the mail.
3. **The same source and checks as the installer, in its order, stopping at the first failure
   with nothing installed.**
   - The files come only from `https://github.com/milolabs/matters-app/releases/download/<tag>/`.
     The tag is `v` and the version that ADR 0137 already read (rules 7 and 8), and the version
     must have the form of `site/install.sh` (`1.2.3` or `1.2.3-word.4`); the image is
     `Matters-<version>-arm64.dmg`. Only a version newer than the running one by the rule of ADR
     0137 is installed: never the same one, never an older one. The page names no version and no
     file: main installs the one it knows.
   - Each download is a `GET` over `https` with no cookie, no credentials and no referrer, the
     `User-Agent` `Matters`, in the release check's own session (ADR 0137, rule 3). A redirect is
     followed only to `release-assets.githubusercontent.com`, or back under the release
     downloads, at most three times. Limits: the image 512 MB and 20 minutes, the checksums
     64 KB, the build record 4 MB; any of them stops when nothing has come for a while. A file
     that did not come whole is removed.
   - The image's SHA-256 against its line in `SHA256SUMS.txt`, always. No line, two lines with
     different sums, or another sum: stop.
   - The build record, `gh attestation verify <image> --repo milolabs/matters-app
     --signer-workflow milolabs/matters-app/.github/workflows/release.yml --bundle
     <image>.intoto.jsonl`, only when `gh` is found. An app started from the Dock has a short
     PATH, and a PATH is not something to trust, so `gh` is looked for only at
     `/opt/homebrew/bin/gh`, `/usr/local/bin/gh` and `/usr/bin/gh`. Without it About says that
     where it was built was not checked, as the script does.
   - The image is opened read-only and not shown in Finder (`hdiutil attach -nobrowse -readonly
     -noautoopen`), the app copied beside the old one with `ditto`, then
     `codesign --verify --deep --strict` of the copy, and the copy's `CFBundleIdentifier` and
     version must be `app.getmatters.Matters` and the version asked for.
   - Programs are run by their full path, without a shell, with a fixed PATH of the system's own
     folders. Never `xattr`, `spctl` or `sudo`; no quarantine mark is set or removed, and no setting
     is changed. As with the script, the copy carries no mark, so macOS does not check it when it
     opens.
4. **The swap is the installer's, and is made after the app has quit.**
   - The folder is `.Matters.app.lock`'s, as for the script: the app takes the lock (`mkdir`)
     after the checks of the download passed and before it writes anything into the folder. A
     lock that is there is another install's, or one that was killed, and is never taken over:
     About says so and names it. With the lock held, what a killed install left is cleared as the
     script does: an old app in `.Matters.app.previous` goes back when no `Matters.app` is there.
   - The new app is copied to `.Matters.app.installing` and checked there (rule 3).
   - Then the app starts a small helper and quits. The helper is a few lines of `bash`, run with
     `/bin/bash -c` (never written to a file), detached, with the app's pid and the folder. It
     waits until that process has ended (two minutes at most), waits until no process from
     that bundle is left (its own helpers end a moment after it; ten seconds at most), moves the old app to `.Matters.app.previous`, moves the new one to
     `Matters.app`, removes the old one and the lock, and opens the app. If the new app cannot be
     put in place, the old one is moved back and opened. If the app did not quit in two minutes,
     or a copy still runs after those ten seconds (the person started it again), it removes the new copy and the lock and changes
     nothing.
   - So there is always a `Matters.app` in the folder except for the moment between two renames
     in one folder, and when the first rename has happened and the second fails the old one
     goes back. Only the new app is started, and only once the old one has ended, so the
     single-instance lock of ADR 0110 is free when it starts.
   - The quit is an ordinary quit, as Cmd+Q: the backend closes the database first. A send in its
     undo window is in the outbox and is held at the next start (ADR 0020, rule 5); a draft is
     saved as it is on any quit. Nothing of the mail is touched by the install.
   - Rejected: swapping while the app runs and then relaunching it (the helpers it starts while
     running would come from the new bundle; ADR 0110 would also turn the relaunch away if it
     came too soon); and a helper that is the new app itself (the app reads nothing from its
     command line, ADR 0110, and would have to move its own bundle).
5. **Said in About, in words.** While it runs, a line under "… is out": "Downloading 0.1.0-alpha.5:
   42 of 192 MB…", "Checking the download against its checksum…", "Checking that the release
   workflow built it…", "Installing 0.1.0-alpha.5…", "Restarting into 0.1.0-alpha.5…". Once the
   checks have passed, one line says whether the build record was among them. Cancel stops it
   while the image downloads. A failure is one phrase saying which step failed, then "Nothing was
   installed."; Install and Restart and Download both stay. While an install runs, the switch of
   ADR 0137 cannot be turned off and a second install is not started. Quitting during an install
   stops a download and waits up to ten seconds for the folder to be cleaned up.
6. **Where it lives.** The rules are pure functions in `packages/core` (`domain/install.ts`): the
   files of a version, which redirects pass, the checksum line, whether this copy can be replaced,
   the steps of an install and what moves them, and the words. Main has the side effects behind
   small seams: the download (`installDownload.ts`, Electron's `net` handed in), the steps in the
   installer's order (`install.ts`, every program and file handed in), the lock and the helper
   (`installSwap.ts`), and one install at a time with Cancel (`installer.ts`). No new dependency.
7. **Tests.** Unit tests for the rules (the files, the hosts, the checksum line, the steps, the
   refusals: a wrong checksum, a missing line, a downgrade, a folder that cannot be written, a
   translocated copy). Tests of main's side with stand-ins: the download's limits, the order of
   the steps and that each failure stops before the next and cleans up, the lock, and the helper
   run with `bash` against temporary folders with a stand-in bundle (success; a failed rename
   that puts the old app back; waiting for the process). The window test points a build that is
   not packaged at a stand-in for the downloads (`MATTERS_TEST_INSTALL_URL`, loopback only) and
   a stand-in folder (`MATTERS_TEST_INSTALL_DIR`); a packaged app reads neither. It checks that
   nothing is downloaded before the press, that a wrong checksum stops it with nothing in the
   folder, and that Cancel stops a download. The security run points the same two at its canary
   and checks that no download leaves without a press.

## Consequences

- A tester on an alpha that has this gets the next one with one press, with the checks of the
  installer and no Terminal. The alphas before it still need the script or the disk image once.
- An alpha is signed ad hoc, so the new build is, to the Keychain, another app: after the swap
  macOS may ask for the login password once, so it can read the mail passwords the old one
  stored. About does not say it beforehand; the release notes and the README do.
- The checksum comes from the same release as the image, so it shows that the download is whole,
  not whose it is. Trust rests on TLS to GitHub, and on the build record when `gh` is there; About
  says which of the two happened. `gh` itself fetches Sigstore's trust root over the network when
  it checks; that request is `gh`'s, not the app's.
- A copy installed this way is not checked by macOS when it opens, as with the script. A
  notarized release later changes nothing here: it is checked by the same steps.
- Whoever can change the site can make About offer a version (ADR 0137, consequences), and so
  Install: but only the files of a release of this repository on GitHub, which then pass or fail
  the same checks. A version with no release fails at the download.
- GitHub sees the downloads of the person who pressed Install: the address, and the files of one
  release. Nothing else is sent.
- If GitHub moves release files to another host, the install stops at the redirect and says so;
  Download still works. The list of hosts is in `packages/core` and changes with a release of the
  app.
- The release files are now named in two places, the script and the app (ADR 0123, rule 1; ADR
  0139). A release that renames them breaks both.
- When the swap itself fails after the app quit, the old app opens again but does not learn why:
  the helper writes nothing. About offers the install again.
- A helper that is killed between its two renames leaves the old app in `.Matters.app.previous`
  and the lock, and no `Matters.app`. The script then names the lock; once the person removes it,
  the script moves the old app back before it downloads anything (ADR 0139, rule 5). If putting
  the old app back fails in the helper itself, it is left in `.Matters.app.previous` the same
  way, without the lock.
- An app that is killed while it copies into the folder leaves the lock, which the next install
  names, as for the script.
- Nothing here runs in CI on a Mac: CI's window tests run on Linux, where About says it installs
  only on a Mac with Apple silicon, and the helper's test needs `bash`. A change to the swap is
  tried by hand on a copy in another folder, never on `/Applications`.
- No new dependency.
