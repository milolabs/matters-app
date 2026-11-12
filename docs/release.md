# Releasing Matters

How a version of Matters gets from `main` to a download. The decision and its reasons are in
[ADR 0123](adr/0123-releases.md) and [ADR 0124](adr/0124-the-release-workflow-sets-the-version.md);
this page is the plan and the steps.

## Where we are

| Stage | What | State |
| --- | --- | --- |
| 0 | A release build, `bun run release:macos`, the `Release` workflow, a rehearsal that needs no secret | done, not yet run on GitHub |
| Alpha | `v0.1.0-alpha.1` and on, for invited testers: signed ad hoc, not notarized, with an SBOM and an attestation | ready; needs nothing from Apple |
| 1 | The first pre-release, `v0.1.0-beta.1`: signed, notarized, with an SBOM and an attestation | waits on the one-time setup below |
| 2 | Updates: the app says when a newer release exists, later installs it | not started; needs its own ADR |
| 3 | Before 1.0: asar with integrity fuses, an Intel or universal build, Windows and Linux, an independent audit | not started |

## Alpha

An alpha is for a few people you invited, before the project has a Developer ID. It is the release
build signed ad hoc: macOS refuses to open it until the tester allows it. It needs none of the
one-time setup below.

**Making one**

1. Open Actions → Release → Run workflow, on `main`. Leave the version empty and run it.
2. The run does the checks, sets the next version (`0.1.0-alpha.1`, then `-alpha.2`, …), commits
   it to `main`, tags it, builds the app and starts it.
3. It leaves a **draft** pre-release with the disk image, the SBOM, the checksums and notes that
   say how to open it. Add what changed and what is known not to work, then publish, and send
   the link to the testers. A published pre-release is public: anyone can find it, and the notes
   say it is for invited testers.
4. `git pull`, so your `main` has the version commit.

**What a tester does**

1. Checks the download: `gh attestation verify Matters-<version>-arm64.dmg --repo milolabs/matters-app`.
   With no Developer ID this is the only proof that the file is ours.
2. Opens the disk image, drags Matters to Applications, and starts it once. macOS says it cannot
   check the app.
3. Opens System Settings → Privacy & Security, scrolls to "Matters was blocked", and chooses
   Open Anyway.

**What to tell testers**

- An Apple Silicon Mac only.
- There are no updates. A newer alpha is a new download, and after installing it macOS may ask
  for the login password once, so the new build can read the stored mail passwords.
- It is an alpha of a mail client: sign in with an account whose mail they can afford to see
  handled wrongly, or with an app password they can revoke.
- Problems go to the issue tracker; a security problem goes the private way of
  [SECURITY.md](../SECURITY.md).

Alphas end with the first signed pre-release. A version without `-alpha.` always takes the signed
path.

## One-time setup (the owner)

1. **Join the Apple Developer Program** (paid, yearly). Signing for distribution and notarization
   are not possible without it.
2. **Make a Developer ID Application certificate** in the developer account, and export it with its
   private key as a `.p12` with a password.
3. **Make an App Store Connect API key** (Users and Access → Integrations → Team keys, role
   Developer). Keep the `.p8` file, the key ID and the issuer ID.
4. **Create the GitHub environment `release`** (Settings → Environments): add yourself as a required
   reviewer, and limit it to the branch `main`.
5. **Add the secrets to that environment**, not to the repository:

   | Secret | What |
   | --- | --- |
   | `MACOS_CERTIFICATE` | the `.p12`, base64 encoded (`base64 -i certificate.p12`) |
   | `MACOS_CERTIFICATE_PASSWORD` | its password |
   | `APPLE_API_KEY` | the contents of the `.p8` file |
   | `APPLE_API_KEY_ID` | the key ID |
   | `APPLE_API_ISSUER` | the issuer ID |

6. **Protect the tags**: a ruleset that lets only the owner and GitHub Actions create tags
   matching `v*`.

## Rehearsal

Run the `Release` workflow (Actions → Release → Run workflow) on `main` with **rehearsal** ticked.
It runs the checks, builds the app signed ad hoc, starts it, and keeps the disk image with the run for five days. It uses
no secret, sends nothing to Apple, and commits, tags and publishes nothing. Do this before the first release and after
any change to `tools/bundle-macos.ts`, `tools/release-macos.ts` or the workflow.

The same on a Mac, without starting the app:

```sh
MATTERS_SIGN_IDENTITY=- bun run release:macos
```

Do not start `dist/release/Matters.app` on a Mac that holds your own mail unless you mean to: a
release build has no dev switches and opens your real data folder.

## Before a release

- [ ] CI is green on `main`.
- [ ] `bun run test` passes whole, with the two `*Perf.test.ts` files CI leaves out.
- [ ] `bun run test:imap` passes (needs Docker).
- [ ] `bun run smoke:security` passes (needs Docker), and
      [security/standards.md](security/standards.md) has nothing high or critical open.
- [ ] `bun run smoke:desktop`, `smoke:desktop:sync`, `smoke:identity` and `smoke:instance` pass.
- [ ] `bun run bench:launch` is within the budgets of [ADR 0012](adr/0012-performance-budgets.md).
- [ ] No open Dependabot alert or code scanning finding that touches what ships.
- [ ] The Electron version is one that still gets security fixes.
- [ ] A rehearsal ran on this commit, and its app started.

## Making a release

1. Open Actions → Release → Run workflow, on `main`.
2. The version: leave it empty to count on from the last one (`0.1.0-beta.1` → `0.1.0-beta.2`,
   `0.1.0` → `0.1.1`), or type it when the step is a decision: the first beta (`0.1.0-beta.1`),
   leaving the suffix behind (`0.1.0`), a new minor or major version. A suffix makes it a
   pre-release.
3. The run does the checks, commits the version to `main` and tags it. Then it waits: approve it
   when GitHub asks (the `release` environment). `git pull` afterwards.
4. When it is done there is a **draft** release. Download the disk image on a Mac, open it, drag
   the app to Applications and start it. Then check it as a stranger would:

   ```sh
   shasum -a 256 -c SHA256SUMS.txt
   spctl --assess --type execute -v /Applications/Matters.app
   gh attestation verify Matters-0.1.0-beta.1-arm64.dmg --repo milolabs/matters-app
   ```

5. Write the notes: what changed, what is known not to work, and any security fix with its
   advisory. Publish.

## If something is wrong

- **The build failed after the version was committed:** fix nothing by hand. "Re-run failed jobs"
  builds the same tag again; or fix the cause on `main` and run the workflow afresh, which makes
  the next number.
- **Before publishing:** delete the draft, fix, and run the workflow again. The skipped number
  does no harm.
- **After publishing:** do not replace files under a published version. Fix, and release the next
  version. If the fault is a security problem, publish an advisory that names the versions
  ([SECURITY.md](../SECURITY.md)).
- **If the certificate or the API key may have leaked:** revoke it in the developer account first,
  then replace the secret.

## How a person checks a download

- The disk image opens without a warning: it is signed with the project's Developer ID and
  notarized by Apple. (An alpha is neither; see [Alpha](#alpha).)
- `SHA256SUMS.txt` holds the checksums of the image and of the SBOM.
- `gh attestation verify <file> --repo milolabs/matters-app` shows the workflow and the commit the
  file was built from.
- The `.spdx.json` file lists every package inside the app.
