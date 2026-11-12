# 0128. Tests are not scanned by CodeQL

- Status: Accepted
- Date: 2026-11-12
- Amends: [0122](0122-security-policy-and-checks-on-every-change.md), rule 4 (CodeQL reads the
  code that ships, not the tests)

## Context

CodeQL (ADR 0122, rule 4) read every TypeScript file in the repository. Of its first findings,
seven were in tests: a `<script>` stripped once, a host checked with `includes`, a method called
by a name from a table. In a test that is the point. A test feeds the code the hostile input it
must survive, and builds the fake it needs in the shortest way. None of it runs in the app, and
none of it is in a release.

A finding that is right but does not matter still has to be read, answered and dismissed, on every
new test that does the same. Findings in shipped code then stand in a longer list.

## Decision

1. **CodeQL leaves tests out**: everything under a `test/` folder, and every `*.test.ts` and
   `*.test.tsx`. The list is in `.github/codeql/codeql-config.yml`, and the workflow of ADR 0122
   reads it for both languages; no workflow file matches it.
2. **Shared test helpers outside those paths are still read** (`packages/testkit/src`). They are
   not shipped either, but they are code other tests trust, and a finding there is worth a look.
3. **A finding in shipped code is fixed or answered**, as before. Leaving tests out is not a way to
   move code out of the scan: what the app runs does not live in a test path.

## Consequences

- Code scanning lists what a release contains, so a new finding there gets read.
- A real mistake in a test, one that makes it pass when it should not, is no longer pointed out by
  CodeQL. The tests and the review carry that, as they did for everything else in a test.
- A file moved into a `test/` folder, or named `*.test.ts`, leaves the scan. Review watches for
  shipped code that ends up there.
- The alerts already raised in tests are no longer reported by new scans; any left open are
  dismissed by hand with a pointer to this record.
