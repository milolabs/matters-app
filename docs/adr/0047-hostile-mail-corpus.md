# 0047. A corpus of hostile mail, run through the real code

- Status: Accepted
- Date: 2026-11-05

## Context

The owner asked for the best security standards for mail to be checked against this client, and for
Matters to be a role model among open-source mail programs. A statement such as "the sender's HTML
cannot reach the network" is only worth what has been tried against it. Mail clients keep failing in
the same few places: who the sender is (Composition Kills, 2020), what an HTML message can fetch or
run (EFAIL, 2018; mXSS; SVG), what a link or a file name really is, and what the connection to the
server does when it is attacked (Why TLS is better without STARTTLS, 2021).

Our own tests check what we thought of. A corpus checks what others found: a set of hostile messages
and hostile server behaviours, each tied to a standard or to published research, run through the real
code, so the project can prove which defences hold and see exactly which do not.

## Decision

1. **What the corpus is.** Messages in `packages/testkit/corpus/<category>/<id>.eml`, byte-exact, and
   `packages/testkit/corpus/manifest.json`. A case that is not a message (a hostile server, a hostile
   draft) has a manifest entry and a scenario in code. Messages too large to commit are made at run time
   by a named generator (`packages/testkit/src/corpusGenerators.ts`). Categories: `identity`,
   `auth-results`, `html`, `mime`, `attachments`, `compose`, `transport`.
2. **Every case names its source and its attack.** The manifest entry has the sources (an RFC section, a
   paper, a CVE, an advisory), a sentence on what it attacks, and the checks it must pass. A source is
   cited only when it was read; a class of attack described in public write-ups but not re-read is
   labelled "class".
3. **Ours and harmless.** Every message is written for this repository, in our own words. Payload
   collections are not copied, only patterns that a standard or paper describes. Hosts are `example.com`,
   `example.org`, `example.net`, `*.test` and `*.invalid`; the canary host is the token `canary.test`,
   which the browser tier replaces with `127.0.0.1:PORT`. Payloads only signal: they set a marker or
   make a request to the canary. No malware, no real attachment that executes, no real people or
   companies, no real credentials. `packages/testkit/corpus/.gitattributes` marks `*.eml` as `-text`, so
   CRLF and 8-bit bytes survive a checkout.
4. **Real mail is never committed.** The corpus is made up. A message taken from a mailbox, anonymised
   or not, does not go into the repository. A new attack is reproduced by writing a message that has the
   same shape.
5. **Adding a case when an attack is published.** One `.eml` file and one manifest entry, in this order:
   write the message; add the entry with `ideal` values (what must be true for the defence to hold); run
   the tier; if a check fails because the defence does not hold, run again with
   `CORPUS_REPORT=/tmp/gaps.jsonl` (which writes the measured value of each failing check) and record the
   gap as in rule 8. Checks are named values the runners measure (`senderAuth`, `labelClean`,
   `blockedHits`, `attachmentRunnable`, and so on); a new kind of check is added to the tier that
   measures it, and a check no runner can answer fails the run.
6. **Four tiers, on the real code.**
   - *node* (`apps/desktop/test/corpus/node.test.ts`, in the normal unit run): the real MIME parser,
     the sender verdict, the image rules, reply and file-name code, Save all over real files, and the
     real IMAP sync over an in-process IMAP server for a message that makes the parser throw.
   - *compose* (`compose.test.ts`, normal run): a draft goes through the real send path (queue, Markdown
     renderer, MIME composer, SMTP submission) into a real SMTP server in the process; the bytes it
     received are inspected.
   - *transport* (`transport.test.ts`, normal run): the real IMAP connection, SMTP submission, server
     prober and autoconfig against hostile servers on real local sockets with real TLS. Certificates are
     made at test time with the `openssl` command; none is committed.
   - *browser* (`tools/smoke-security.ts`, the root `smoke:security` script, needs Docker): the messages go to the
     Docker IMAP server, the built app syncs them, opens each through the real reader (sanitizer, sandboxed
     frame, page policy), once with images off and once with images allowed from the sender, follows every
     link, and a few messages are also put into the frame without the sanitizer, so each wall is tested
     alone. A canary HTTP server on 127.0.0.1 counts every request, by case.
7. **Controls.** A run that cannot fail proves nothing. Each tier carries controls that must pass before a
   refusal counts: a valid certificate is accepted (transport); a client that opts in to plaintext is seen
   sending its password (transport); the TLS 1.1 server really speaks TLS 1.1 (transport); a message
   that is delivered must arrive at the SMTP server (compose); a remote image with images allowed reaches
   the canary exactly once and main's request spy sees the same request; a plain link reaches the
   openExternal spy; a page that tries to leave is seen by the navigation spy; a refresh to our own page
   injected past the sanitizer is seen as a navigation (browser). A failing control fails the run.
8. **The ratchet.** Every check is either `holds`, or has a `gap` with a severity (`critical`, `high`,
   `medium`, `low`), a one-line reason and the `current` value measured today. A check without a gap must
   equal its `ideal`. A check with a gap must equal its `current` value: the test asserts the weak
   behaviour, so it fails when the behaviour changes, and says to remove the entry when the defence now
   works. Nothing is skipped; a check that cannot run fails. Each tier prints counts of `holds` and
   `knownGap` by category at the end of its run.
9. **Severity.** `critical`: a message runs code in the app, makes a remote fetch with images off, or a
   credential leaves before TLS. `high`: one message can make the app unusable or deceive the reader about
   who it is from, with no way for the reader to notice. `medium`: a defence is missing that a published
   attack uses, with a limited effect. `low`: hardening, or a risk that only exists on a platform we do not
   ship yet.
10. **Hooks that only exist in a development build.** The browser tier uses `MATTERS_SMOKE_MODE=security`,
    honoured only when `!app.isPackaged` and `MATTERS_SMOKE=1`, like every smoke hook. In that mode main
    prints every navigation of the window (and whether it was stopped), every network request that leaves
    it, and every link handed to the system, instead of handing it to the system. Nothing in a packaged app
    reads it.
11. **Proving the corpus can fail.** After a change to a defence, or to the corpus, weaken the defence on
    purpose and see the right cases go red, then restore it (the list of such mutations and the cases that
    caught them is in `docs/security/standards.md`). A defence with no case that goes red when it is removed
    is not tested.
12. **The readable view.** `docs/security/standards.md` says which standards apply to a mail client, where
    each is in our code and whether it holds, with the case ids. When a gap is fixed, the manifest entry and
    that table change in the same commit.

## Consequences

- The project can state, case by case, what holds and what does not, and a regression in a defence fails a
  test with the standard in the message.
- Known gaps are visible in the repository with a severity, not in a private list. Fixing one forces the
  manifest to change.
- The normal unit run grows by about ten seconds (real sockets and a real database); the browser tier
  takes minutes and needs Docker, so it is a command, not part of the unit run.
- The transport tier needs `openssl` on the machine. Without it the tier fails with a message saying so,
  rather than passing.
- A corpus is only as good as its sources. The standards document says which parts were read in the
  primary text and which are classes known from write-ups.

### Refinement, 2026-11-05: a message the parser cannot read

1. **The parser's contract.** `MimeParserPort.parse` never rejects because of a message's bytes. A
   message that cannot be read comes back with no sender, no subject, no addresses, no HTML, no files,
   `senderAuth` "unknown" and a short notice as its text. The sync fills sender, recipients, subject and
   date from the IMAP ENVELOPE, so the row stays useful. The adapter catches every failure, a programming
   error included, because the two cannot be told apart cheaply; it logs nothing.
2. **Stored once, not retried.** Such a message is stored like any other and is not downloaded or parsed
   again. A later parser version does not re-read it. It is still on the server.
3. **Network failures are unchanged.** `syncAccount` has no recovery of its own: a connection error still
   stops the run and is retried.

### Refinement, 2026-11-05: a category for mail read by a model

1. **`agent`.** Seven cases under `packages/testkit/corpus/agent/` (an eighth category beside the seven
   above): instructions in the body, in the Subject and in a display name, spoofed `[Message n]` markers,
   text hidden in HTML, a model made to quote what is not there, and invisible characters. They are
   written for this repository with harmless content: the payloads are marker words such as
   `IGNORE-ALL-PREVIOUS-INSTRUCTIONS`, and nothing asks for anything real.
2. **No model runs.** The node tier builds the prompt the way the service does (the real parser, the
   service's own `textForPrompt`, the real `buildAnalysisRequest`) and feeds the real `acceptAnalysis` an
   answer that obeyed the message. What is measured is the code around the model (ADR 0051, rule 9).
3. **New checks of the node tier:** `promptInstructionsFixed`, `mailOnlyInUntrusted`,
   `promptMessageMarkers`, `hiddenTextInPrompt`, `visibleTextInPrompt`, `invisibleCharsInPrompt`,
   `storedTextHasHiddenWords`, and the quote checks `fabricatedQuoteAccepted`,
   `quoteOfMissingMessageAccepted`, `joinedPassagesAccepted`, `hiddenQuoteAccepted`,
   `forgedOwnPromiseAccepted`, with `controlQuoteAccepted` as the control that a true quote is kept.
4. **One gap is recorded.** `storedTextHasHiddenWords` (low); see `docs/security/standards.md`, A7.
