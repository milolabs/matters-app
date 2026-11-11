# 0094. A message opens as sent

- Status: Accepted
- Date: 2026-11-09
- Amends: [0024](0024-rendering-mail-html.md) (which view a message opens in), [0077](0077-showing-what-was-found.md) (which letters have stops)

## Context

ADR 0024 opens a message by its kind: `designed` mail as the original, `simple` mail (HTML written
by a person) as our letter, from the text. In the maintainer's mailbox 177,264 messages are
`designed`, 13,641 are `simple` and about 6,300 have no HTML.

In use the text view of a person's mail read as lost formatting: bold, lists, colors and the
sender's own layout were gone until the reader clicked Original, on every such message. The
classification is a heuristic (0024), so some of those were laid out mail that it missed.

Since ADR 0085 the original is shown in the dark theme too (the sender's theme, or recolored), so
the reason to prefer our letter in both themes is weaker than when 0024 was written.

## Decision

1. **Every message with HTML opens as Original**, whatever its kind. A message without HTML opens
   as text, as before.
2. The Original / Text switch stays on every message with HTML, and the choice still holds only for
   that message while it is open. There is no setting.
3. Following 0077, which does not mark inside the frame, a message with HTML has no stops in the
   walk through matches; switching it to Text marks its words, as for designed mail before.
4. The kind is still parsed and stored: forwarding (its notice for designed mail) and the stored
   data use it.

## Consequences

- A person's mail looks as it was written, with the sender's formatting, without a click.
- Opening a `simple` message now sanitizes and renders its HTML in the frame, as designed mail
  already did: a few milliseconds more on open, to watch against ADR 0012.
- Search marks and the match count in the reader cover fewer letters: only mail without HTML, or a
  message switched to Text.
- Remote images in a person's mail stay blocked by default (0024), so it may show the image notice
  more often.
