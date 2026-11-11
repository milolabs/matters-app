# 0088. A sender's HTML is kept together

- Status: Accepted
- Date: 2026-11-09
- Amends: [0009](0009-message-storage-and-compression.md) (blocks per thread), [0024](0024-rendering-mail-html.md) (HTML in zstd blocks of its own)

## Context

ADR 0009 keeps a thread's bodies in one zstd block, because a reply quotes the message before
it; on synthetic threads that gave 9x. ADR 0024 keeps the HTML as sent in blocks of its own, the
same way, per thread.

Measured on the maintainer's mailbox (197k messages, 3.6 GB database): the HTML is 8.3 GB raw and
1.5 GB stored (5.4x), 46% of the database. 173k of its 178k threads with HTML hold one message
(newsletters, notifications), so a thread block is a single message and the quoting gain of
ADR 0009 is not there. What repeats is the sender's template: mail from one sender shares most of
its markup.

On all the HTML of 1 in 15 senders (12k messages, 629 MB raw), zstd level 3:

| Layout | Stored | Open one message (p50 / p95) | 50 new messages, one write (p50 / p95) |
|---|---|---|---|
| per thread, 256 KB (before) | 97.6 MB | 0.04 / 0.09 ms | 5 / 6-10 ms |
| per sender, 256 KB | 64.5 MB (-34%) | 0.10 / 0.15 ms | 7 / 8 ms |
| **per sender, 1 MB** | **47.1 MB (-52%)** | **0.38 / 0.5 ms** | **11 / 14 ms** |

Also measured, and not taken:

- Level 19 per thread: -14%, at many times the compress time.
- A trained zstd dictionary (110 KB or 1 MB): -8 to -10%, and one more thing to keep and version.
- Removing embedded `data:` images (~7% raw) or `<style>` (~9% raw): the HTML is kept as sent.

The text blocks stay per thread: they are 250 MB, they hold the quoting ADR 0009 was about, and
search and the agent read them by thread.

## Decision

1. **HTML is kept in blocks per sender**, 1 MB raw each. The group of a message is `from:` and its
   sender's address in lower case. A body without a sender (an older caller) keeps its thread as
   the group. `MessageBody.sender` carries the address, as `threadId` carries the thread.
2. **The group is a column, not a thread.** `html_blocks.thread_id` and `html_index.thread_id`
   are renamed to `grp` (migration 41, schema only). Reads go through `html_index` and never care
   which kind of group a block has, so old per-thread blocks and new per-sender ones are read the
   same way.
3. **Existing HTML moves in the background**, not at launch. Migration 41 only renames and
   creates the work list `html_repack (sender, key)`: filling it in one statement read every
   message's sender and took 2.5 s on a cold cache. From 20 s after launch the sync worker runs
   one small write every 100 ms. The first steps list 5,000 messages each, with their senders.
   Then each step moves about 4 MB of raw HTML in sender order, so it touches the tails of only a
   few senders. The move stops when the list is empty. A message that was removed, or rewritten
   into its sender's group in the meantime, is skipped. A launch that stops it starts again where
   it stopped.
4. Text blocks, their limit (256 KB) and their grouping do not change.

## Consequences

- Run on a copy of the maintainer's database: migration 41 takes 4 ms. The move takes 39 listing
  steps (p50 42 ms) and 2,106 moving steps (p50 17 ms, p95 62 ms, max 132 ms): about 53 s of
  writes, about 4 minutes with the pauses. HTML goes from 1,526 MB in 177,964 blocks to 800 MB in
  15,598 blocks (-48%). All 188,829 messages checked read back byte for byte. While a step runs,
  a write of new mail waits for it, at most about 130 ms.
- Opening a message unpacks up to 1 MB instead of up to 256 KB: 0.4 ms, against 50 ms for opening
  a thread (ADR 0012). A thread with replies from many senders reads one block per sender.
- A new message rewrites its sender's last block, up to 1 MB raw: a write of new mail takes about
  twice as long, on the sync worker, never on the UI. The WAL gets the compressed block, so what
  goes to disk barely changes.
- Removing one message rewrites its sender's block, up to 1 MB.
- Until the move ends, the database holds both kinds of blocks. Space freed by the move stays in
  the file as free pages and is reused by new mail; the file only shrinks with a `VACUUM`, which
  this ADR does not run.
