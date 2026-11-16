# 0143. Matters opens `mailto:` links, and can be the default mail app

- Status: Accepted
- Date: 2026-11-16
- Amends: [0048](0048-trusting-authentication-results.md) (section 3, rule 3: a `mailto:` in a
  message opens a draft here instead of going to the system), [0107](0107-matters-runs-on-macos-as-its-own-app.md)
  (the bundle declares the `mailto` scheme), [0110](0110-one-instance-per-data-folder.md)
  (rule 2: a second start's `mailto:` arguments are forwarded), [0137](0137-the-app-says-when-a-newer-version-is-out.md)
  (About gets a row for the default mail app)
- Builds on: [0012](0012-performance-budgets.md), [0020](0020-sending-outbox-and-compose.md),
  [0036](0036-settings-window.md), [0101](0101-a-new-message-reads-like-a-letter.md),
  [0103](0103-the-window-waits-for-the-page-not-a-clock.md), [0105](0105-the-app-identity-moves-to-matters.md),
  [0142](0142-a-signature-of-the-persons-own.md)

## Context

Read from the code on 2026-11-16:

- Matters did not register for `mailto:`. A `mailto:` link clicked in a message was rebuilt by
  `safeMailto` (addresses, `subject` and `body` only) and handed to the system's mail program (ADR
  0048). A link clicked in a browser never reached Matters.
- ADR 0110 left room for this: "a later decision that adds a URL scheme or file opens forwards
  them here". The app read nothing from its command line.
- The composer is one at a time: `compose.open` does nothing while one is open. A new message
  filled in from outside (the agent's offer, ADR 0102) is saved only once the person writes, and
  the account's signature is placed under its text by code (ADR 0142).
- The text is Markdown. The renderer has raw HTML off and images off (ADR 0020, rule 11), so a
  body cannot make markup or a remote image. It does make links: `[text](https://…)` is a link
  whose text is not its address, and a bare web address is linked to itself. A `>` that starts a
  line reads as quoted mail and a `-- ` line as the signature (ADR 0142), which changes where the
  account's signature goes and what the agent reads.
- macOS keeps the default mail app. Electron sets it with `app.setAsDefaultProtocolClient` and
  reads it with `app.isDefaultProtocolClient`. A build that is not packaged would name the Electron
  runtime, not Matters. There is no call that gives the default back. On macOS 26 the choice is in
  Mail's settings: the General pane has "Default email reader" (read from the strings of Mail's
  settings window on this Mac); System Settings has a default web browser and no default mail app
  (read the same way from its Desktop & Dock pane). Whether macOS asks before it changes the
  default for `mailto` was not tried.
- A link that starts the app arrives as `open-url` before `ready`, so its handler must be there
  before; Windows and Linux give a link as an argument.

## Decision

1. **The bundle says it can open `mailto:`.** `tools/bundle-macos.ts` writes `CFBundleURLTypes`
   with one entry, the scheme `mailto`, role `Editor` (Matters writes a message from the link), and
   reads it back, failing when it is not there. macOS then lists Matters among the mail programs.
   Declaring is not claiming: installing or starting Matters never makes it the default.

2. **Becoming the default is the person's press.** Settings › About has a row, *Default mail app*,
   under *Newer versions* (About is where the app speaks about itself on this Mac; a section for
   one row was not added). It says whether Matters opens mail links from the browser and other
   apps now, and offers *Make Matters the default mail app*, which calls
   `app.setAsDefaultProtocolClient("mailto")`. It says that macOS may ask to confirm, and reads the
   state again when the window comes back to the front. When Matters is the default the row says
   so and where to choose another: "open Mail's settings: General › Default email reader". Nothing
   asks at first run, and there is no banner or dialog of ours. Only a packaged app offers the
   button; any other build says "This build cannot be the default mail app", as About says for the
   version check. The calls sit behind a small client (`MailtoClient`); a window test of a build
   that is not packaged may use a stand-in that only remembers the press
   (`MATTERS_TEST_DEFAULT_MAIL=1`), and a packaged app reads no such variable.

3. **A link is hostile input.** It is read by `parseMailto` in core (RFC 6068), pure, never
   throwing:
   - the addresses of the path and of `to`, `cc` and `bcc`; `subject`; `body`. Every other field
     is dropped whatever its name or spelling (`attach`, `attachment`, `from`, `reply-to`,
     `in-reply-to`, `keywords`, unknown ones), and so is a fragment. No file is ever attached and no
     other header is set.
   - The link is split at `?`, `&`, `=` and `,` first and each part is percent-decoded once, so an
     encoded `&` or `=` stays text and `%2525` stays `%25`. A decoded comma separates addresses as a
     written one does. `+` is a plus. A part that is not valid percent-encoding is dropped.
   - An address must have the shape the composer accepts (`hasAddressShape`), with no white space,
     no control, format or separator character, none of `<>,;:"\?#()[]`, and at most 254
     characters. Anything else is dropped, never guessed. An address is kept once: To before Cc
     before Bcc, whatever the order in the link. A repeated `to`, `cc` or `bcc` adds; for `subject`
     and `body` the first wins.
   - Limits: a link longer than 32 768 characters is refused whole; at most 50 recipients, the
     later ones dropped; the subject is cut at 998 characters and the body at 20 000 (never inside
     a surrogate pair).
   - The subject is one line: line breaks and tabs become a space, other control characters go.
     `subject=a%0d%0aBcc:%20x` is the subject `a Bcc: x`, and nobody is in Bcc.
   - The body is text: line ends become `\n`, control characters other than the line feed and the
     tab go, and it is made Markdown that reads as that text (`plainBodyMarkdown`): `[` and `]` are
     escaped (no link with other text, no reference, no image), a `>` that starts a line is escaped
     (no quote), a `--` line is escaped (no signature), and a backslash before punctuation is
     doubled so it cannot cancel an escape. A bare web address is still linked, to itself, as text
     the person sees. Raw HTML needs nothing: it is shown as text. The escapes are visible in the
     editor and in the text part, the cost ADR 0045 accepted for forwards.

4. **A link only opens a draft.** The mail window opens a new message as `c` does (the account of
   the open thread, else the first), with the fields filled, the account's signature under the
   body (ADR 0142), and the caret where the composer puts it for a filled-in message: in To when
   the link gave no address, else at the top of the text. Nothing is sent and nothing is saved
   until the person writes (ADR 0101); sending still needs the approval of ADR 0020. With no
   account yet the app starts with setup as before; links that came meanwhile wait in main for
   that session only (at most five) and open once the mail window is there. Nothing is shown about
   them before.

5. **One copy, and the launch first.** Main registers `open-url` before `ready` and keeps each link
   it reads in a queue of at most five; more are dropped. The mail window takes one when it has
   shown its mail (ADR 0103) and no composer is open: when main says one came, and when a
   composer closes. So a link that starts the app waits until the first window has shown, adding
   nothing to the launch path (ADR 0012); a link that arrives while Matters runs brings the window
   forward and opens its draft; several links open their drafts one after the other as each is
   closed. A `mailto:` argument of the start, or of a second start on the same data folder (ADR
   0110), is read the same way; nothing else of the arguments is read. A smoke run never opens a
   composer from a link: it writes one line with the counts (`matters-mailto: … waits (to 1, …)`).
   An erase or an unreadable data folder drops links.

6. **Links inside mail.** A `mailto:` clicked in a message opens Matters' own composer, through
   the same reader and the same queue, instead of leaving for the system's mail program. The
   reader's checks are unchanged and come first: a link whose text names a site asks before it is
   followed (`misleadingHost`), and only `http`, `https` and `mailto` are followed at all. Web
   addresses still go to the browser. `safeMailto` and `linkForSystem` stay as they were; main no
   longer hands them a mail link.

7. **Where it lives.** Core: `parseMailto`, `plainBodyMarkdown` and the limits
   (`packages/core/src/domain/mailtoLink.ts`). Main: the queue, the arguments and the default-app
   client (`mailtoLinks.ts`), the shapes the preload checks (`mailtoShapes.ts`), and the handlers
   in `index.ts`. Preload: `mailtoBridge.ts`, which exposes nothing; the page asks for the next
   link without naming one, and for the default by action name (`get`, `make`). Renderer: the mail
   window takes links in `app.tsx` and opens them through `compose.open("new", …, prefill)`; the
   row is `defaultMailRow.tsx`.

### Not tried, and why

- **Asking at first run, or a banner offering to become the default.** It claims attention for
  something the person did not ask for; the row in About is enough.
- **Several composers at once.** The app has one; a queue that opens drafts in turn keeps that,
  and five is enough for a page that wants a few addresses written.
- **Display names in a link (`Anna <anna@x>`).** RFC 6068 has addresses there; a name is text a
  page chooses for the person to trust.
- **Dropping `bcc` from a link.** The draft shows Bcc as any other field and nothing leaves without
  the person; dropping it would break ordinary links that use it.
- **A notice in the composer that a link was cut or had fields dropped.** The draft shows what was
  kept, which is what will be sent; a line about what was not would be one more thing to read.

### Not in this decision

- Other schemes (`message:`, `webcal:`) and opening `.eml` files.
- A default mail app on Windows and Linux, where the app is not shipped.
- Taking the default back; macOS has no such call for an app.

## Consequences

- Matters can be the person's mail app for links everywhere, and a mail link in a message stays in
  Matters.
- A body with `[`, `]`, a line starting with `>` or a `--` line shows backslashes in the editor
  and in the text part.
- While a composer is open, a link waits, and nothing says so until the composer closes.
- The last address of a field shows as text still being typed, as for every message the composer
  opens filled in; the others are chips.
- `dist/Matters.app` from `bundle:macos` declares the scheme too. It is not packaged (its
  executable keeps Electron's name), so it never offers the button; macOS may still list it among
  the mail programs once it has seen the bundle.
- Tested: core unit and property tests (`mailtoLink.test.ts`, `mailtoLink.property.test.ts`), the
  rendered HTML of a link's body (`adapter-compose/test/render.test.ts`), the queue, the client
  and the bridge (`apps/desktop/test/mailtoLinks.test.ts`), window tests on the demo mailbox
  (`apps/desktop/e2e/mailto.e2e.ts`: a link delivered as Electron's `open-url`, links in a row, a
  link that starts the app, a link from a message, both states of the row), a second start's
  argument in `tools/smoke-instance.ts`, the corpus case `html-link-mailto-parameters`, and the
  bundle's own read-back of `CFBundleURLTypes`.
- Not verified: a link clicked in a browser reaching a packaged Matters, really becoming the
  default (whether macOS asks first, and what `isDefaultProtocolClient` says right after), and how
  a signed release behaves with the declared scheme. None of these was tried on this machine on
  purpose: it would change the person's default mail app.
