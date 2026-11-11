# 0101. A new message reads like a letter

- Status: Accepted
- Date: 2026-11-09

## Context

After ADR 0100 a reply under its thread looked calm, while a new message (and a forward, or a
reply moved to the full composer) still had the old composer: a heavy title row with
Write/Both/Preview and Close, To as a plain line of text with no help, a large Attach button,
the attachments as a strip, and an editor whose lines ran the full width of the pane.

## Decision

1. The full composer is one column of at most 760 px, centred. The top line is quiet: the title in
   small text, Preview (an eye, which shows the message as sent beside the text), back under the
   thread for a reply whose thread is open, and Close (the draft is kept).
2. From shows for a new message or when it can be chosen. To, Cc and Bcc are chips: each finished
   address is a chip with ×, a wrong one is marked in the late colour. Typing asks the index for
   people (`suggestPeople`, ADR 0028): ↑ ↓ pick, ↵ or Tab take one, a comma finishes what was
   typed, ⌫ in an empty field takes the last chip back to edit, Esc closes the suggestions only.
   ↵ makes a chip only of something with an `@`, so a name typed fast waits for its suggestions.
   The field's text is what the draft keeps; nothing about drafts or sending changes.
3. The subject is the letter's heading (New York, 22 px); ↵ in it goes on to the text.
4. The formatting bar (with the agent, ADR 0098) stays at the top while the text scrolls, and the
   text grows with the page instead of scrolling in a box.
5. The files are the header's "📎 N files, X MB" with its popover, as under a thread (ADR 0100);
   the strip and the Attach button are gone. The smoke run counts the files there.

## Consequences

Writing anew looks like writing a reply. Write/Both/Preview become one Preview toggle; the source
view without the live formatting is gone.
