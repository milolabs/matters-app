# 0067. What the owner's labels taught

- Status: Accepted
- Date: 2026-11-06
- Amends: [0066](0066-what-you-would-regret-not-seeing.md) (is it still alive, what shows)
- Amended by: [0068](0068-who-writes-what-you-refuse-what-comes-from-an-office.md) (`CHECK_UNKNOWN_DAYS` is 30; an office is checked after 60 days and never leaves)

## Context

The thresholds of ADR 0066 were judgments. The owner then marked 24 real threads with two answers each: was
it worth showing when it came, and does it need attention today. Replies alone cannot say this about bills
and offers. Reading exactly those threads with the new code gave four clear disagreements.

- All four threads the owner had written in were marked as needing attention today, and silence sent most
  of them to `check`.
- A warning with a date still to come went to `check` because the reading could not tell its status.
- An old offer sat in `check`, though nobody owes anything about it, and was marked as not worth showing.
- A request for money from a free-mail address was hidden, because the model doubted the mail, while the
  owner wanted to see it. A platform's notice that a named person wrote was hidden too, and the program
  filter of ADR 0066 would not even have read it.

## Decision

1. **The person's own thread stays alive.** A thread the person wrote in does not become `check` for 90 days
   of silence. It is for now when the other side wrote after the person and that was not answered, or when
   money is owed to the person.
2. **A date still to come is alive.** A due date or an offer's end that has not passed means no `check`.
3. **An offer ends.** A `decide` past its window, or silent for 21 days, leaves the list instead of becoming
   `check`. Silence never proves that a debt is settled, but nobody is owed anything over an offer.
4. **A doubted request can still warn.** A reading with confidence of at least 0.3 and below `MIN_CONFIDENCE`
   shows only if it is `suspect`. It is still never for now and gets no draft. Everything else that is
   doubted stays hidden.
5. **A person writing through a platform counts.** Subjects saying so are kept by the program filter, the
   reading treats them as `reply`, and confidence is about what the thread asks, not about whether the
   sender is genuine or the text complete.

`ANALYZER_VERSION` stays 4: this reading had not run on any real mailbox when these changes were made.

## Consequences

- 24 labels from one person are a small sample, used here both to find the rules and to check them. A set the
  rules have not seen is still needed.
- Routine bills that the owner marked as not worth showing still appear. This is one person's preference about
  particular senders, so it stays with `Not important` and rules (ADR 0054), not with a threshold in code.
- The model reads the same thread differently between runs, so a label's outcome can vary run to run.
