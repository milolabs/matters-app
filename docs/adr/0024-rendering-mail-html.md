# 0024. Rendering mail: letters, and pages in a sandbox

- Status: Accepted
- Date: 2026-11-04
- Amended by: [0085](0085-mail-in-the-dark-theme.md) (designed mail in the dark theme: the sender's theme first, recolored only as a fallback), [0094](0094-a-message-opens-as-sent.md) (every message with HTML opens as the original)

## Context

Sync stored only plain text, and turned HTML-only mail into it, so newsletters
lost their layout. ADR 0009 expected HTML to be kept. HTML from a stranger is the
largest attack surface of a mail client, and remote images tell senders who read
what, and from where.

## Decision

1. **Keep the HTML part as sent**, in zstd blocks of its own (`html_blocks`), apart
   from text: search and opening a thread never unpack it. Inline `cid:` images up
   to 512 KB are embedded when parsing. Attachments are not stored.
2. **Two views**, chosen when parsing and switchable per message:
   - `simple`, written by a person: our letter, from the text, in both themes.
   - `designed`, laid out by a sender (list headers, or tables and images in the
     markup): the original, on white in both themes, because its colors were chosen
     for white. No color inversion.
3. **Three walls around the original:**
   - DOMPurify in the page, with active and form elements forbidden.
   - An iframe sandboxed without `allow-scripts`, on our own page.
   - A content security policy on that page: inline styles and `data:` images only.
   Main also refuses navigation of the frame to anything but our own pages.
4. **Remote images are off by default**: the policy blocks them, so a style rule cannot
   get around it. The reader allows them per message or per sender, which loads a second
   page whose policy allows images and nothing else. No proxy.
5. **Links leave through main**, which accepts only `http`, `https` and `mailto`. A link
   whose text is an address on another site asks first.
   Without `allow-scripts` no event listener runs in the frame, not even one from our page, so
   the page lays real links exactly over the message's and handles them on its own side.

## Consequences

- The database grows by the compressed HTML, roughly several times the text; to be measured
  on a real mailbox.
- Mail synced before this has no HTML until it is synced again.
- Classification is a heuristic, hence the switch.
- Sanitizing runs on the page's thread when a message opens; watch it against ADR 0012.
