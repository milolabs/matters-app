# 0028. People in suggestions, checked against the index

- Status: Accepted
- Date: 2026-11-04
- Builds on: [0025](0025-query-language-and-plans.md), [0026](0026-query-bar.md)

## Context

The query bar suggests fields, labels and accounts, but after `from:an` the user wants
a person. The search index cannot answer this: `message_fts` is contentless, so it can
say that a word exists but not who it belongs to. Scanning `messages` per keystroke
would break the budget (ADR 0012).

Mail can be removed from under any derived list, including all the mail of a removed
account, and a contentless index cannot say whose words it is dropping.

## Decision

- **Two derived tables.** `people` holds an address with its latest name, a message count
  and the date of the latest message. `people_words` holds each folded word of the name
  and address against that address, for a prefix range read.
- **Written with the documents,** in the same transaction as the index and
  `message_terms` (ADR 0025).
- **A candidate is shown only if the index still has mail for it.** Each candidate is
  checked with an address phrase across sender, recipients and cc, `LIMIT 1`, before it
  is returned. Stale rows therefore never reach the screen, and removing mail needs no
  bookkeeping. Rows are never deleted.
- **Ranking is by message count, then latest date.** The count is a hint: re-indexing a
  message can raise it and removing one does not lower it. Own addresses are left out,
  because `me` covers them. A prefix with up to 2,000 rows is read and ranked exactly. A
  wider one walks `people_rank` in rank order, up to 4,000 people, so a very common prefix
  can miss someone ranked below that.
- **A suggestion inserts the address,** not the name, so it matches that person exactly
  and the query means the same thing later. `from:<address>` when typed in a `from:`,
  `to:` or `cc:` value; a plain word of 2 or more characters gets `from:<address>`.
- **Suggestions never run a query,** and they are requested per keystroke only while the
  panel is open in a context that wants people. The newest answer wins, and a slow one
  never holds up search, since it is a separate request of its own.
- **The reader writes filters too.** A sender offers "only from" and "exclude", a label
  offers filtering by it. They edit the query text like every other control (ADR 0026).

Not in this ADR: ranking by whom the user writes to, contact details, an address book,
suggesting people in the composer.

## Consequences

- Measured on 500k synthetic messages with 48,000 people: a suggestion takes under 1 ms
  (median), and up to 5 ms the first time. A sync batch of 500 messages went from 98 to 114
  ms. The migration read every message's participants in 1.3 s on the first launch after the
  update, at a peak of 360 MiB. The tables took about 15 MiB, not counting `people_rank`.
- Names and addresses of removed mail stay on disk in these tables, as words do in
  `message_terms`. A "forget this account" guarantee has to clear both and rebuild them.
- Newsletters can rank high by count. Ranking by replies needs to know which address is
  the user's at write time, and is left for later.
