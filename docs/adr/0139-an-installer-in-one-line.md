# 0139. An installer in one line

- Status: Accepted
- Date: 2026-11-15
- Amends: [0123](0123-releases.md), rule 10 and its consequence about "Open Anyway" (an alpha
  can be installed without telling macOS to open an unchecked app), and
  [0129](0129-the-site-offers-pre-releases.md), rules 4 and 5 (a button leads to the download
  page, where the installer comes first and the disk image second; the page says how to install,
  not only the release notes)
- Builds on: [0125](0125-what-an-outsider-can-check.md),
  [0127](0127-the-site-lives-in-the-repository.md)

## Context

Until the project has a Developer ID, every build is an alpha: signed ad hoc and not notarized
(ADR 0123, rule 10). A browser marks what it downloads with `com.apple.quarantine`, and macOS
checks a marked app when it is first opened. An alpha fails that check, so the person sees that
the app cannot be opened, and has to go to System Settings → Privacy & Security and choose Open
Anyway. ADR 0123 already said this is a habit we do not want anyone to keep. It also loses people:
the message reads as "this app is broken".

macOS checks only files that carry the mark. `curl` does not set it. An app that arrives through
`curl` therefore opens with no question, which is how the common command-line installers work.

Nothing is switched off by this: no setting is changed and no mark is removed. But the check
that would have happened does not happen, and for an alpha that check would only have said "not
notarized". What tells a person that the file is ours is the checksum and the build record of
ADR 0123 and 0125, and until now reading them was a step most people skip.

Tried on 2026-11-15 on macOS 26.6 with `v0.1.0-alpha.5`: the script below, piped into `bash`,
with another folder as the target and without opening the app. The copy had no quarantine mark,
the checksum and the build record were confirmed (also with `gh` not signed in), a changed image
failed the checksum, and the disk image was unmounted. Not tried: opening the installed copy,
because a release build opens the owner's real mailbox. The release workflow starts the same
kind of unmarked ad-hoc build on every run.

## Decision

1. **`site/install.sh` installs Matters**, and the site serves it:
   `curl -fsSL https://getmatters.app/install.sh | bash`. It is plain `bash` as macOS ships it,
   and uses only programs macOS has.
2. **It installs what the site offers.** The version comes from the site's `release.json`, so the
   rule of ADR 0129 is written once. `MATTERS_VERSION` names another. The version must look like
   a version, and the files come only from this repository's releases on GitHub.
3. **It checks before it installs, and stops when a check fails.**
   - The SHA-256 of the disk image against the release's `SHA256SUMS.txt`. Always.
   - The build record: `gh attestation verify` with the record that sits beside the image, for
     this repository and for the workflow `release.yml`. Only when `gh` is installed; it needs no
     sign-in. Without `gh` the script says that this was not checked.
   - The signature seal of the copied app (`codesign --verify`), so what is installed is what was
     signed, ad hoc or not.
4. **It does not touch the quarantine mark or any setting.** It never runs `xattr`, `spctl` or
   `sudo`. If a later macOS starts marking such files, the script will not work around it.
5. **It replaces only what it installed over, and only when that copy is not running.** The new
   app is copied beside the old one and checked first. The old one is then moved aside, not
   deleted, until the new one is in its place, and moved back if the run fails or is stopped
   (INT, TERM, HUP) in between. A run that is killed outright (KILL, a power cut) cleans nothing
   up: the old app stays in `.Matters.app.previous` and the lock stays, so the next run stops and
   names the lock folder; once the person removes it, that run moves the old app back first. It
   looks for a running copy twice: at the start, and again just before the swap. One install
   runs in a folder at a time. Versions are not compared: what the site offers replaces what is
   there, also a newer alpha once there is a stable release. The target is `/Applications`, or
   `MATTERS_INSTALL_DIR`.
6. **A cut-off download runs nothing**: the script is one function called on its last line.
7. **The installer is the way offered first, and the disk image stays.** On the download page
   the line is at the top and the disk image is a link under it; the buttons of the first page
   say "Get the alpha" and lead to the download page, not to the file. The README and the notes
   of each alpha put the line first too.
8. **The pages say what it does.** Wherever the line is shown, the page says that macOS does not
   check the app this way and what the script checks instead, and links to the script. The way
   by hand, with the disk image, stays written beside it.
9. **It is not the answer to signing.** Stage 1 of ADR 0123 is unchanged: a Developer ID and
   notarization. The script keeps working for a notarized release, where it is only a shorter
   way to install.

## Consequences

- A person can try an alpha without a warning and without Open Anyway. The habit this asks for
  instead is running a script from a site, which is also a habit with a cost: whoever can change
  what `getmatters.app` serves can change what runs. The site is published only from `main` by
  the site workflow (ADR 0127), and changes reach `main` by pull request (ADR 0126).
- The checksum comes from the same release as the image, so alone it shows that the download is
  whole, not whose it is. Only the build record shows that, and only people with `gh` get it.
  The script says which of the two happened.
- The script changes when it is merged, not with a release. A release that renames its files
  breaks the script until both change together; the file names of ADR 0123, rule 1, are now
  something a script depends on.
- The script reads `release.json` with `sed`, because macOS has no JSON tool that a script can
  rely on. The file is written by our own workflow, one key per line.
- Nothing runs the script in CI. A change to it is tried by hand, as written in Context.
- An Intel Mac is refused with a sentence, as before Stage 3.
