# 0074. Finding files by name

- Status: Accepted
- Date: 2026-11-08

## Context

The search panel (⌘K) shows live results while the person types: one list of threads, and now a
short list of Files, the attachments of received mail matched by name. It answers on every
keystroke, so it has to feel instant at the owner's scale: 180k messages today, a budget of 500k,
so up to about 300k stored files (`message_attachments`, ADR 0043).

What people type is part of a name, not its start: `aneks` or `651` for `Aneks_651_2026.pdf`, and
in Polish without the diacritics: `zalacznik` for `Załącznik`. A `LIKE '%x%'` scan reads every row
for every keystroke and is out of the question.

Measured: the SQLite bundled with the Electron that runs the app and the tests (3.53) has FTS5 with
the `trigram` tokenizer and `contentless_delete`.

## Decision

1. **A use case and a port.** `searchFiles({ text, limit, accountId? })` returns `FileHit`s: message
   key and part id (together the id of the file), file name, size, content type, thread, account,
   sender and date. It asks `FilesPort.searchFiles`, which the SQLite search index implements next
   to `PeoplePort`. Blank text or a zero limit returns nothing without asking. The limit is 5 by
   default and at most 50.
2. **Matching.** Both sides are folded the same way (`foldFileName`: `foldText`, one space for any
   run of white space). Three characters or more must appear anywhere in the name. One or two
   characters must start a word of the name (a word is a run of letters and digits, so `65`
   finds `Aneks_651_2026.pdf`); a short text with a separator in it matches nothing. Results are
   the newest message first, files of one message in their order, and one file per thread and
   folded name (the newest). Mail in Trash and Spam is left out, as everywhere else (ADR 0044), and
   so are inline parts, which are stored but not listed.
3. **Index, written by migration 37.** Two tables, both keyed by the message:
   - `file_fts`: FTS5, `tokenize = 'trigram'`, contentless with `contentless_delete = 1`. One row
     per message; the rowid is the message key, the text is its folded file names joined by a
     newline. A query never contains a newline, so a match never straddles two names. Reading by
     `rowid DESC` yields the newest message first and one row at a time, so the search stops as soon
     as it has enough distinct files. Each candidate is then checked against the real name (the
     fold is the same on both sides), which also picks the matching files out of a message that
     holds several.
   - `file_starts (prefix, message_key)`, primary key `(prefix, message_key)`, `WITHOUT ROWID`:
     the first one and two characters of every word of every name. It answers the texts of one or
     two characters, which a trigram index cannot, again newest first.
4. **Kept current.** `setAttachments` is the only code that writes `message_attachments`; it
   rewrites both tables for the message in the same transaction. A trigger on `messages` deletes
   both when a message goes (a removal on the server, a removed account). The migration fills both
   from the stored rows in one pass in key order, inside the migration's own transaction.
5. **Limits.** A search looks at no more than 2,000 messages to fill its limit; a name that the
   mailbox repeats in thousands of messages of one thread can leave the list shorter than asked
   rather than slow. The text is at most 200 characters. The renderer reaches this as the request
   `searchFiles`, answered from the read connection like `suggestPeople`.

## Consequences

- Measured on this machine with 100k files over 60k messages (`fileSearchPerf.test.ts`, budget p95
  under 15 ms): p95 0.2 ms, the backfill 0.8 s for the 100k rows, so about 2.5 s for 300k.
- The trigram index adds a few bytes per character of every name, small next to the message index
  (about 25 characters per file); `file_starts` adds a handful of short rows per message.
- A one- or two-character text finds word starts only; the third character widens it to anywhere in
  the name. That is the price of no scan, and it is what a person expects of a first letter.
- Not covered: the contents of attachments (text inside a PDF or a spreadsheet) and the content
  type or size as criteria. Files attached to drafts that are not sent yet (`attachments`, ADR 0040) are not
  indexed either; only parts of stored messages are. Searching inside files would need the bytes downloaded
  and read first, which is a separate decision.
- Anything that ever writes `message_attachments` by another path must call the index writer
  (`fileIndexWriter`), or the file will not be found until its message is answered again.
