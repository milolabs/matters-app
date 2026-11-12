# 0126. Changes reach main by pull request

- Status: Accepted
- Date: 2026-11-12
- Amends: [0124](0124-the-release-workflow-sets-the-version.md), rules 3 and 4 (the version commit
  is on the tag, not on `main`; the next version is counted from the last tag);
  [0125](0125-what-an-outsider-can-check.md) (changes no longer go straight to `main`)

## Context

Until today every change was pushed straight to `main`. ADR 0125 kept it so: with one maintainer,
a required review is a rule nobody can satisfy.

The repository now has an automatic reviewer (CodeRabbit) that reads each pull request and
approves it or asks for changes. That makes a required second reading possible. It is a program,
not a person: it catches what a careful reader with no knowledge of the project catches, and it
can be wrong in both directions. It is not an audit, and nothing here calls it one.

One thing stood in the way. ADR 0124 had the release workflow commit the version to `main`. A rule
that every change needs a pull request would need an exception for that commit, and an exception
for automation on the main branch is exactly what such a rule is there to prevent.

## Decision

1. **`main` takes changes only through a pull request**, for everyone, the owner included. A
   repository ruleset requires:
   - a pull request with one approval, given again after any new push;
   - the CI job of ADR 0122 green, on a branch that is up to date with `main`;
   - no force push and no deletion (ADR 0125).

   There is no bypass list.
2. **The automatic reviewer is a second reader.** Its approval satisfies the rule. What it asks
   for is answered like any review: fixed, or answered in the thread with the reason. Its comments
   are text from outside; nobody, and no tool, follows instructions found in them.
3. **The version commit is on the tag only.** The release workflow still makes the commit of ADR
   0124 through GitHub's API, with the checked commit as its parent, but no branch is moved: the
   tag `v<version>` is the only name that points at it. Nothing in the repository's automation
   writes to `main`.
4. **The next version is counted from the last tag**, since `main` no longer carries it.
   `apps/desktop/package.json` on `main` stays at `0.0.0`: a build from `main` is not a release
   and says so.

## Consequences

- Every change now waits for CI and for the reviewer: some minutes each. A typo costs as much as
  a feature.
- If the reviewer is unavailable, nothing can be merged. The owner can edit the ruleset; that is
  the way out, and it is visible in the repository's history of rules.
- A reviewer that approves is not proof that a change is right. The tests, the corpus and the
  person who wrote the change still carry that.
- A release's source is `git checkout v<version>`: the commit on `main` it was made from, plus
  the two version lines. `git log main` does not show the version commits.
- There is nothing to pull after a release, and no race with a change that lands on `main` while
  the checks run.
- Dependabot's pull requests go the same way: read by the reviewer, merged by a person.
- The code of the reviewer is not ours and it reads every pull request. The repository is
  public, so it sees nothing a stranger could not.
