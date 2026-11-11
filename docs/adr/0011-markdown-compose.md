# 0011. Compose in Markdown, send as HTML

- Status: Accepted
- Date: 2026-11-03

## Context

Rich-text editors that emit email-safe HTML are a large, fragile area. Gmail
and Outlook strip or ignore `<style>` blocks. Markdown is readable as plain
text.

## Decision

- Editor: CodeMirror 6 with Markdown, plus a **source / preview** toggle.
- Pipeline (behind `ComposeRendererPort`):
  markdown-it (raw HTML disabled) → DOMPurify → juice (inline styles).
- The preview uses exactly the same function as sending.
- Sent as `multipart/alternative`: `text/plain` is the Markdown source,
  `text/html` is the rendered result.
- Replies: the user's Markdown on top; the original message quoted below as
  sanitized HTML in a `<blockquote>`, never converted to Markdown.
- Pasted rich text is converted to Markdown with turndown.
- Inline images are sent as `cid:` attachments. Signatures are Markdown too.

## Consequences

- No WYSIWYG editor to maintain.
- Users who don't know Markdown rely on the preview and toolbar shortcuts.
