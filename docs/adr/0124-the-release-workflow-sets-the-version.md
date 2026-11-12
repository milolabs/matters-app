# 0124. The release workflow sets the version

- Status: Accepted
- Date: 2026-11-12
- Amends: [0123](0123-releases.md), rules 6, 7, 8 and 10 (who sets the version and makes the tag)
- Amended by: [0126](0126-changes-reach-main-by-pull-request.md) (the version commit is on the tag
  only, and the next version is counted from the last tag)

## Context

ADR 0123 made a release start from a tag: a person sets the version in `apps/desktop/package.json`,
commits, tags that commit, and pushes the tag. Three steps by hand, each of which can disagree
with the others, before anything is built. With alphas (0123, rule 10) a release is something the
owner wants to make often, and for the next alpha there is nothing to decide: the number goes up
by one.

A workflow can make the commit and the tag itself. Two things are worth knowing about that:

- A commit or a tag pushed with a workflow's own token does not start other workflows. So a
  workflow that tags cannot rely on "a tag starts the release"; the build has to be in the same
  run.
- A commit made through GitHub's API (`createCommitOnBranch`) is signed by GitHub and names the
  commit it expects to be on top of. If the branch moved, it is refused.

Tried on 2026-11-12: the rule for the next version, as a test, and `bun install --frozen-lockfile`
with the version changed (it passes). Not tried: the workflow itself, which can only run on
GitHub.

## Decision

1. **A release is started by hand.** `Release` is run from the Actions page, on `main`. There is
   no tag trigger any more: the workflow makes the tag.
2. **One run, in this order:** the checks of ADR 0122 on the commit it was started on; then the
   version commit and the tag; then the build of that tag, as an alpha or as a signed release
   (0123, rules 1 and 10). If the checks fail, nothing is committed.
3. **The version is counted unless it is named.** With the `version` field empty,
   `tools/next-version.ts` counts on from `apps/desktop/package.json`:
   - `0.0.0` → `0.1.0-alpha.1` (the first one);
   - a suffix ending in a number goes up by one: `0.1.0-alpha.1` → `0.1.0-alpha.2`,
     `0.1.0-beta.3` → `0.1.0-beta.4`;
   - no suffix: the patch goes up, `0.1.0` → `0.1.1`.

   Going from alpha to beta, from beta to a version without a suffix, or to a new minor or major
   version is a decision, so it is typed into the field. A name that is not a version, that is the
   current version, or whose tag exists, stops the run.
4. **The version commit.** It changes the version in `apps/desktop/package.json` and in the
   workspace entry of `bun.lock`, nothing else, with the message `Matters <version>`. It is made
   through GitHub's API with the checked commit as its parent, so it is signed by GitHub, and it is
   refused if `main` moved while the checks ran. The tag `v<version>` points at it.
5. **A rehearsal is a tick box.** With `rehearsal` ticked, the run builds and starts the app as
   before and commits, tags and publishes nothing.
6. **The `release` environment** (0123, rule 7) is limited to the branch `main` instead of to `v*`
   tags, since the run is now on `main`. The owner still approves each use of the secrets. An
   alpha uses none, so it asks for no approval.

## Consequences

- Making the next alpha is one button and no typing.
- What is tagged is the checked commit plus one commit that changes two version lines. That
  commit itself is not run through CI: a push by the workflow's token starts no workflow.
- The job that sets the version can write to `main`. It runs only what is in the repository, with
  no input other than the version, which is checked against a pattern before it is used.
- If the build fails after the version commit, the commit and the tag stay. "Re-run failed jobs"
  builds the same tag again. Starting the workflow afresh makes the next number, and the failed
  one is skipped; that is harmless.
- If `main` is ever protected so that changes need a pull request, the workflow must be allowed
  to bypass that for this one commit, or the version commit must become a pull request. Tags
  matching `v*` should then be creatable only by the workflow and the owner.
- Pushing a `v*` tag by hand no longer does anything.
