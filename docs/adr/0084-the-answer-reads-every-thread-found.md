# 0084. The answer reads every thread found

- Status: Accepted
- Date: 2026-11-09
- Amends: [0080](0080-the-agent-follows-the-trail.md) (the size cap of the answer turn), [0083](0083-the-agent-searches-in-a-loop.md) (`open_thread`)

## Context

Every answer across all mail on the owner's mailbox came out of one thread, whether the trail or the
loop searched. The answer turn added the chosen threads in order until 120 000 characters, and at
the first one that did not fit it stopped. Conversation threads carry their whole history quoted in
every reply: one thread of 24 messages measured 183 155 characters. That one thread filled the
budget alone, was cut, and nothing after it went. The loop's `open_thread`, at 12 000 characters,
showed mostly quotes too.

## Decision

1. **Quotes out, by the thread itself.** `withoutRepeats` (core `domain/quotes.ts`) drops from each
   message the lines that only repeat earlier messages of the same thread:
   - it compares shingles of 8 folded words, with no patterns and no words of any language, so
     re-wrapped and `>`-marked quotes go alike;
   - a line goes when it has 3 words or more and at least 80% of them are covered;
   - the first message is never changed, and a mark says where text was left out.

   Nothing is lost to the thread: what was dropped is in the earlier message. `renderThread` uses
   it for every prompt of a thread, and so does `open_thread`. Quotes the model copies are still
   checked against the full text of the message.
2. **A share each, and skip, not stop.** Each thread gets `max(6 000, 120 000 / threads)`
   characters. It keeps its newest messages whole, and the older ones become "[N earlier messages
   left out]". A thread that would pass the cap is skipped, and the ones after it still go.
   `[Thread n]` numbers have no gaps.

## Measured

The 18 threads the loop chose for "my employment history" on the owner's mail:

- their text shrank from 1 298 703 characters to 168 044 without repeats (13%);
- before, the answer turn took 1 of them;
- now it takes all 18, in 77 135 characters.

## Consequences

- Answers rest on what the search found, not on its first thread.
- A long thread shows its newest messages; its oldest may be left out with a mark.
- An earlier experiment found that taking quotes out of the search index did not help the ranking
  (people's long threads lost the bonus they got for many matching messages). The index stays as
  it is: quotes are taken out only where text goes to a model.
