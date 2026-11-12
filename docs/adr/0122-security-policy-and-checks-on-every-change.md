# 0122. A security policy, and checks on every change

- Status: Accepted
- Date: 2026-11-12
- Builds on: [0012](0012-performance-budgets.md), [0013](0013-dependency-license-policy.md),
  [0047](0047-hostile-mail-corpus.md)

## Context

The repository is public. A person who finds a security problem had nowhere to send it: the README
asked for a private report and named no way to make one. The checks (types, lint, boundaries,
licenses, tests with the corpus) existed as commands a person runs by hand, so nothing showed a
reader that `main` passes them, and nothing stopped a change that does not.

A mail client asks for a lot of trust and the project has no audit, no release and no users yet. What
it can show today is how it is run. Two public, free measures exist for that, both from the Open
Source Security Foundation: the Scorecard, which a machine computes from the repository, and the
Best Practices badge, which the project fills in with evidence. Both look for the same things: a
policy for reports, checks on every change, static analysis, pinned dependencies, and workflows
that hold no more permission than they need.

Tried on a fresh clone on 2026-11-12, the commands of the README did not all pass. `lint` failed on
`apps/desktop/build/icons/icon.svg` (an icon has no title). One test that times the killing of a
child process failed when every file ran at once and passed three times alone. On a second run
`rankedSearchPerf.test.ts` measured a p95 of 50.1 ms against its budget of 50 ms, and its retries
failed on the database the first try left behind.

## Decision

1. **A policy for reports.** `SECURITY.md` at the root: reports go through GitHub's private
   vulnerability reporting, we answer within seven days, and a message that shows a problem becomes
   a case in the corpus. It lists the walls that should hold, so a reporter knows what counts.
2. **A threat model.** `docs/security/threat-model.md`: what is protected, from whom, who is out of
   scope, and the walls, each pointing at its ADR and its rows in `standards.md`. It also says what
   is not done: releases, an audit.
3. **The checks run on every push to `main` and every pull request**, on macOS, as the same commands
   a person runs: `typecheck`, `lint`, `check:boundaries`, `check:licenses`, `test`. In CI a failed
   test is tried twice more, for the tests that time a child process. The two tests that hold a
   search to a budget in milliseconds (`*Perf.test.ts`) are left out of CI: a shared runner is
   slower than the machines the budgets were set on, and uneven from run to run.
4. **Static analysis.** CodeQL reads our TypeScript and the workflows themselves, on every change and
   once a week.
5. **The Scorecard runs** on every push to `main` and once a week, and publishes its result.
6. **Updates come as pull requests** (Dependabot), for packages and for actions, a week after a
   version appears, so each passes the checks and the license policy of ADR 0013 before it lands.
7. **Workflows hold little.** Every action is pinned to a commit. A workflow starts with read access
   only, a job asks for what it needs, and a checkout keeps no credentials.
8. **Build assets are not linted.** `apps/desktop/build` holds icons, not source.

## Consequences

- A reader can see that `main` passes, and a reporter has a private way in.
- The Docker-based runs are not in CI yet: `test:imap`, `smoke:security` (the browser tier of the
  corpus) and the other smoke runs. The macOS runners have no Docker. Until they run somewhere, a
  person runs them before a release, and `standards.md` stays the record of when.
- The performance budgets of ADR 0012 are not in CI either, and this decision takes the two search
  budgets out of the run as well. ADR 0012 still stands and is not met: budgets need a machine that
  is the same from run to run. Until there is one, a person runs `bun run test` whole, and
  `bench:launch`, before a release.
- A retried test can hide a real fault that shows only sometimes. The retries are for CI alone; a
  test that needs them often should be repaired.
- Dependabot will open pull requests. Each needs a look at the license note when `check:licenses`
  asks for one.
- The seven days in the policy are a promise somebody has to keep.
