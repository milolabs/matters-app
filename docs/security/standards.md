# Mail security standards, and where Matters stands

This is the readable view of the hostile-mail corpus ([ADR 0047](../adr/0047-hostile-mail-corpus.md)).
The corpus is in `packages/testkit/corpus/`: each case names its source and is run against the real
code. The manifest there is the authority; this page explains it. A test checks that every gap in the
manifest appears here and that every case id on this page exists.

Status words, and how each was established:

- **holds**: the defence works. *Tested* means a corpus case proves it and fails when it breaks.
  *Read* means we read the code and did not test it.
- **partly**: it works for the cases tested and not for others, listed in the row.
- **gap**: it does not hold. The row gives a severity (`critical`, `high`, `medium`, `low`) and the
  manifest holds a case that asserts the weak behaviour today, so fixing it forces a change here.
- **n/a**: outside what a client does, or outside what we ship.

A client (an MUA) can only act on what it receives. What a receiving *server* does (SPF, DKIM, DMARC
evaluation, MTA-STS, DANE, TLS reporting) is outside the client; the client consumes the result in
`Authentication-Results`, and Part B says how far that can be trusted.

## Start here

Nothing high or critical is open. No script runs, no remote request leaves with images off, and no
credential is sent before TLS (all tested, below).

All nineteen medium gaps were fixed in [ADR 0048](../adr/0048-trusting-authentication-results.md):
which `Authentication-Results` header is read (A3), who a message says it is from on screen (A2), what a
link's text and a `mailto:` can hide (A4), and the escape of a sender's name in a reply (A5). The gaps that
remain are low.

Mail read by a model has its own section (A7): the instructions stay fixed, a message cannot forge the
prompt's markers or hide text from the person, and a quote must occur in the message it names, written
by the side the fact needs.

**One regression is accepted** (ADR 0048): a mailbox whose server writes `Authentication-Results`
without an authserv-id, which is common for Microsoft (Outlook.com, Microsoft 365), now gets the verdict
`unknown`, and a provider that is neither in the small table nor under the IMAP host's or the address's
domain gets `unknown` too. Images then ask. A reader cannot add a trusted server yet: there is no setting.

One high finding was fixed: `mime-many-headers-50k`. A message of about 640 KB with 50 000 short headers
made `postal-mime` throw "Maximum header size of 2097152 bytes exceeded", and that stopped the sync of the
folder on every run. The parser accepted 30 000 such headers (about 380 KB) and refused 40 000 (about 510
KB). Now `PostalMimeParser.parse` turns any failure into a notice, and the message is stored from the
server's ENVELOPE ([ADR 0047](../adr/0047-hostile-mail-corpus.md), refinement 1). Whether a message like
this gets delivered depends on the receiving server's own limits, which the corpus does not test.
Reproduce the case: `ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run
apps/desktop/test/corpus/node.test.ts -t mime-many-headers-50k`.

## Part A. What the client can do

### A1. Connecting to the server

| Requirement | Source | Where in our code | Status | Cases |
| --- | --- | --- | --- | --- |
| Validate the server certificate by PKIX and the name; no click-through; no pinning offered after a failed validation | RFC 8314 section 5.2, 5.3, 5.4 | `packages/adapter-imap/src/connection.ts`, `packages/adapter-smtp/src/submit.ts` use the libraries' defaults; no product code switches validation off | holds, tested for a self-signed, a wrong-name, an expired and an unknown-CA certificate, on IMAP and SMTP, TLS and STARTTLS; the source scan is read-and-scanned | `transport-tls-valid-control`, `transport-tls-self-signed`, `transport-tls-wrong-hostname`, `transport-tls-expired`, `transport-tls-unknown-ca`, `transport-no-certificate-click-through` |
| Implement TLS 1.2 or later; the minimum is at least 1.1 | RFC 8314 section 5 and 5.2 | Node's default minimum is 1.2 | holds, tested against a server that speaks only TLS 1.1 (the case first proves the server speaks 1.1) | `transport-tls-below-1-2` |
| No credentials, and no operation other than capability discovery or STARTTLS, before TLS; refuse a server that does not offer STARTTLS | RFC 8314 section 5.2; "Why TLS is better without STARTTLS" (Poddebniak et al., USENIX Security 2021): STARTTLS stripping | `openConnection` (`doSTARTTLS: true`), `NodemailerSubmit` (`requireTLS`) | holds, tested: the server received no login and no password, on both protocols | `transport-starttls-stripped`, `transport-starttls-refused`, `transport-implicit-tls-port-speaks-plaintext`, `transport-login-after-probe-claiming-starttls` |
| Plaintext bytes injected next to the STARTTLS answer must not be processed | Poddebniak et al. 2021: response injection | imapflow reports "data after the STARTTLS response" and refuses the session; nodemailer does not act on the line | holds, tested (what counts is that neither client acted on the injected line) | `transport-starttls-response-injection` |
| Plaintext only by an explicit opt-in | RFC 8314 section 5.2; ADR 0018 | `insecureAllowed` in both adapters | partly. Without the opt-in no socket is opened (tested). **gap, low**: the opt-in is an environment variable the adapters read, and `apps/desktop/src/main/index.ts` does not remove it from a packaged app, as it does `MATTERS_TRACE_FILE` | `transport-plaintext-refused-without-opt-in`, `transport-plaintext-opt-in-in-a-packaged-app` |
| The prober asks only for capabilities | RFC 8314 section 5.2 | `packages/adapter-autoconfig/src/probe.ts` | holds, tested: only `CAPABILITY` and `EHLO`, no login | `transport-probe-sends-no-credentials` |
| Ignore advertised services that do not meet the minimum; prefer implicit TLS | RFC 8314 section 3, 5.1 (a correction to the brief: section 5.1 is about SRV records; the "nothing but discovery before TLS" rule is in 5.2) | `packages/adapter-autoconfig/src/config.ts` (`socketType` plain is dropped; implicit TLS ranks first), `index.ts` | holds, tested with a stubbed fetch. **Read only**: the redirect chain is not inspected, only the final address (an HTTPS to HTTP to HTTPS chain would pass), which needs real DNS to test | `transport-autoconfig-http-response`, `transport-autoconfig-plaintext-socket`, `transport-autoconfig-hostile-hostname`, `transport-autoconfig-xml-entities`, `transport-autoconfig-oversized`, `transport-autoconfig-srv-cleartext-only` |
| Show the level of confidentiality of an account | RFC 8314 section 5 (SHOULD) | the account list names TLS or STARTTLS (`accountsSection.tsx`); the composer and the login prompt show nothing | partly (read only) | none |
| DANE; client-certificate authentication | RFC 8314 section 5.3 (MAY), 5.5 | not implemented | n/a | none |

### A2. Who the message says it is from

Sources: "Composition Kills: A Case Study of Email Sender Spoofing Attacks" (Chen, Paxson, Jiang,
USENIX Security 2020), sections 5 and 6, which I read; RFC 5322 section 3.6.2; RFC 9989 (DMARCbis)
section 4.2, 5.3.1 and 11.4 and 11.5, which I read. "Node tier" below means the real parser and the
real `displayName` over the corpus message; the browser tier reads what the reader actually shows.

| Requirement | Source | Where in our code | Status | Cases |
| --- | --- | --- | --- | --- |
| A verdict is not granted when the message does not have exactly one author | RFC 9989 section 5.3.1 and 11.5; Composition Kills section 5.1 (Figure 6) | `onlyFromAddress` in `packages/adapter-mime/src/index.ts` | holds, tested (node tier). Two From headers, a folded name, several addresses and an encoded address: no verdict. A `From :` with a space before the colon and a route portion are `unknown` too: the pass in those messages is for another domain, and `readSenderAuth` now compares `header.from` with the From shown (ADR 0048) | `identity-two-from-headers`, `identity-from-space-before-colon`, `identity-from-name-folded`, `identity-from-two-addresses`, `identity-from-route-portion`, `identity-from-quoted-pair`, `identity-from-encoded-address`, `identity-from-address-then-address`, `identity-from-comment-address`, `identity-sender-only`, `identity-resent-from-beside-empty-from` |
| Show a single, unambiguous sender | Composition Kills section 5.2 (A9 to A13) | `PostalMimeParser.parse` takes the first author | **gap, low**: the first of several authors is shown silently; a quoted-pair address keeps a stray backslash | same cases |
| The sender shown must not hide the real address (display-name attacks) | RFC 9989 section 11.4 (out of scope for DMARC, so for the client); RFC 8601 section 4.1 (the `examp1e.com` warning) | `displayName` in `apps/desktop/src/renderer/format.ts`: a name holding an address that is not the participant's own is shown as `name <address>` | holds, tested in the real reader for `"admin@example.org" <attacker@example.net>`, which now reads `admin@example.org <attacker@example.net>`, and in the node tier for `<a><b>` (which the parser turns into the name `b`) and for unit cases: names that are the address, Persian and Arabic names with joiners | `identity-display-name-looks-like-address`, `identity-from-address-then-address` |
| Mail from an unverified sender must not look like mail from the reader | Sextortion and own-address spoofing (widely reported; no single paper); RFC 9989 section 11.4 | `senderName` in `format.ts`: the sender reads "You" only if the verdict is `pass` or the message is in Sent or Drafts; recipient lines still say "You" for the reader's address (`app.tsx`) | holds, tested: the sender of a message with no authentication that claims `test@example.test` reads `test@example.test` in the real reader; unit tests show Sent mail still reads "You". A server that neither writes a header nor removes forged ones can still be fooled (ADR 0048) | `identity-own-address-spoof` |
| Control and invisible characters, bidirectional overrides and zero-width characters in names, subjects and addresses | Mailsploit (Haddouche, 2017); CVE-2025-61084 (MDaemon: invisible Unicode in From); UAX #9 and UTS #39 | the parser drops them from addresses and NULs and line breaks from names; `displayName` removes bidirectional controls (not joiners, which real names need); names and subjects keep the rest | partly, tested (node tier): an address with NUL, a thin space or an encoded word does not reach the reader as such; a bidi override in a display name is removed before it reaches the reader; **gap, low**: control and zero-width characters in names, bidi controls in a subject | `identity-mailsploit-nul`, `identity-mailsploit-newline-name`, `identity-nul-in-display-name`, `identity-invisible-in-address`, `identity-control-characters-name`, `identity-bidi-display-name`, `identity-invisible-in-name`, `identity-subject-controls` |
| Confusable domains | UTS #39 sections 4 and 5; RFC 5890 | none: nothing in the repository detects mixed scripts | **gap, low**: a Cyrillic letter in the domain is kept and shown as sent (the reader mostly sees names, so the exposure is small) | `identity-homoglyph-domain` |
| A reply goes where the sender asked, and the reader is told when that is not the sender | ADR 0042; RFC 5322 section 3.6.2 | `replyDestination`, `replyRedirect` in `packages/core/src/domain/reply.ts` | holds, tested (including a name that mimics another address, and no false alarm for the same address in another case) | `identity-reply-to-other-domain`, `identity-reply-to-name-spoof`, `identity-reply-to-same-address-case` |
| Duplicate Subject or Content-Type headers: use the instance a verifier uses | Composition Kills section 6.1 (A14, A15); RFC 6376 section 5.4.2 | parser takes the first Subject and the last Content-Type | **gap, low** (we do not verify DKIM, so the harm is a different subject than the signature covered) | `mime-duplicate-subject`, `mime-duplicate-content-type` |

### A3. Using the `Authentication-Results` the server wrote

Sources I read: RFC 8601 section 2.3, 4.1, 7.1, 7.2, 7.3. In 4.1: a consumer SHOULD NOT interpret the
header unless configured to, and not unless its authserv-id is one used in the administrative domain;
it MUST ignore results with codes, property types or methods it does not know; it SHOULD ignore instances
inside `message/rfc822` attachments; and it SHOULD NOT show the results to users without careful
human-factors work. 7.1: a list of trusted hosts "should initially be empty".

| Requirement | Where in our code | Status | Cases |
| --- | --- | --- | --- |
| Interpret only a header from a trusted authserv-id; the trusted list starts empty | `firstTrustedHeader` in `senderAuth.ts` takes the topmost header whose id `isTrustedAuthServ` (`packages/core/src/domain/authServ.ts`) accepts; the sync gives the parser the account's IMAP host and address. Trusted: the registrable domain of the IMAP host or of the address, or an entry of a small table (Gmail, iCloud, Fastmail; ADR 0048) | holds, tested: a header the sender writes gets another id and is ignored, above or below the server's; nothing trusted, `unknown`. **Accepted regression**: a header with no authserv-id (Microsoft's often starts `spf=pass`) is never trusted, so those mailboxes get `unknown`; a provider outside the table and outside the account's domains does too. The corpus cannot show that a forged header with the server's own id wins; a trusted server must strip it (RFC 8601 section 5), and a unit test says so | `auth-forged-dmarc-pass-no-server-header`, `auth-forged-dkim-pass-no-server-header`, `auth-forged-above-real-fail`, `auth-huge-header` |
| The result must be about the From the reader sees (`header.from`) | `readSenderAuth`: a `dmarc=pass` counts only when `header.from` has the registrable domain of the From shown; a pass with no `header.from` is `unknown`; a fail is a fail | holds, tested | `auth-dmarc-for-another-header-from`, `identity-from-space-before-colon`, `identity-from-route-portion` |
| Ignore a lower header from the sender | topmost only | holds, tested | `auth-forged-below-real-fail` |
| Ignore unknown methods, result codes, quoted strings, comments, unclosed comments, headers in the body or folded into another header, empty headers | the tokenizer in `senderAuth.ts` | holds, tested | `auth-unknown-method`, `auth-unknown-result-code`, `auth-quoted-string-pass`, `auth-comment-hides-fail`, `auth-unclosed-comment-swallows`, `auth-in-body-text`, `auth-folded-into-other-header`, `auth-empty-header`, `auth-dmarc-pass-and-fail-same-header`, `auth-uppercase-pass-control` |
| Ignore results inside an attached message | `PostalMimeParser` reads top-level headers only | holds, tested | `auth-inside-attached-rfc822` |
| A pass is not a statement of trust; do not show results without human-factors work | we show no verdict; it only gates images (ADR 0037); a rule covers one registrable domain | holds, tested for lookalike signing and From domains | `auth-lookalike-domain-dkim`, `auth-lookalike-from-domain-real-pass` |
| A message with several From headers must not get a verdict | `onlyFromAddress` | holds, tested for two From headers | `auth-two-from-with-pass` |

### A4. HTML: what a message can run, fetch or do

Sources: EFAIL (Poddebniak et al., USENIX Security 2018), which names the HTML, CSS and image back
channels; the DOMPurify advisories `GHSA-h8r8-wccr-v5f2` (I read it: sanitized HTML reinserted through
`innerHTML` into raw-text wrappers such as `xmp`, `noscript`, `iframe`, `noembed`, `noframes`, `script`)
and CVE-2024-45801 (nesting depth, fixed in 3.1.3, read on NVD); CVE-2023-5631 (Roundcube, SVG, read on
NVD); the Electron security checklist (Part A6).

**How the walls fit together** (ADR 0024): `sanitizeMail` (DOMPurify 3.4.17, `FORBID_TAGS`, a URI allow
list) in the page; a frame sandboxed without `allow-scripts` on `mail.html` or `mail-images.html`; a
page policy that allows inline styles and, for the second page, images only; and main's refusal to let
the frame navigate anywhere but our own pages. The corpus tests them together (every message through the
real reader) and apart (the wall tests put the HTML into the frame without the sanitizer).

**How the sanitized string gets into the frame** (the question the advisory raises): `mailFrame.tsx`
assigns `doc.documentElement.innerHTML = props.html`, a re-parse of DOMPurify's serialisation, in the
context of the `<html>` element and not inside a `script`, `xmp`, `iframe`, `noembed`, `noframes` or
`noscript` wrapper. The attributes that close each of those wrappers are in
`html-mxss-recontext-attributes`; none escaped, and the frame has no scripting for a mutated handler to
use anyway. This is tested in the real browser, not argued.

| Requirement | Source | Where in our code | Status | Cases |
| --- | --- | --- | --- | --- |
| No script runs, however it is written | EFAIL; OWASP XSS prevention (class) | all four walls | holds, tested with the sandbox, the policy and the sanitizer each alone and together | `html-script-tag`, `html-event-handlers`, `html-javascript-uri`, `html-data-uri-documents`, `html-svg-active-content`, `html-mathml-active-content`, `html-parser-quirks`, `html-css-legacy-active`, `mime-qp-hides-tag`, `mime-text-part-holds-html`, `mime-cid-png-that-is-svg`, `html-walls-injected-past-sanitizer` |
| Mutation XSS and nesting | DOMPurify advisories above; Heiderich et al. 2013 (class) | `sanitizeMail`, then the frame | holds, tested | `html-mxss-math-style`, `html-mxss-svg-style`, `html-mxss-noscript`, `html-mxss-form-nesting`, `html-mxss-recontext-attributes`, `html-deep-nesting` |
| With images off, nothing leaves the window: no image, style, font, frame, form, link element, media or beacon | ADR 0024 rule 4; EFAIL | the policy of `mail.html` | holds, tested: the canary saw no request in any blocked-lane case | every `html-*` case, `blockedHits` |
| With images on, only images leave | ADR 0024 rule 4 | the policy of `mail-images.html` | holds, tested through the reader; **gap, low** with the sanitizer bypassed: `<link rel=prefetch>` reaches the canary under that policy (`html-wall-link-relations`; the sanitizer removes `<link>`, so no message can do it today). Tested: CSS `url()` in every property, `@import`, `@font-face`, `image-set()`, escaped URLs, `srcset`, `picture`, `<link>`, frames, forms, media were refused or were image requests | `html-css-url-in-every-property`, `html-css-import`, `html-css-font-face`, `html-css-image-set`, `html-css-escaped-url`, `html-img-remote-spellings`, `html-link-element-resources`, `html-forms-and-inputs`, `html-frames-and-objects`, `html-media-elements`, `html-wall-link-relations`, `html-base-tag`, `html-meta-refresh`, `html-noscript-remote-image`, `html-img-data-svg-and-html`, `html-css-attribute-selector-exfil` |
| The notice that images are off appears when remote content exists | `REMOTE` in `mailHtml.ts` (informs only; the policy is the wall) | **gap, low**, tested: a CSS-escaped `url()` is not seen by `REMOTE`, so no notice shows; nothing leaks | `html-css-escaped-url` |
| Declared tracking pixels are removed even when images are allowed | ADR 0037 rule 7 | `dropPixels` hook | holds, tested for five spellings | `html-tracking-pixel-declared` |
| Tracking pixels that declare no size or hide themselves | ADR 0037 consequences | none | **gap, low** (accepted in the ADR): five undeclared pixels all reached the canary with images on | `html-tracking-pixel-undeclared` |
| An HTML part split around an open attribute must not be glued back together | EFAIL, the "split" channel | `postal-mime` joins HTML parts | **gap, low** while nothing is decrypted; load-bearing the day PGP or S/MIME is added. The images lane also showed the canary receiving the middle part | `html-efail-split-parts` |
| A link whose text shows another site asks first | ADR 0024 rule 5 | `misleadingHost` in `links.ts`, `MailFrame` | holds, tested: seven look-alike shapes (userinfo, subdomain, scheme case, Cyrillic, query) warn; so do link text split by a zero-width character or another invisible one (removed before the comparison), and text drawn by CSS `::before` or `::after` (read from the computed style, only when a `<style>` names a pseudo-element, at most 4 000 reads per measurement) | `html-link-text-shows-other-site`, `html-link-text-hidden-characters`, `html-link-text-from-css-content`, `html-link-text-from-css-escaped`, `html-link-text-bidi-override` |
| Only web and mail addresses leave the app | ADR 0024 rule 5; Electron checklist item 15 | `isOpenable` and main's `matters:open-link` | holds, tested: file, UNC, moniker (`file:///\\host\share\x!y`), `smb`, `ms-msdt`, `search-ms`, `ssh`, `tel` and the rest never reach `openExternal`; the sanitizer also removes them | `html-link-unc-and-moniker`, `html-link-other-schemes`, `html-anchor-attributes`, `html-javascript-uri` |
| A `mailto:` handed to the system must not carry what a mail client may act on (`attach`, `bcc`) | "Mailto: Me Your Secrets" (Müller et al., 2020; summarised by the brief, not re-read here); RFC 6068 section 4 (only subject, keywords and body are believed safe) and 7 | main's `matters:open-link` rebuilds a mailto with `safeMailto` (`apps/desktop/src/main/mailto.ts`): the address list, `subject` and `body` only, any spelling of the names | holds, tested: `mailto:x@example.org?attach=/etc/hosts&bcc=...` reaches `shell.openExternal` as `mailto:x@example.org`, and the corpus run logs the rebuilt value. Unit tests cover `%61ttach`, `ATTACH`, several addresses, a fragment and malformed input. A link that asked for `cc`, `bcc` or `to` opens without them | `html-link-mailto-parameters` |
| Huge and deeply nested markup does not freeze the window | ADR 0012 | sanitizer in the page | holds, tested at 1.5 MB | `html-huge-markup-1500k`, `html-deep-nesting` |
| The sender's HTML sits in a frame that cannot navigate | Electron checklist 13 | `lockDown`, `isOwnPage` in `apps/desktop/src/main/index.ts` | partly, tested with the page itself sending the frame away: a web address is refused; **gap, low**: `isOwnPage` returns true for any `file:` URL, so the frame may be sent to `file:///etc/hosts`. Chromium also refuses a `<meta refresh>` in a frame without `allow-scripts`, which is the wall that normally stops this | `html-wall-parent-navigates-frame-web`, `html-wall-parent-navigates-frame-file`, `html-wall-meta-refresh-web`, `html-wall-meta-refresh-file` |
| The instruments see what they should | ADR 0047 | `tools/smoke-security.ts` | the control case: one image seen by the canary and by main's request spy, one link seen by the openExternal spy, the page's own navigation seen | `html-control-instrumentation` |

### A5. MIME, files and sending

| Requirement | Source | Where in our code | Status | Cases |
| --- | --- | --- | --- | --- |
| One malformed message must not stop an account | robustness (CWE-400, 703) | `PostalMimeParser.parse` never throws because of the message; `buildDocument` in `packages/adapter-imap/src/sync.ts` fills sender and subject from the ENVELOPE | holds, tested through the real IMAP sync into a real database, and against Dovecot: the message is stored once with a notice as its body, and the account goes on syncing | `mime-many-headers-50k` |
| Bounded work for large or deep input | RFC 5322 section 2.1.1; RFC 2046 section 5.1 | `postal-mime` | holds, tested for a 1 MB header, an 8 MB body, 150 nested multiparts, 40 nested `message/rfc822`, 3 000 encoded words | `mime-huge-header-1mb`, `mime-compressible-body-8mb`, `mime-multipart-nested-150-deep`, `mime-rfc822-nested-40-deep`, `mime-subject-very-long-encoded` |
| Bound what one message adds to the database | ADR 0009 | none | **gap, low**: 5 000 attachment rows, 5 000 References ids, a 140 000 character subject, control characters in a Message-ID are all stored | `mime-many-parts-5k`, `mime-references-flood`, `mime-subject-very-long-encoded`, `mime-message-id-odd` |
| A future Date must not pin a message to the top | RFC 5322 section 3.3 | sync takes the ENVELOPE date and then the header date, unclamped | **gap, low** | `mime-date-far-future`, `mime-date-garbage` |
| Preamble and epilogue are not part of the message; boundaries and charsets cannot change what is text | RFC 2046 section 5.1.1; Composition Kills section 6.1 (A16) | `postal-mime` | holds, tested | `mime-boundary-epilogue-text`, `mime-boundary-preamble-text`, `mime-boundary-reused-in-nested`, `mime-boundary-never-closed`, `mime-boundary-with-spaces-and-quotes`, `mime-charset-conflict-latin2`, `mime-charset-utf7-markup`, `mime-base64-declared-plain-body`, `mime-alternative-text-html-disagree` |
| `cid:` embeds only images | RFC 2392 | `embedInlineImages` | holds, tested | `mime-cid-to-html-part`, `mime-cid-png-that-is-svg` |
| An inline part may hide only what the HTML shows | ADR 0043 rule 1 | `inline` is `related && Content-ID` | **gap, low**: an executable in `multipart/related` with a Content-ID nobody references is not listed | `mime-inline-part-hides-executable` |
| File names are never trusted: separators, controls, bidi, trailing dots and spaces, device names, length, RFC 2231 and 2047 forms, NUL | ADR 0043 rules 5 and 12; CVE-2025-66548 (RTLO in a file extension, Nextcloud Deck, read on NVD); Microsoft Naming Files | `safeFileName` in `packages/core/src/domain/fileName.ts` | holds, tested, and Save all was run over real files | the `attachments-*` cases other than the three below |
| A name safe on every platform | `safeFileName`'s own doc | the function keeps `< > : " | ? *` | **gap, low** (macOS today): Windows refuses most of these and `:` names an alternate data stream | `attachments-windows-forbidden-characters`, `attachments-windows-ads` |
| Open is refused for what runs | ADR 0043 rule 12 | `isRunnableFile` | partly, tested for 24 kinds and for the last extension winning; **gap, low**: it is a deny list and misses `.dll`, `.settingcontent-ms`, `.library-ms`, `.diagcab`, `.msha`, `.vhd(x)`, `.one`, `.application`, `.pyw`, `.xbap`, `.iqy`, `.slk`, `.ps1xml`, `.psd1` | `attachments-runnable-types`, `attachments-runnable-types-not-listed`, `attachments-double-extension`, `attachments-exe-then-pdf` |
| Save all never overwrites and never leaves the folder | ADR 0043 rule 8 | `ReceivedFiles.saveAll` | holds, tested with collisions, case variants and names that clean to the same name | `attachments-save-all-collisions` |
| Header injection through subject, names, addresses and file names | CWE-93; Mailsploit | nodemailer, behind the draft check | holds, tested through the real send path into a real SMTP server | `compose-subject-crlf-injection`, `compose-display-name-crlf-injection`, `compose-address-crlf-injection`, `compose-attachment-name-injection`, `compose-reply-subject-from-hostile` |
| Bcc is never in the message | RFC 5322 section 3.6.3; ADR 0020 | `NodemailerComposer` | holds, tested: the hidden address was in the envelope and nowhere in the bytes | `compose-bcc-never-in-bytes` |
| Text from a received message is not read as Markdown when it is copied into mail the user sends | ADR 0045 rule 5 | `escapeMarkdown` (`markdownEscape.ts`) is used for the header of a forward and for a reply's attribution line | partly. A sender named `[Click here](https://...)` no longer becomes a link in the attribution line (tested through the real send path); ordinary punctuation shows no backslash in the text part, but a name with `[`, `*`, `<`, `@`, `://` or a word-edge underscore does (the text part is the Markdown source). **gap, low**: a received body's Markdown link survives quoting. The forward header does escape (control case, holds) | `compose-reply-attribution-name-markdown`, `compose-reply-quoted-body-markdown`, `compose-forward-header-escaped` |
| Raw HTML and unsafe schemes in the user's own Markdown | ADR 0020 rule 11 | `html: false`, `validateLink` | holds, tested | `compose-markdown-raw-html` |
| The sender is the account | Composition Kills section 6.2 (A17) | `composeInput` uses `draft.from` | **gap, low**: the draft's From is sent as given; only the submission server can refuse | `compose-from-address-not-the-account` |

### A6. The Electron checklist

`https://www.electronjs.org/docs/latest/tutorial/security`, 20 items. All are **read** in code, apart
from what the browser tier tests.

| Item | Status |
| --- | --- |
| 1 only load secure content | holds: the app loads its own files; mail content is a frame on our own page (tested: no remote content with images off) |
| 2 no Node integration for remote content | holds: `nodeIntegration: false` |
| 3 context isolation | holds: `contextIsolation: true` |
| 4 sandbox | holds: `sandbox: true` |
| 5 permission requests | holds: `setPermissionRequestHandler` denies every request |
| 6 `webSecurity` | holds: `true` |
| 7 CSP | holds: `index.html` ships a strict policy (relaxed only for the dev server); the mail pages ship their own (tested) |
| 8 `allowRunningInsecureContent`, 9 experimental features, 10 `enableBlinkFeatures` | holds: none are set |
| 11, 12 WebViews | n/a: none are used |
| 13 limit navigation | partly: `will-navigate` is prevented; `will-frame-navigate` allows our pages, and `isOwnPage` allows any `file:` URL (gap, low, tested above) |
| 14 new windows | holds: `setWindowOpenHandler` denies |
| 15 `shell.openExternal` | holds: only `http`, `https` and `mailto` pass (tested); a `mailto` is rebuilt without any field but `subject` and `body` (tested) |
| 16 current Electron | holds: pinned at 45.2.1 in `package.json` (whether it is the newest was not checked) |
| 17 validate IPC senders | partly: every handler compares `event.sender` with the window's `webContents`; none checks `senderFrame` (the message frame cannot send: it has no scripts) |
| 18 avoid `file://` | gap, accepted: ADR 0046 kept it; `isOwnPage` accepts any `file:` URL |
| 19 fuses | partly: a release build turns off `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` ([ADR 0123](../adr/0123-releases.md); read back with `electron-fuses read` on an ad-hoc build). The app is not an asar, so the two asar fuses stay off. The local bundle of ADR 0107 and the Electron binary the tooling runs keep `runAsNode` on (the test commands use it) |
| 20 do not expose Electron APIs | holds: the preload exposes nothing through `contextBridge`; it forwards named messages from `window.postMessage` after an `event.source` check |

### A7. Mail read by a model

Mail is hostile input to a model ([ADR 0051](../adr/0051-agents-on-the-users-own-plans.md) rule 9,
[ADR 0116](../adr/0116-a-prompt-is-a-filter.md)). The wall is the code around the model, not the model:
what it is told, what of the mail reaches it, and what is believed of its answer. The cases are
`agent-*`, run through the real parser, the same selection of text the service uses
(`textForPrompt`), and the verdict turn of a prompt, which also runs the runtime's own test:
`buildPromptRequest` and `acceptVerdicts` (`packages/core/src/usecases/promptFilter.ts`). No model is
involved, so each case says what the code does with an answer that obeyed the message. Until
[ADR 0117](../adr/0117-matters-is-a-view-with-a-prompt.md) the cases ran through the reading of the
built-in `Matters` list, which is removed. Sources: indirect prompt injection and
hidden text are *classes* known from write-ups, not re-read for this page.

| Requirement | Source | Where in our code | Status | Cases |
| --- | --- | --- | --- | --- |
| Mail is data: the instructions are fixed text and the mail goes only in the data block | ADR 0051 rule 3 and 9; ADR 0116 rule 9 | `PROMPT_INSTRUCTIONS`, `buildPromptRequest` (`packages/core/src/usecases/promptFilter.ts`), the thread rendered by `renderThread` (`packages/core/src/usecases/agentRequests.ts`) | holds, tested: instructions in the body, the subject and the display name never reach the instructions or the schema | `agent-injection-in-body`, `agent-injection-in-subject`, `agent-injection-in-display-name` |
| A message cannot pretend to be two: `[Message n]` markers are the prompt's own | ADR 0051 rule 9 | `clean` escapes a marker at the start of a line, behind white space or format characters; a subject and a name are one line | holds, tested. The parser already flattens a decoded Subject and display name; the prompt does not rely on it (unit test `a subject and a name are one line each`) | `agent-spoofed-message-markers`, `agent-injection-in-subject`, `agent-injection-in-display-name` |
| A quote counts only if it occurs in the message it names | ADR 0051 rule 9; ADR 0116 rule 6 | `acceptVerdicts`: a fit above 0 whose quote is not found in the message it names is kept as 0, without the quote | holds, tested: invented words, a real quote under a message number that does not exist, two passages joined, and (control) a quote that differs only in white space is kept | `agent-fake-quoted-fact`, `agent-injection-in-body`, `agent-spoofed-message-markers`, `agent-injection-in-subject`, `agent-injection-in-display-name` |
| A fact about who promised cannot be forged by the sender | ADR 0052 rule 5 | none since ADR 0117: no turn that ships says who promised what, so there is no such fact to forge | **not applicable**: the case's check `forgedOwnPromiseAccepted` was removed with the reading of ADR 0052. A message can still make itself fit a prompt by its words, and so show in that view; ADR 0116 accepts that, bounded by the quote check | — |
| Text the person cannot see does not reach the model | ADR 0052 rule 8 | `visibleText` (`packages/adapter-mime/src/htmlToText.ts`) through `textForPrompt`; for a message with HTML the model gets what the page would show | holds, tested for `display:none`, `font-size:0`, `visibility:hidden`, a zero-size clipping box, the `hidden` attribute, `mso-hide`, and the same by single-class selectors in the message's own style block, with CSS escapes, comments and entities in the style. Not looked at: colour against background, selectors the walk cannot match without a tree (pseudo-classes, attribute tests), media queries other than a plain `@media screen`. | `agent-hidden-html-text` |
| The stored text is a different thing from the prompt text | ADR 0052 rule 4 | `htmlToText` keeps every word, for search and the snippet | **gap, low**: the stored text of an HTML-only message holds the words the page hides. The prompt does not use it when the message has HTML, which also covers mail stored before this was done | `agent-hidden-html-text` |
| Invisible characters do not carry text | class: ASCII smuggling | `clean` and `normalizeForQuote` remove zero-width, bidi, soft hyphen and tag characters | holds, tested | `agent-invisible-tag-characters` |

## Part B. What a server does, and a client only consumes

| Matter | Standard | Our position |
| --- | --- | --- |
| SPF, DKIM, DMARC evaluation | RFC 7208, RFC 6376, RFC 9989 (DMARCbis, May 2026, obsoletes RFC 7489 and 9091) | the receiving server evaluates and writes `Authentication-Results`; we read it (A3). We do not verify DKIM ourselves (ADR 0037: a DNS query per message). |
| Reporting results to the reader | RFC 8601 section 4.1 | we show no verdict; it gates remote images |
| Transport security between servers | MTA-STS (RFC 8461), DANE for SMTP (RFC 7672), TLS-RPT (RFC 8460) | not ours; a mail provider's job |
| Submission server checks the sender | RFC 6409 | not ours, but see `compose-from-address-not-the-account` |
| Trustworthy email in general | NIST SP 800-177 Rev. 1 | background; not mapped clause by clause (I did not read it for this page) |

## Part C. Out of scope for now

| What | Why |
| --- | --- |
| PGP and S/MIME | not implemented. EFAIL's main channels need decryption; `html-efail-split-parts` is the case that becomes load-bearing the day it is added. |
| OAuth sign-in | the app accepts password sign-in only (`NodemailerSubmit.verify` says so). `StoredAccount` already allows `oauth2`; when it is built it needs RFC 8252 and PKCE cases. |
| One-click unsubscribe | RFC 8058: nothing in the client acts on `List-Unsubscribe`. |
| Calendar invitations, Quick Look previews of received files | previews run nothing by design (ADR 0043); not corpus-tested. |
| IMAP server hostility beyond TLS | a hostile server that sends malformed responses over a valid TLS session is not in the corpus. |
| Windows and Linux builds | the file-name rows marked "macOS today" become medium on a Windows build. |

## Sources

Read in their primary text for this page: RFC 8314 (https://www.rfc-editor.org/rfc/rfc8314), RFC 8601
(https://www.rfc-editor.org/rfc/rfc8601), RFC 6068 (https://www.rfc-editor.org/rfc/rfc6068), RFC 9989
(https://www.rfc-editor.org/rfc/rfc9989), the Electron security checklist
(https://www.electronjs.org/docs/latest/tutorial/security), "Composition Kills" (Chen, Paxson, Jiang,
USENIX Security 2020, https://www.usenix.org/system/files/sec20-chen-jianjun.pdf, sections 5 and 6),
GHSA-h8r8-wccr-v5f2 (https://github.com/advisories/GHSA-h8r8-wccr-v5f2) and the NVD entries for
CVE-2024-45801, CVE-2023-5631, CVE-2025-66548, CVE-2025-61084, CVE-2024-21413 and CVE-2023-23397 (the last
two have a title only on NVD; the moniker and UNC techniques are used as classes).

Cited from the brief or from public knowledge and not re-read here: "Why TLS is better without STARTTLS"
(https://nostarttls.secvuln.info/), EFAIL (https://efail.de/), "Mailto: Me Your Secrets" (2020), Mailsploit
(2017), UTS #39 (https://www.unicode.org/reports/tr39/), UAX #9, NIST SP 800-177 Rev. 1
(https://csrc.nist.gov/pubs/sp/800/177/r1/final), RFC 6376, RFC 6186, RFC 2231, RFC 2047, RFC 5322,
RFC 7817, RFC 8058.

## What was weakened to prove the corpus can fail

Each defence was weakened on its own, the tier was run, the cases that went red were noted, and the
file was put back (`git diff` of every mutated file was empty afterwards). Nothing below is committed.

| Weakened | Where | Tier | Cases that went red |
| --- | --- | --- | --- |
| `FORBID_TAGS` emptied | `apps/desktop/src/renderer/mailHtml.ts` | browser | 12 cases, all through `forbiddenElementsInFrame` (forms, SVG, MathML, media, base left in the frame): `html-event-handlers`, `html-svg-active-content`, `html-mathml-active-content`, `html-mxss-math-style`, `html-mxss-svg-style`, `html-mxss-form-nesting`, `html-forms-and-inputs`, `html-base-tag`, `html-img-remote-spellings`, `html-parser-quirks`, `html-media-elements`, `html-walls-injected-past-sanitizer`. **No request or script changed**: the first run, before that check existed, stayed green. The other walls hold on their own, which is what "three walls" means; the check makes the sanitizer's own work visible. |
| The DOMPurify step removed (`clean = html`) | same file | browser | 24 cases: `forbiddenElementsInFrame` on 22 of them, `html-tracking-pixel-declared` (declared pixels reached the canary, 5 requests), `html-link-unc-and-moniker` (5 file, UNC and `smb:` links stayed in the frame), `html-link-element-resources` (a non-image request reached the canary with images allowed). No script ran: the sandbox and the policy stopped them. |
| `mail.html` policy relaxed to allow remote images | `apps/desktop/src/renderer/mail.html` | browser | 10 cases, all `blockedHits`: `html-css-url-in-every-property`, `html-css-image-set`, `html-css-escaped-url`, `html-css-attribute-selector-exfil`, `html-img-remote-spellings`, `html-tracking-pixel-undeclared`, `html-efail-split-parts`, `html-walls-injected-past-sanitizer`, `html-control-instrumentation`, `mime-text-part-holds-html` |
| The frame's `sandbox` removed | `MAIL_FRAME_SANDBOX` in `apps/desktop/src/renderer/mailFrame.tsx` (the wall tests use the same constant) | browser | `html-wall-meta-refresh-file`: Chromium then follows the refresh and main lets `file:///etc/hosts` through. Scripts stayed blocked by the policy and a web address by main: the sandbox's own job is the refresh. |
| `\p{Cf}` taken out of what `safeFileName` removes (bidi and format characters) | `packages/core/src/domain/fileName.ts` | node | `attachments-rtlo-extension` and `attachments-rtlo-raw-utf8`, on `attachmentNames` and `attachmentNamesPortable` |
| `readSenderAuth` ignores `fail` | `packages/adapter-mime/src/senderAuth.ts` | node | `auth-forged-below-real-fail`, `auth-dmarc-pass-and-fail-same-header`, `auth-comment-hides-fail` |
| Certificate validation off, IMAP (`tls: { rejectUnauthorized: false }`) | `packages/adapter-imap/src/connection.ts` | transport | `transport-tls-self-signed`, `-wrong-hostname`, `-expired`, `-unknown-ca` (the IMAP keys of `connected` and `passwordSeenOverTls`) and `transport-no-certificate-click-through` |
| Certificate validation off, SMTP | `packages/adapter-smtp/src/submit.ts` | transport | the same cases, on the SMTP keys |
| STARTTLS no longer required (`doSTARTTLS: undefined`) | `packages/adapter-imap/src/connection.ts` | transport | `transport-starttls-stripped`, `transport-starttls-refused`, `transport-login-after-probe-claiming-starttls`: the password was seen in plaintext |
| Markdown `html: true` | `packages/adapter-compose/src/render.ts` | compose | `compose-markdown-raw-html` |
| `firstTrustedHeader` trusts every id (ADR 0048) | `packages/adapter-mime/src/senderAuth.ts` | node | `auth-forged-dmarc-pass-no-server-header` (`senderAuth` and `imagesShownWithDomainRule`), `auth-forged-dkim-pass-no-server-header`, `auth-forged-above-real-fail`, `auth-huge-header` |
| `header.from` no longer compared with the From shown | same file | node | `auth-dmarc-for-another-header-from`, `identity-from-space-before-colon`, `identity-from-route-portion`. Counting a `dmarc=pass` with no `header.from` stayed green in the corpus; only a unit test (`senderAuth.test.ts`) catches it |
| The address check in `displayName` off | `apps/desktop/src/renderer/format.ts` | node, browser | node: `identity-display-name-looks-like-address`, `identity-from-address-then-address` (`labelShowsAddress`); browser: `identity-display-name-looks-like-address` (`senderText`) |
| `displayName` keeps bidirectional controls | same file | node | `identity-bidi-display-name` (`labelClean`) |
| "You" for any message from the reader's address (`isReallyOwn` ignored) | same file | browser | `identity-own-address-spoof` (`senderText`), and `format.test.ts` |
| Pseudo-element filter misses an escaped selector | `apps/desktop/src/renderer/mailFrame.tsx` | browser | `html-link-text-from-css-escaped` (`linkWarningCount` and `opened`) |
| `misleadingHost` does not remove invisible characters | `apps/desktop/src/renderer/links.ts` | browser | `html-link-text-hidden-characters` (`linkWarningCount` and `opened`) |
| Text drawn by CSS not read | `apps/desktop/src/renderer/mailFrame.tsx` | browser | `html-link-text-from-css-content` (`linkWarningCount` and `opened`) |
| `mailto:` handed to the system unchanged | `apps/desktop/src/main/mailto.ts` (`linkForSystem`) | browser | `html-link-mailto-parameters` (`openedMailtoWithAttach`) |
| `attribution` does not escape the name | `packages/core/src/domain/reply.ts` | compose | `compose-reply-attribution-name-markdown` |
| `clean` does not escape `[Message n]` at the start of a line | `packages/core/src/usecases/agentRequests.ts` | node | `agent-spoofed-message-markers` (`promptMessageMarkers`) |
| `clean` and `normalizeForQuote` keep invisible characters | same file | node | `agent-invisible-tag-characters` (`invisibleCharsInPrompt`), `agent-spoofed-message-markers` (`promptMessageMarkers`: a marker behind a zero-width space) |
| A quote need not occur in the message | `packages/core/src/usecases/promptFilter.ts` (`acceptVerdicts`; before ADR 0117, `acceptAnalysis`, with the same cases) | node | `agent-fake-quoted-fact` (`fabricatedQuoteAccepted`, `joinedPassagesAccepted`), `agent-injection-in-body` (`fabricatedQuoteAccepted`), `agent-hidden-html-text` (`hiddenQuoteAccepted`) |
| The message number of a verdict is not checked against the thread (the first message stands in) | same file (`acceptVerdicts`; before, `acceptAnalysis`) | node | `agent-fake-quoted-fact` and `agent-spoofed-message-markers` (`quoteOfMissingMessageAccepted`) |
| The prompt text ignores the HTML (`textForPrompt`) | `apps/desktop/src/backend/agentService.ts` | node | `agent-hidden-html-text` (`hiddenTextInPrompt`, `hiddenQuoteAccepted`) |
| `visibleText` keeps hidden words | `packages/adapter-mime/src/htmlToText.ts` | node | `agent-hidden-html-text` (`hiddenTextInPrompt`, `hiddenQuoteAccepted`) |
| The subject keeps its line breaks in the prompt | `packages/core/src/usecases/agentRequests.ts` | unit | `keeps a forged marker in a subject off a line of its own` (the corpus cases stayed green: the parser flattens a decoded Subject first, so the corpus alone does not test this layer) |
| The sender's name keeps its line breaks in the prompt (the white-space collapse and the line flattening both removed) | same file | unit | `keeps a forged marker in a sender name off a line of its own` (the name is flattened twice; removing one of the two changed nothing) |

Not mutated: the transport TLS 1.1 refusal (Node's default minimum; the case proves the server speaks 1.1
before it counts the refusal), the compose header-injection defences (nodemailer's own; they are tested but
there is no line of ours to weaken) and the main-process navigation rule (it is the gap above).
