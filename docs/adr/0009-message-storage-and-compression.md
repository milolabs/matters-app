# 0009. Raw messages as zstd blocks per thread

- Status: Accepted
- Date: 2026-11-03

## Context

Raw messages are the source of truth; everything else (metadata, index,
rendered HTML) is derived. `node:zlib` in Electron 45 has zstd. Measured on
synthetic threads with quoting and signatures:

| | Ratio | Decompress |
|---|---|---|
| zstd level 3, per message | 3.2x | 7 µs per message |
| zstd level 3, per thread block | 9.0x | 9 µs per thread |
| zstd level 19, per thread block | 11.2x | — |

A trained zstd dictionary was rejected: it adds a moving part for a gain that
per-thread blocks already deliver.

## Decision

- Raw `.eml` data of a thread is stored as one zstd block (level 3) in SQLite,
  with offsets per message. Very long threads are split into 64–256 KB blocks.
- A new message in a thread rewrites its block in the background.
- Small blobs live in SQLite; attachments over ~1 MB live in files named by
  SHA-256 (deduplicated across threads).
- Already-compressed formats (PDF, JPEG, PNG, ZIP) are not recompressed.
- Hot data (metadata, FTS index) is never compressed.
- Precomputed sanitized HTML is stored compressed next to the raw block.

## Consequences

- Opening a thread costs one read and ~10 µs of decompression.
- Real-world ratios will be lower than the synthetic 9x; to be measured on a
  real export.
