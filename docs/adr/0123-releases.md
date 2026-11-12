# 0123. Releases

- Status: Accepted
- Date: 2026-11-12
- Turns around: [0107](0107-matters-runs-on-macos-as-its-own-app.md), rule 4, for a release build
  only (a packaged app has no dev switches); the local bundle of 0107 is unchanged
- Builds on: [0105](0105-the-app-identity-moves-to-matters.md),
  [0122](0122-security-policy-and-checks-on-every-change.md)
- Amended by: [0124](0124-the-release-workflow-sets-the-version.md) (the workflow is started by
  hand, sets the version, and makes the commit and the tag itself)

## Context

There is no download. A person who wants Matters builds it from source. ADR 0107 made a bundle for
the Mac that built it and said what it is not: no Developer ID, no notarization, no `isPackaged`,
and that the first distribution build must turn its rule 4 around.

A mail client is handed passwords. A person who downloads it has to know three things: that the file
comes from us, that it is what the public source builds, and what is inside it. On macOS the first
is a Developer ID signature and Apple's notarization; without them the system refuses to open the
app. Both need a paid Apple Developer membership, which the project does not have yet.

The Electron runtime also ships with switches ("fuses") that let any program start a signed app as
plain Node, or steer it through `NODE_OPTIONS` or `--inspect`. Code run that way runs under the
app's signature, and macOS then lets it read the app's Keychain item. `standards.md` listed this as
an open gap (A6, item 19) because there was no packaging step to close it in.

Tried on 2026-11-12 on this machine: a release build signed ad hoc, its fuses read back, and a disk
image made from it. Not tried: a Developer ID signature, notarization, and starting the packaged
app. A packaged app has no dev switches, so here it would open the owner's real mailbox.

## Decision

1. **What a release is.** For each version, on GitHub Releases:
   - `Matters-<version>-arm64.dmg`: the app, signed with the project's Developer ID, notarized, with
     Apple's ticket stapled to the app and to the image, so both open on a Mac that is offline;
   - `Matters-<version>-arm64.spdx.json`: every package the app ships with (an SBOM);
   - `SHA256SUMS.txt`;
   - a build provenance attestation for the image: a signed, public record that this file was built
     by the release workflow from this commit.
2. **A release build is a packaged app.** `MATTERS_RELEASE=1` makes `tools/bundle-macos.ts` rename
   the executable to `Matters`, so `app.isPackaged` is true and every dev switch is gone. The name,
   the data folder and the Keychain item stay those of ADR 0105.
3. **Fuses.** A release build turns off `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and
   `EnableNodeCliInspectArguments`, with `@electron/fuses`. The app is a folder, not an asar, so the
   two asar fuses stay off (see rule 11).
4. **Signing.** A release is signed only with an identity that is named (`MATTERS_SIGN_IDENTITY`),
   never with whatever is in the keychain, and with Apple's timestamp. `-` gives an ad-hoc signature:
   a rehearsal or an alpha (rule 10), which the release script refuses to treat as a release.
5. **One script, on a Mac or in CI.** `bun run release:macos` builds, bundles and runs
   `tools/release-macos.ts`, which notarizes when it is given an App Store Connect API key and, with
   `MATTERS_REQUIRE_NOTARIZATION=1`, fails unless the result passes `spctl` and `stapler validate`.
   The workflow adds nothing the script cannot do, except the SBOM, the attestation and the draft.
6. **A tag makes a release.** Pushing `v<version>` runs `release.yml`: the checks of ADR 0122, then
   the build. The tag must equal the version in `apps/desktop/package.json`. The result is a
   **draft** release; a person reads it, tries the download, and publishes.
7. **Secrets are behind an environment.** The certificate and the API key are secrets of the GitHub
   environment `release`, which requires the owner's approval for each run and is limited to `v*`
   tags. In a run they live in a keychain and a file made for that run and removed at its end.
8. **A rehearsal needs nothing.** Started by hand, the workflow builds the same thing signed ad hoc,
   starts it, and keeps the image with the run for five days. CI makes the same build on every
   change, so the path to a release cannot rot unseen.
9. **Versions.** Semantic versioning, `0.x` until an independent audit is done. A version with a
   suffix (`0.1.0-beta.1`) is published as a pre-release. Only the latest release gets fixes.
10. **An alpha comes before the Developer ID.** A tag `v<version>-alpha.<n>` makes the same build
    signed ad hoc and not notarized, with the same SBOM, checksums and attestation, as a draft
    pre-release whose notes say what it is and how to open it. It is for a few invited testers: to
    learn whether the app works on a Mac and a mailbox that are not the owner's. It uses no secret
    and not the `release` environment. Any other tag takes the signed path, so a beta or a release
    can never come out ad hoc.
11. **In stages.**
    - *Stage 0, done here:* the release build, the script, the workflows, the rehearsal.
    - *Alpha, needs nothing from Apple:* `v0.1.0-alpha.1` and on, for invited testers.
    - *Stage 1, the first pre-release:* the Apple membership, the certificate and the key, the
      `release` environment, the checklist of `docs/release.md`, then `v0.1.0-beta.1`.
    - *Stage 2, updates:* the app says when a newer release exists, then installs one after
      checking its signature. Its own ADR: asking a server for a version is a network request the
      app does not make today.
    - *Stage 3, before 1.0:* the app in an asar with integrity checked by the fuses; an Intel or
      universal build; Windows and Linux; an independent audit.

## Consequences

- The first release waits on things only the owner can do: join the Apple Developer Program, make
  the certificate and the key, and put them in the `release` environment.
- Nobody has started a release build yet. The first rehearsal on GitHub is the first proof that a
  packaged app starts; until it has run, this path is untested from that point on.
- An alpha asks a tester to tell macOS to open an app Apple has not checked. That is a habit we
  do not want anyone to keep, so alphas are for people the owner invited, the notes say what the
  build is, and the attestation is the proof of where it comes from. Alphas end with Stage 1.
- An ad-hoc signature is different in every build. macOS ties the Keychain item to the signature,
  so after a newer alpha is installed it is expected to ask for the login password before the app
  can read the stored mail passwords. Not tried yet.
- Until Stage 2 a person with an old version is not told. A security fix reaches them only if they
  look: the release notes and the advisory are where we say it.
- The SBOM lists the packages in `Contents/Resources/app`. It does not describe the Electron
  runtime beyond its version.
- A release is built on GitHub's runner. The attestation says so; it does not make the build
  reproducible, and nobody has tried to rebuild one bit for bit.
- An Apple Silicon Mac only. An Intel Mac needs Stage 3.
- `@electron/fuses` is a new development dependency (MIT).
- The Docker-based runs and the performance budgets are still not in CI (ADR 0122), so they are
  steps of the release checklist that a person runs.
