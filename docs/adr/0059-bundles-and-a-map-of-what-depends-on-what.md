# 0059. Bundles, and a map of what depends on what

- Status: Superseded by [0117](0117-matters-is-a-view-with-a-prompt.md)
- Date: 2026-11-05
- Amended by: [0061](0061-a-series-is-one-row.md) (repeats of one ask fold into one row)

## Context

Each thread is read alone. A person's work does not come in threads: one invoice can be three threads
with three people, and paying it can be what someone else is waiting for. The owner wants the model to
know how deep a thread is, what it is connected to and how much it weighs, across threads.

Giving a model the whole mailbox is what ADR 0052 refused: it does not fit a plan and sends too much
away. So the map has to be built out of little, and most mail must never become part of it.

## Decision

1. **A vertex is earned.** There are two kinds: a **matter** (what threads are about) and a
   **commitment** (a quoted fact that is still open, which readings already give). A matter exists only
   once two listed things share it. Everything else stays out of the graph, which is what keeps it
   small: most mail is not a vertex. A person is not a vertex, only weak evidence: one busy colleague
   would otherwise join everything.
2. **Threads are joined by evidence, in two strengths.** Hard: the same anchor (`651/2026`), found word
   for word in the mail of each. One hard link joins; an anchor shared by more than 8 threads is a
   common word and does not. Soft: the same `case` name, the same person within a week, the same
   subject. Two kinds of soft link must hold between the same two threads, never across accounts, and a
   group of more than 12 counts for nothing. A bundle stops growing at 20. All of this is code. The
   store offers no reference headers or attachment hashes here, so those are not used.
3. **Weight flows along dependencies.** A commitment has its own weight, the score of ADR 0057 and 0058.
   When one blocks another, it also gets half the weight of what it blocks, and within a bundle it
   always comes first, since what waits cannot be done first. `why` says `Unblocks 3 others`. Same
   facts, same order.
4. **The model sees cards, not mail.** A card is what a reading already produced: the matter, its open
   quotes, dates, depth and who. Two uses, both bounded by the plan budget of ADR 0051:
   - reading a thread includes the cards of its neighbours, so a new message is read knowing the matter;
   - a matter with two or more open commitments gets one short turn over its cards, asking only which
     numbered commitment blocks which, with a quote. Code checks the quote. No quote, no edge.
   Cards come from mail, so they go in as data, never as instructions.
5. **Shown where the person already looks.** A bundle stays ordinary rows, kept together behind its
   heaviest and held by a rail in the gutter, so paging, keys and choosing several go on working. It is
   for now as a whole if any of it is. The thing in the reader shows its matter as an
   order of work, not as a graph: one sentence says where to start and what that frees, what can start
   now has a filled dot, and what waits is indented under what holds it up. Order gives the direction,
   so no line needs an arrow. The lines and the quotes are the agent's, dashed and violet, and each quote
   sits on the line it explains. Pointing at a thread lights up only its path.

## Consequences

- The whole of this is one list read: bundles are worked out on every read, in memory, from what is
  already loaded, and the blocking answers are kept by which threads at which messages they were about.
- `ANALYZER_VERSION` goes to 3, because the reading's instructions gained the related matters.
- The turn about blocking runs only after everything is read, at `P2` like a draft, and goes in the
  ledger as an analysis, since quotes from the mail go with it.
- Whether anchors from real mail are specific enough has not been measured. A wrong bundle costs little
  so far, since nothing is hidden, but the person cannot yet take a thread out of one.
