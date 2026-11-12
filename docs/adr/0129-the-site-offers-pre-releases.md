# 0129. The site offers pre-releases

- Status: Accepted
- Date: 2026-11-12
- Amends: [0127](0127-the-site-lives-in-the-repository.md), rule 5 (while there is no stable
  release, the site offers the newest published pre-release), and [0123](0123-releases.md),
  rule 10 (a published alpha is offered on the site, not only to invited testers)

## Context

The site offered what "latest" means on GitHub: the newest published release that is not a
pre-release (ADR 0127, rule 5). Every release before 0.1.0 is a pre-release, an alpha or a beta
(ADR 0123). So through all of that time the site said "No download yet", also on the day an alpha
was published and its files were one click away on GitHub.

A visitor who wants to try the app today then has to find the releases page alone, and reads
there what the site could have said first.

## Decision

1. **The site offers the newest stable release, when there is one.** A pre-release never takes
   its place, also a newer one. While there is no stable release, the site offers the newest
   published pre-release. Newest is by date of publication. `site/scripts/write-release.mjs`
   reads the list of releases, not "latest".
2. **A draft is never offered.** A release reaches the site when a person publishes it, as before.
3. **A release without a disk image is passed over**, and the one before it stands.
4. **A pre-release is named as one.** `release.json` carries its stage, taken from the tag
   (`v0.1.0-alpha.1` is "alpha"), and a link to its notes. The button says "Download the alpha",
   and the version line says the stage and sends the reader to the notes before they open it.
5. **The site does not repeat the notes.** What a build is and how to open it is written once, in
   the release (ADR 0123, rule 10), and the site links there.

## Consequences

- An alpha that is published is offered to everyone who visits, not only to people the owner
  invited. It is still not notarized, and macOS still refuses it until the reader allows it. The
  owner decides this each time by publishing the draft or leaving it a draft; an alpha meant for
  a few testers stays a draft, or is sent as a link.
- Once there is a stable release, alphas and betas of the next version are on GitHub only, as
  under ADR 0127.
- Among pre-releases the newest wins, whatever its stage: an alpha published after a beta takes
  the button.
- The page shows a stage only when `release.json` has one, so a stable release reads as before.
