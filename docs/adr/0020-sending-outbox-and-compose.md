# 0020. Sending: drafts, approval, outbox and compose

- Status: Accepted
- Date: 2026-11-03
- Refines: [0007](0007-local-first-sync.md) rule 5, [0011](0011-markdown-compose.md)

## Context

The Swift prototype defined the product's send rules: a draft has a version
and a SHA-256 fingerprint; an approval binds to (draft, version, fingerprint,
context); any change voids it; a 10-second undo window precedes the hand-off;
a send whose outcome is unknown must be reconciled against Sent before any
retry. Its app layer faked the actual send, so those guarantees were never
exercised end to end, and a review found gaps: a second Send silently
cancelled a pending one, pending sends were lost on quit, `⌘↵`/`⌘Z` had
conflicting bindings, a failed encoding hashed to a constant fingerprint, and
the "new message in the thread voids approval" rule was never wired.

## Decision

### Drafts and approval (core domain)

1. A **draft** (account, from, to, cc, bcc, subject, Markdown body, reply
   headers) is persisted locally. Its `version` increases only when content
   really changes; its `fingerprint` is SHA-256 over a canonical encoding.
   Encoding failure is an error, never a constant hash.
2. An **approval** = (draftId, version, fingerprint, threadContext, approvedAt),
   where threadContext is the newest message key of the thread when approved.
   It is checked when Send is pressed **and again** at hand-off. Different
   draft, changed draft, or a newer message in the thread → nothing is sent and
   the user sees why.
3. Send is blocked while recipients are empty or `[placeholder]` gaps remain in
   the subject or body.

### Outbox and send states

4. Pressing Send stores an outbox operation immediately with
   `notBefore = now + 10 s`: the undo window survives a crash or quit.
   Several sends may be pending at once, each with its own undo.
5. If the app was closed when a window expired, the send is **held** at next
   start ("Not sent yet — Send now / Discard"); mail never leaves by surprise
   hours later.
6. The raw MIME message, with a `Message-ID` we generate, is built once at
   hand-off and stored with the operation; every attempt sends identical bytes.
7. States: `pending` (undo window) → `running` → `succeeded` | `failed`
   (definite rejection, e.g. SMTP 5xx or refused before DATA) | `unknown`
   (connection lost or timeout after DATA). Retry is possible only from
   `failed`.
8. **`unknown` is reconciled, never retried blindly**:
   - Gmail saves sent mail itself: search for the `Message-ID`
     (`X-GM-RAW rfc822msgid:`); found → `succeeded`; not found after a grace
     period → `failed` (retryable).
   - Other servers only have a Sent copy if we append it after success, so a
     missing copy proves nothing: the operation stays `unknown` and the user
     chooses "Send again" or "Mark as sent".

### Transport and Sent copy

9. `MailSubmitPort` (adapter-smtp, nodemailer) sends over TLS or STARTTLS
   with the account's credential, running in the sync worker (ADR 0019).
   Errors are typed (definite vs unknown) and never contain the password.
10. After success, non-Gmail accounts `APPEND` the message to the Sent folder
    (SPECIAL-USE); an append failure is reported but does not make the send
    fail. The sent message appears in its thread immediately and is matched by
    provider id when sync brings the server copy (ADR 0016).

### Compose pipeline (refines ADR 0011)

11. Markdown → markdown-it with raw HTML **disabled** and safe link schemes
    only → juice (inline styles) → HTML. Because no user HTML can enter, our
    own output needs no DOMPurify pass; DOMPurify stays reserved for rendering
    **incoming** HTML mail.
12. `multipart/alternative`: `text/plain` is the Markdown source, `text/html`
    the rendered result. Preview calls the exact same backend function and is
    shown in a sandboxed iframe.
13. Replies set `In-Reply-To` and `References`, prefix the subject with one
    `Re:`, and quote the original below (plain `> ` lines in text, a
    `<blockquote>` in HTML). Reply-all excludes the user's own addresses.

### Keyboard

14. `c` new message, `r` reply, `a` reply all, `⌘↵` send (bound only inside the
    composer), `⌘Z` undoes the most recent pending send unless focus is in a
    text field (then it is text undo), `⌘I` shows draft details (version,
    thread, approval state).

Attachments in compose come in a later step.

## Consequences

- The prototype's guarantees become real and tested end to end against a test
  SMTP server and our Dovecot.
- Users of non-Gmail accounts may occasionally be asked to resolve an
  `unknown` send; this is the honest outcome, not a silent duplicate.
