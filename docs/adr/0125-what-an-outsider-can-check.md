# 0125. What an outsider can check

- Status: Accepted
- Date: 2026-11-12
- Builds on: [0047](0047-hostile-mail-corpus.md),
  [0122](0122-security-policy-and-checks-on-every-change.md)
- Amends: [0123](0123-releases.md), rule 1 (a release also carries its build record as a file)

## Context

ADR 0122 turned on the OpenSSF Scorecard: a public, automatic reading of how a project is run. Its
first result for this repository was 6.0 out of 10 (2026-11-12). Some of what it found is true and
worth fixing; some of it cannot be fixed by one person in a day.

What it found that we can act on:

- **Four known vulnerabilities in dependencies.** One in `fflate` 0.8.2, which reads archives a
  stranger sent (a malformed ZIP64 file makes `unzipSync` loop for ever). Three in `nodemailer`
  10.0.14, which the app does not ship: an IMAP server used only by tests brings its own old copy.
- **No fuzzing.** The corpus of ADR 0047 holds cases somebody thought of. Nothing looked for the
  input nobody thought of.
- **`main` could be rewritten or deleted** by a force push.
- **One container image named by tag**, not by digest: the base of the test IMAP server.
- **A release would carry no build record as a file.** The attestation of ADR 0123 lives with
  GitHub; a person holding only the download cannot check it offline.

What it found that we leave for now: no second person reviews changes, the project is younger
than 90 days, it has one contributor, and it has no OpenSSF Best Practices badge.

## Decision

1. **Known vulnerabilities are fixed when they are found**, without the week's wait that ordinary
   updates get (ADR 0122). `fflate` goes to 0.8.3. `nodemailer` is held at the version the app
   itself uses for every package that asks for it (`overrides` in the root `package.json`).
2. **Property tests, with `fast-check`.** Code that reads what a stranger wrote gets tests that say
   what must hold for *any* input and try thousands of made-up ones. The first is the reader of
   `Authentication-Results` (ADR 0048): it never throws, reads nothing when no server is trusted,
   picks only a header that starts with the trusted server's name, and never passes a message on a
   DMARC pass for another domain. They run with the other tests on every change. An input that
   breaks a property becomes a case in the corpus.
3. **`main` cannot be force-pushed or deleted**, by anyone: a repository ruleset.
4. **The test image is pinned by digest**, and Dependabot proposes a newer one monthly.
5. **A release carries its build record as a file**, `<image>.intoto.jsonl`, beside the disk image:
   the same attestation, checkable without asking GitHub.

## Consequences

- `fast-check` is a new development dependency (MIT).
- The override must be looked at when `nodemailer` is updated: it holds every copy at one
  version, so it has to follow the version the app uses.
- Changes still go straight to `main` without a pull request and without a second reader. With
  one maintainer a required review would be a rule nobody can satisfy. When there is a second
  maintainer: pull requests, required checks, and a review, with the release workflow's version
  commit (ADR 0124) allowed through.
- Property tests are not a fuzzer that runs for hours and keeps what it found. They try a fixed
  number of inputs per run, with a new seed each time, so a failure may show up on an unrelated
  change. The failing input and seed are printed; the fix is the property or the code, never a
  retry.
- The mail HTML sanitizer, the MIME parser and the IMAP response reader have no property tests
  yet. They are the next ones.
- The score is a reading from outside, not the goal. We change what it is right about.
