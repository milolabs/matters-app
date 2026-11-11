# 0025. A query language, and query plans chosen per query

- Status: Accepted
- Date: 2026-11-04
- Amends: [0006](0006-sqlite-storage-and-search.md) (operator words, UTC days)

## Context

Search is a flat list of ANDed `field:value` terms. It has no `OR`, negation or
groups, and flags, accounts and `cc` cannot be searched although the data is
stored. Saved views need a language that can express them, and later features
(rules, notifications, an agent's search tool) would reuse it.

Search runs on every keystroke (ADR 0012), so every prefix of a query must be a
valid query. That rules out the shape of JQL: mandatory `AND`, `=` operators, and
errors that block results. `ORDER BY` is ruled out too, because "newest N" is
cheap only along the chronological key.

Measured in Electron 45 on 500k synthetic messages (in-memory database, SQL only,
median of 5-7 runs). The budget for a whole keystroke is 16 ms:

| Query | Plan | Time |
|---|---|---|
| `label:rare` | scan with `EXISTS` (before this ADR) | 154 ms |
| `label:rare` | index `(label_fold, message_key)` | 0.01 ms |
| `common label:rare` | join and `EXISTS` (before this ADR) | 134 ms |
| `common` in a narrow old date range | filter on `date_ms` (before this ADR) | 38.8 ms |
| `common` in a narrow old date range | range on the key | 8.1 ms |
| `is:starred` | scan / partial index | 10.3 / <0.01 ms |
| `a OR b`, `a -b` | inside `MATCH` | 0.06-0.5 ms |
| `-common` alone | `NOT IN` | 20 ms |
| `common OR is:starred` | `UNION` | 32 ms |

Driving FTS through `rowid IN` with a rare filter looked good on exact terms (8.6 ms
for 40 rows), but every unquoted word is a prefix term, and there it collapses. The
likely cause is that FTS5 runs a filter per rowid and rebuilds a merged doclist each
time. For `<term> is:starred` over 40 rows:

| Term | `rowid IN` | Walk FTS hits | Newest window |
|---|---|---|---|
| `"commonword"*` | 282 ms | 44 ms | 11.5 ms |
| `"w"*` (all terms) | 28,662 ms | 784 ms | 723 ms |
| `"w1"*` | 20 ms | 79 ms | 14 ms |
| `"rareword"*` | 1.3 ms | 0.1 ms | <0.1 ms |

Searching newest-first in time windows gives early results at a higher total cost.

The same cause makes a common word slow with no filter at all: a prefix FTS5 has no
index for is built as a merged doclist before `LIMIT` can apply. On 500k messages
with a common word in every other message:

| Option | Word alone | `<word> is:starred` by `rowid IN` | Database | 500-message batch |
|---|---|---|---|---|
| `prefix='2 3'`, native prefix | 9 ms | 431 ms | 937 MB | 10 ms |
| `prefix='2 3 4'` | 0.02 ms up to 4 characters | | 1240 MB | 20 ms |
| `prefix='2 3 4 5 6'` | 0.02 ms up to 6 characters | | 1740 MB | 34 ms |
| `prefix='2 3 4 5 6 7 8'` | 0.02 ms up to 8 characters | | 2018 MB | 62 ms |
| OR of 5 exact forms, `prefix='2 3'` | 0.04 ms at any length | 3.8 ms | 937 MB | 10 ms + about 8 ms |

An OR of exact terms stays lazy, and its width costs little: 64 terms take 0.6 ms.

## Decision

**Language.** Gmail-shaped, extending what exists:

```
query = and { "OR" and }
and   = unary { [ "AND" ] unary }
unary = ( "-" | "NOT" ) unary | "(" query ")" | term
term  = field ":" value | field ":(" query ")" | word | "phrase"
```

- The parser is total. It returns a tree, token spans and diagnostics; it never
  throws. What it cannot understand is dropped and reported, the rest still runs.
- An unfinished term (`from:`, `is:un`, `after:2026-1`) constrains nothing and is
  not an error, so the list does not blink while typing. A query with no
  constraints behaves like no query at all.
- Only uppercase `OR`, `NOT` and `AND` are operators; `"OR"` and `or` are text. A
  minus negates only at the start of a token, so `e-mail` stays text.
- An unknown field is plain text (`re:umowa`), as before.
- Limits: 1024 characters, 32 terms, 8 levels of brackets.
- User text still never reaches `MATCH` unquoted. `OR` and `NOT` in a `MATCH`
  string are produced by the compiler, never taken from the user.

**Fields.** `from to cc subject label has before after` plus `is:` (`unread read
starred replied draft`), `account:`, `from:me` / `to:me` / `cc:me`. A value with `@`
matches that address as a phrase.

**Days are local.** `after:2026-11-03` starts at local midnight, where the parsing
process runs. Relative values (`today`, `yesterday`, `-7d`, `-2w`, `-3m`, `-1y`) are
computed against a `now` passed in, so a saved query keeps its meaning over time.

**Dates are read from the key.** A date bound is a range on the chronological key.
A message's key is fixed at its first upsert (ADR 0016), so a message whose date
later changes is found by its original date, the same date the list sorts it by.

**The parser lives in core,** so the renderer can parse synchronously. The backend
parses the text again: the contract still carries text and a tree from the renderer
is never trusted.

**Plans live in the SQLite adapter,** behind `SearchIndexPort`:

- FTS-only subtrees go into one `MATCH`; date bounds become key ranges.
- Partial indexes cover unread, starred, draft and attachments;
  `(label_fold, message_key)` covers labels.
- `message_terms` holds every indexed word, written in the same transaction as the
  documents and never deleted. A prefix of 4 to 32 characters with 1 to 64 terms
  becomes an OR of those exact terms. Otherwise it stays a native prefix: lengths 2-3
  use the prefix index, and the rest pay for the merged doclist. A word over 32
  characters is stored as its first 32 plus a mark, which forces the native prefix
  whenever such a word could match, so results never depend on the expansion.
- A plan with `MATCH` drives through `rowid IN` when no native unindexed prefix is
  involved and `rows * weight <= 500`, about 12 ms. An exact term or expanded form
  weighs 1 and an indexed prefix 12. Otherwise it walks FTS hits. The probe is capped
  at what the budget can afford, and does not run when nothing can be afforded.
- Without `MATCH`, the rarest indexed filter is found by a capped count against its
  index and drives through `IN` up to 10,000 rows; otherwise the table is walked,
  since a dense filter ends the walk quickly.
- Heavy plans run in time windows newest-first: 1, 4, 16 and 64 months back from
  the newest message, then the rest. A heavy plan is one with an FTS subquery, FTS
  hits walked under any other condition, or a table walk with an unindexed condition.
  An FTS subquery is cut to the window, so it materialises only that window's hits.

**Progressive results.** `SearchIndexPort.searchChunk` returns one window: fewer
keys than the limit, even none, plus a cursor when more may exist. The renderer asks
for the next chunk only while the query is still the current one, which is what
abandons a stale query between windows. `search` stays and returns an exact page.

Not in this ADR: the query bar UI, saved views, `in:` (needs label roles in the
schema), suggestions of people.

## Consequences

- Words `OR`, `NOT` and `AND` in capitals are no longer searched unless quoted.
- A migration builds five indexes once; it takes seconds on a large mailbox. Writes
  to `messages` and `message_labels` maintain them.
- A page of results can be short or empty without being the last. Every consumer of
  `SearchResponse` must follow `nextBeforeKey` instead of comparing to the limit.
- Heavy queries cost more in total, in exchange for first results within budget.
- The numbers above are synthetic. `packages/adapter-sqlite/bench` carries these
  shapes; a missed budget changes a plan, not the budget.

**Known misses.** Measured through the adapter on 500k synthetic messages (SQL only,
median of 30 runs), these do not meet the 16 ms budget and stay open. The word hits
about half the mailbox:

| Query | First chunk | Whole page |
|---|---|---|
| word with many forms + `is:starred` | 18 ms, no hits yet | 162 ms |
| that word + `label:rare` | 19 ms | 20 ms |
| that word in a narrow old date range | | 17 ms |
| two-letter prefix in a narrow old date range | | 19 ms |
| `-frequent` alone | 14 ms | 14 ms, p95 85 ms |

A word with many forms is too heavy to drive, so a rare filter walks its hits. Windows
bound how long one request blocks and let a stale query be dropped, but they do not put
this query within budget. Prefixes that expand past 64 terms stay native and cost up to
about 8 ms in this data.

**The terms table.** Writes cost about 8 ms more per 500 messages (the sync batch went
from 89.5 to about 98 ms), and the migration reads the whole FTS vocabulary once. The
table was 0.27 MiB in the benchmark, whose vocabulary has about 20,000 words. A real
mailbox has more, including codes and identifiers, and that size is not measured yet.
Words of deleted mail stay in the table until a rebuild, so it can hold words from a
removed account. They are single words, not messages, and it matters for a later
"forget this account" guarantee.
