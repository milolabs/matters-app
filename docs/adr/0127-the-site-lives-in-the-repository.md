# 0127. The site lives in the repository

- Status: Accepted
- Date: 2026-11-12
- Builds on: [0123](0123-releases.md), [0126](0126-changes-reach-main-by-pull-request.md)

## Context

Matters needs one page a stranger can read in a minute: what it is, that it is open, and where to
get it. Until now that page was the README.

The site is small: a home page, a page for downloads and a page on how to extend the app. Two
things on it change with a release: the download link and the version beside it. Everything else
changes when the app or the words about it change, which is a change to the repository like any
other.

A site kept somewhere else drifts from the code, has its own access and its own history, and can
say things the repository does not.

## Decision

1. **The site is the folder `site/`**, in this repository, under the same license and the same
   rule for changes (ADR 0126). It is not a workspace package: it has no dependencies and no build
   step. It is plain HTML, CSS and two small scripts, and it works with scripts turned off.
2. **It asks nothing of anyone else's server.** Fonts are in the folder with their licenses (SIL
   Open Font License). There are no analytics, no embeds and no CDN. Each page carries a
   content security policy that allows its own origin only.
3. **GitHub Pages publishes it**, from the workflow `.github/workflows/site.yml`, not from a
   branch. The workflow has read access to the repository; only its publishing job may write to
   Pages.
4. **It is published when `site/` changes on `main`, and when a release is published.** The first
   so that a correction does not wait for a release. The second so that the download follows the
   release without a commit: the workflow writes `release.json` from the latest published release,
   and the page reads it. The copy of `release.json` in the repository says "no release"; nothing
   in the automation writes to `main` (ADR 0126, rule 3).
5. **The site offers what "latest" means on GitHub**: the newest release that is published and is
   not a pre-release. Drafts and alphas (ADR 0123) never appear on it.
6. **The site says what `main` does**, like the README. A feature that is not merged is under
   "Yet to come" or not there. Mail and names shown in the pieces of the app are made up.
7. **Lint covers `site/`** with the rest of the repository (ADR 0122).

## Consequences

- A change to the page is a pull request: it waits for the checks and the reviewer, and it has a
  history.
- The page can be ahead of the newest release: it describes `main`, and a download may be older.
  The version and date under the download button say which one a person gets.
- Until the first release that is not a pre-release, the site says there is no download and shows
  how to build from source.
- Publishing a release now also publishes the site. If that run fails, the release stands and the
  site shows the release before it; running the workflow by hand mends it.
- The star count and the version are fixed at the time of publishing, not read live: a visitor's
  browser never calls GitHub's API.
- Pages has to be set to "GitHub Actions" once, in the repository's settings, by the owner. The
  address is a setting too: a domain of our own, or `milolabs.github.io/matters-app` without one.
  The pages use relative links, so both work.
- The pieces of the app on the home page are drawn by hand from the app's own colors. When the app
  changes its look, they have to be changed too; nothing checks that.
