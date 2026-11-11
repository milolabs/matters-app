# 0006. SQLite (`node:sqlite`) for storage and FTS5 search

- Status: Accepted
- Date: 2026-11-03

## Context

Measured in Electron 45 (Node 24.22, SQLite 3.53) on synthetic mailboxes:

| | 8k messages | 200k messages |
|---|---|---|
| full index build | 0.4 s | 15.6 s |
| newest 50 for any term (`ORDER BY rowid DESC`) | 0.01–0.02 ms | 0.02–0.26 ms |
| BM25 rank for a term in every message | 5 ms | 181 ms |
| naive `LIKE '%term%'` | 12 ms | — |

FTS5, the trigram tokenizer and `loadExtension` are available. Built-in
`remove_diacritics` does **not** fold Polish `ł` (no Unicode decomposition):
"zolw", "lodzi", "zrodlo", "przyslal" found nothing; a custom fold found all.

Alternatives: Tantivy (native module, faster at millions of messages),
Meilisearch (separate server), Xapian/notmuch (GPL, harder to embed).

## Decision

- One SQLite database per profile, WAL, `synchronous=NORMAL`, `mmap`, large
  page cache, prepared statements reused.
- Search: FTS5 with `unicode61`, `prefix='2 3'`, text folded in JS before
  indexing and querying (NFD, strip marks, `ł→l`).
- **Message rowid is chronological** (`date_ms * 1024 + seq`), so "newest N"
  is O(N) regardless of match count, even when sync arrives out of order.
- Default sort is by date; BM25 only for narrow queries or within a recent
  window.
- Lists use keyset pagination (`WHERE rowid < ?`), never `OFFSET`.
- User queries go through our own parser (`from:`, `to:`, `subject:`,
  `has:attachment`, `before:`, `after:`, `label:`); raw user text never
  reaches `MATCH`.
- Every word is a prefix by default (`faktur` finds `faktura`, `fakturę`).
- All access goes through `SearchIndexPort` / `MessageStorePort`
  ([ADR 0004](0004-hexagonal-architecture.md)).

Deferred: trigram index on senders and subjects, `fts5vocab` suggestions,
Polish lemmatization, attachment text, semantic search (`sqlite-vec` or brute
force over embeddings).

## Consequences

- No search server, no native search module.
- The index is derived data: schema changes may rebuild it from stored raw
  messages.
- Above ~1–2 M messages per device, revisit (Tantivy adapter behind the same
  port).
