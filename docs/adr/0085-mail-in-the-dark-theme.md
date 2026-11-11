# 0085. Mail in the dark theme: the sender's theme first, recolored only as a fallback

- Status: Accepted
- Date: 2026-11-09
- Amends: [0024](0024-rendering-mail-html.md) (designed mail "on white in both themes, no color inversion")

## Context

ADR 0024 shows designed mail on white in both themes, because its colors were chosen for white. In
the dark theme that is a white page in a dark app, for every newsletter.

Measured in Electron 45: a same-origin frame's `prefers-color-scheme` follows the `color-scheme` of
its `<iframe>` element in our page, not the frame's own `<meta>`. The app's root is
`color-scheme: light dark`, so in dark the senders' own dark rules already applied, under our fixed
white ground and dark ink: mail that has a dark variant came out half dark.

Many senders do write a dark variant (`@media (prefers-color-scheme: dark)`, `color-scheme`), and
some ask to stay light (`color-scheme: only light`). Most say nothing.

## Decision

1. **The sender's theme first.** `mailTheme` (renderer `mailTheme.ts`) reads what a message says:
   - `dark`: a dark media query, or `dark` in a `color-scheme` property or in a `color-scheme` /
     `supported-color-schemes` meta. Meta tags are read from the message as sent, because the
     sanitizer drops them. CSS is read only from `<style>` and `style`, never from the message's text.
   - `light-only`: `only light` and no `dark`.
   - `none`: nothing.
2. **The frame's scheme is set from our side.** `MailFrame` sets `color-scheme` on its `<iframe>`:
   - in light, every message is shown as sent, in light;
   - in dark, a `dark` message gets `dark`, so its own rules apply, on the app's ground (`#1e1e20`) and
     ink, which the base style now has for dark;
   - a `light-only` message stays light, on white, even in dark.
3. **Recoloring is the fallback, for `none` in dark only.** `darkenMail` rewrites the sanitized markup
   as text: `<style>` sheets, `style` attributes, and `bgcolor` / `color` / `text` / `link`
   attributes. It does no layout and computes no styles. In OKLCH:
   - grounds (backgrounds, borders) lighter than L 0.6 become dark, and white lands on the app's ground;
   - ink darker than L 0.6 becomes light, and black lands on about `#e8e8e8`;
   - hue is kept and chroma is clipped to sRGB, so a brand stays recognisable;
   - colors already right for dark stay, and so do images, `url(…)` and the message's text.

   It runs once per message and theme, only when shown in dark.

## Consequences

- Senders who wrote a dark variant get it, as other clients that respect `color-scheme` show it.
- Recoloring is text-level. Colors that come from things it does not read are not changed: classes
  set by a sheet it could not parse, images of text, and transparent logos drawn in black. Such
  logos can vanish on dark.
- A dark element inside a light card (`#222` in `#f4f4f4`) can end up as dark as the recolored card
  around it.
- To measure on a snapshot of the real mailbox: how many messages are `dark`, `light-only` and
  `none`, and how many recolored ones still show large light areas or low contrast. That decides
  whether a second pass over computed styles is worth its cost.
- Not here yet: a per-message "show original" switch, remembered per sender.
