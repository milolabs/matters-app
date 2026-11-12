# Security policy

Matters reads mail, and mail is written by strangers. We want to hear about anything that lets a
message, a mail server or a web page do more than it should.

## Reporting a problem

Please do not open a public issue for a security problem.

Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/milolabs/matters-app/security/advisories/new).
Only the maintainers see the report.

It helps to include:

- the commit you tested;
- what an attacker gains, and what they need to start with (a message they can send, a server they
  control, a file on the computer);
- the smallest message or steps that show it. A message in `.eml` form is best: it can become a case
  in the corpus;
- whether real data may already have been exposed.

Take out anything unrelated first: real mail, passwords, tokens, other people's addresses.

## What happens next

- We answer within seven days to say the report arrived.
- We tell you whether we can reproduce it, and what we plan to do.
- We fix it on `main` and, where a message shows the problem, add it to the hostile-mail corpus so it
  stays fixed.
- We credit you in the advisory unless you ask us not to.

Please give us a reasonable time to fix a problem before writing about it in public. If you looked
for problems in good faith, on your own mail and your own computer, and reported what you found here,
we will not take legal action against you for it.

## Supported versions

There is no release yet. Fixes are made on `main`; that is the only supported version.

## What should hold

These are the walls. A way around any of them is a security problem:

- A message cannot run script, and cannot reach the network while remote images are off.
- A message cannot make the app open a window, navigate away from its own pages, or hand the system
  a link that is not `http`, `https` or `mailto`.
- No password is sent to a mail server before TLS, and a certificate that fails validation is never
  accepted.
- Passwords are kept through the operating system's keychain. A stored password is never given
  back to the window, and never reaches the logs or a model.
- A model receives mail only from an account you turned AI on for, and only through the runtime you
  chose for it. Work never moves to another runtime by itself.
- Text in a message is data to a model, never instructions, and text the page hides from you is not
  sent to it.
- The window has no access to Node.js or to Electron's APIs.

## What is not a security problem by itself

- Someone who already controls your user account on the computer can read your mail: the local
  database is not encrypted by Matters. Use the disk encryption of your system.
- A message that fits a view's prompt by its own words shows up in that view. The limit on this is
  described in [ADR 0116](docs/adr/0116-a-prompt-is-a-filter.md).
- What a mail provider or an AI provider does with data once it has it. Their terms apply.
- The gaps already listed, with their severity, in
  [docs/security/standards.md](docs/security/standards.md). A way to make one of them worse than it
  is rated there is welcome.

## More

- [Threat model](docs/security/threat-model.md): what we protect, from whom, and where the walls are.
- [Mail security standards, and where Matters stands](docs/security/standards.md): each requirement,
  its source, and the test that proves it.
