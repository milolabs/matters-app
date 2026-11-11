# 0100. A reply is written under its thread

- Status: Accepted
- Date: 2026-11-09

## Context

Replying covered the thread with a full composer: a title bar, Write/Both/Preview, From, To,
Subject, the editor with the raw quote of the answered message, and the footer. The user found
writing tiresome and the Markdown source unprofessional, and asked for a basic rich editor. The
draft, its fingerprint and approval, the gaps check and the send all read Markdown, so
changing the format would touch all of them.

## Decision

1. A reply (and reply all) opens under its thread, in place of the "Reply to…" line, in one bordered
   box: the one place to type is the one framed object in the pane. A new message, a forward, a reply
   opened from Matters or while another thread is open use the full composer as before.
2. The box: "To" and the names on one quiet line, the files beside them, ⤢ to move the same draft
   into the full composer (Cc, subject, preview). Leaving the thread closes the reply, which keeps
   the draft, as Close does.
3. The text stays Markdown but is shown live: bold reads bold, italics, strikethrough, links, lists
   and headings look formatted and their syntax fades. A formatting bar (bold, italic, strikethrough,
   bullets, numbers, quote, link, clear) writes the syntax. The full composer gets the same bar.
   No parser package: the visible lines are read with a few patterns.
4. The quote of the answered message folds to "···" and opens on a click. It is still in the
   draft and is sent as before.
5. A placeholder such as `[kwota]` is marked in the text as the send check sees it (ADR 0096).
6. The files are a quiet "📎 N files, X MB" beside "To"; it opens a popover with each file (the
   chips of ADR 0041, with their states), Add files… and Remove all. No number of files moves the
   text. With no files it is a paperclip. Dropping files anywhere on the box attaches them; the
   drop hint covers the box and says how many.
7. What blocks Send is quiet until Send is pressed (ADR 0096).

## Consequences

Replying no longer hides what is being answered. The full composer stays for everything else.
The live view is a reading of the text, not a second format, so nothing about drafts, approval or
sending changes. The agent's help in the box is ADR 0098.
