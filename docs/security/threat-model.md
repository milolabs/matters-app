# Threat model

What Matters protects, from whom, and where the walls are. This page is short on purpose. The detail,
with a source and a test for each requirement, is in [standards.md](standards.md); how to report a
problem is in [SECURITY.md](../../SECURITY.md).

## What we protect

| What | Where it is |
| --- | --- |
| The mail itself, and its attachments | a SQLite database and files on your computer |
| Passwords of mail accounts | encrypted through the operating system's keychain (Electron `safeStorage`) |
| Who you are to others | what the app sends in your name: only what you approved |
| Your attention | what a message is allowed to look like, and what a view shows you |
| Your AI plan | sign-in stays with the runtime's own program; Matters never sees a token |

Matters has no server. Nothing here is copied to us, and there is no telemetry.

## Who we defend against

| Who | What they can do | What they must not get |
| --- | --- | --- |
| **The sender of a message** | choose every byte of a message: headers, HTML, files, names | script, network requests with images off, a false identity that looks verified, a link or file that is not what it shows, instructions to a model |
| **Someone on the network** | read and change traffic between the app and a mail server | a password, mail in plain text, an accepted bad certificate |
| **A web page a message links to** | serve anything once you open the link in your browser | anything inside the app: links open in the system browser, never in a Matters window |
| **A hostile mail server lookup** | answer autoconfig and DNS lookups with false settings | a sign-in over plain text, credentials sent while probing |
| **A dependency** | ship changed code in a new version | a version we did not choose: versions are pinned in `bun.lock`, and licenses are checked |

## Who we do not defend against

- **Someone with your user account on the computer**, or malware running as you. They can read the
  database, which Matters does not encrypt, and can ask the keychain as you can.
- **Your mail provider.** It has your mail already.
- **The AI runtime you chose.** A runtime on a plan receives the text you agreed to send to it, and
  its provider's privacy settings apply. A model on your computer (Ollama) keeps mail on it.
- **A hostile IMAP server over a valid TLS session.** Malformed responses from a server you signed in
  to are not in the corpus yet.

## The walls

1. **The window is a sandbox.** Context isolation and the sandbox are on, Node integration is off,
   every permission request is denied, new windows are denied, navigation is prevented, and the
   preload exposes no Electron API ([standards.md, A6](standards.md#a6-the-electron-checklist)).
2. **A message is a frame without script.** Mail HTML is sanitized and shown in a sandboxed frame
   with its own content security policy. Remote images load only by a rule you set
   ([ADR 0024](../adr/0024-rendering-mail-html.md), [ADR 0037](../adr/0037-remembering-image-choices.md)).
3. **TLS before anything.** Certificates are validated by name and chain, with no click-through; no
   credential is sent before TLS; plain text needs an explicit opt-in
   ([standards.md, A1](standards.md#a1-connecting-to-the-server)).
4. **A verdict only from a trusted header.** Who wrote `Authentication-Results` decides whether it
   is believed ([ADR 0048](../adr/0048-trusting-authentication-results.md)).
5. **Passwords stay away from the window.** They are encrypted and decrypted in the main process,
   through the keychain, and handed only to the backend process that signs in to the mail server.
   A stored password is never given back to the window, and never reaches the logs or a model.
6. **A model is behind code.** Instructions are fixed text, mail goes in as data, hidden text is left
   out, an answer must match a schema, and a quote must occur in the message it names. Each turn runs
   with the runtime's own tools off, and AI is off for an account until you turn it on
   ([ADR 0051](../adr/0051-agents-on-the-users-own-plans.md),
   [standards.md, A7](standards.md#a7-mail-read-by-a-model)).
7. **Nothing is sent without you.** A message leaves only after you approved it
   ([ADR 0020](../adr/0020-sending-outbox-and-compose.md)).

## How we know

- **The hostile-mail corpus** ([ADR 0047](../adr/0047-hostile-mail-corpus.md)): made-up hostile
  messages and server behaviours, each tied to a standard or to published research, run through the
  real code. A defence that stops working fails a test.
- **Checks on every change**: tests, types, lint, the architecture's boundaries, dependency licenses,
  and static analysis ([ADR 0122](../adr/0122-security-policy-and-checks-on-every-change.md)).
- **Property tests**: the reader of `Authentication-Results` is tried on thousands of made-up
  headers on every change ([ADR 0125](../adr/0125-what-an-outsider-can-check.md)). Other parsers
  are not covered this way yet.
- **What is open is written down.** Every known gap has a severity and a case in
  [standards.md](standards.md). Nothing high or critical is open.

## What is not done yet

- **Releases.** Nothing has been released. How a release is built, signed, notarized and recorded
  is decided ([ADR 0123](../adr/0123-releases.md), [the release plan](../release.md)) and can be
  rehearsed, but the first one waits for the project's Developer ID. Before that, alphas are
  signed ad hoc and not notarized, and a published one is offered on the site
  ([ADR 0129](../adr/0129-the-site-offers-pre-releases.md)): macOS does not vouch for them, and
  the build attestation is the only proof of where one comes from. There is no update channel:
  a person with an old version is not told about a new one.
- **An independent audit.** Nobody outside the project has reviewed the code yet.
- **OAuth sign-in, PGP and S/MIME** are not built
  ([standards.md, Part C](standards.md#part-c-out-of-scope-for-now)).
