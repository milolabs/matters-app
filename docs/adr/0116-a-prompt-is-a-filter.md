# 0116. A prompt is a filter

- Status: Proposed
- Date: 2026-11-11
- Amends: [0025](0025-query-language-and-plans.md) (`limit:` and `sort:`; an order along the key in either direction)
- Builds on: [0027](0027-saved-views.md), [0051](0051-agents-on-the-users-own-plans.md), [0064](0064-one-prompt-for-a-thread-or-all-mail.md)
- Amended by: [0117](0117-matters-is-a-view-with-a-prompt.md) (rules 3 and 10: a view with a prompt reads new mail in the background and has a badge)

## Context

`Matters` (ADR 0052, 0066 to 0068) is one fixed question with one fixed ranking. A model reads each
thread into facts, and code scores them with weights the owner tuned on their own mail. In an
open-source client that has two costs:

- A person cannot ask their own question of their mail and keep the answer as a place to return to.
  They can only take the question we wrote, or ask the agent once in a talk (ADR 0064).
- The ranking is a judgment in code. Someone whose mail is not like the owner's has to change
  constants to change what shows.

Two things already in place make a different shape cheap to try:

- A view is a name and query text (ADR 0027), so anything that can be written in the query bar can
  be saved, renamed and returned to with no model of its own.
- The agent already reads threads into a checked shape and stores the reading under the thread and
  its last message (ADR 0052, rule 2), so a reading is paid for once.

Two limits hold whatever we build. A keystroke has 16 ms (ADR 0012), and no interaction waits for a
model (ADR 0051, rule 10). A model also runs on the person's plan, so how much is read must be
bounded and shown before it starts.

This is an experiment. `Matters` stays as it is while it runs, so the two can be compared on the
same mail.

## Decision

1. **A new field, `prompt:`.** `from:office after:-30d prompt:"what needs my decision"`. Its value
   is a word or a quoted phrase, in the person's own words. The parser takes it out of the tree and
   returns it beside it, so the query plans of ADR 0025 never see it. There is one prompt per
   query. A second one, a negated one, one under `OR` and `prompt:( … )` are dropped and reported
   as diagnostics; the rest of the query still runs. `prompt:` with no value constrains nothing,
   like any unfinished term.
2. **Mail filters first, the prompt after.** Everything else in the query runs as it does today, on
   this machine and on every keystroke. The prompt only ever narrows and orders what those filters
   found. Typing never starts a model: while a prompt is being typed, the list shows the mail
   filters' result.
3. **A prompt runs when the person asks.** `↵` in the query bar runs it, and so does opening a saved
   view whose text holds a prompt, for the threads it has not read yet. Both are `P0` (ADR 0051,
   rule 7). Reading for a view in the background when new mail arrives is ADR 0117, rule 3.
4. **The prompt finds its own candidates.** Reading the newest threads one by one does not answer
   a prompt: what it asks for is usually old and rare, and the first trial read 200 recent threads
   to show notices that only mention an employer. So a run starts with a search. The agent gets
   the prompt and no mail, and searches in the loop of ADR 0083 with our two read-only tools, over
   all stored mail of the accounts with consent, outside Trash and Spam and without what the
   person's rules cover. Every search it makes is narrowed by the view's mail filters, in code. A
   runtime that cannot run tools gets the plan turn of ADR 0080 instead, which writes queries
   without seeing mail.
   When the mail filters alone are narrow, there is nothing to search for: if they match at
   most `PROMPT_ASK_ABOVE` threads, the prompt reads exactly those, with no search turn, so
   `from:anna prompt:"where she made me an offer"` reads Anna's threads and nothing else. The
   search is for a prompt with no filters, or with filters that still leave more than that.
   The order is always: mail filters, then the prompt, then `sort:`, then `limit:`.
   After a search, the candidates are every thread the kept queries match, not only the best few a search lists
   to the agent: the person asked for all the mail the prompt means, so there is no cap of our
   own. They are read best match first, so what fits most shows early. The search costs the budget
   of ADR 0083, rule 5; the reading costs what the search found, which is not known before it.
   So the bar says how many threads were found as soon as the search ends. Up to
   `PROMPT_ASK_ABOVE` (200, a starting value) the reading goes on by itself; above it the bar
   waits for one more `↵`, because that much reading is a large part of a plan's window. That is
   a question, not a limit: the person can read all of them. Stop and the plan's own limit
   (ADR 0051, rule 7) end a reading and keep what was read; the bar then says how many are left.
   The queries the search wrote are kept with the prompt and the mail filters. Coming back to a
   view runs them again on this machine, with no model, and only threads they find that have no
   verdict yet go to a model. `Search again` runs the loop anew.
4a. **`limit:` is the person's own cap, for any query.** `limit:10` means ten results of whatever
   the rest of the query gives, in its order: without a prompt, the ten first messages the filters
   match; with one, ten threads that fit. A prompt under a limit reads its candidates in the
   order of `sort:` (best match first for `fit`) and stops as soon as that many fit. How many
   threads that takes is not known before reading, so the limit alone does not bound the cost:
   one run under a limit reads at most `PROMPT_ASK_ABOVE` threads, then the bar says how many
   are left to be sure of the result and the next `↵` reads on. Under `sort:fit` these are the first ten found to fit, in order of
   fit, not the ten best of everything: finding those would mean reading it all. It is a term of
   the query like any other, so a saved view keeps it, and removing or raising it reads on from
   where it stopped. Its value is a whole number above zero; anything else is reported and
   constrains nothing. There is one per query, at the top level. Changing it never starts a new
   search for a prompt.
4b. **`sort:` says the order, for any query.** Its values are `newest` (the default without a
   prompt), `oldest`, `relevance` and `fit` (the default with a prompt, and only valid with one).
   `limit:` cuts after the order, so `sort:oldest limit:10` is the ten oldest.
   - `newest` and `oldest` walk the chronological key in either direction, so both stay cheap and
     paged (this is what ADR 0025 kept `ORDER BY` out for; a direction along the key does not
     break it). With a prompt they show what fits by date, with day headings again.
   - `relevance` orders by how well the words of the query match, with the ranking the agent's
     search already uses (ADR 0081, 0082). A rank needs all hits before the first row, so it is
     computed over at most `RELEVANCE_POOL` matches and never on the keystroke path: the list
     shows the dated order while typing and the ranked one after `↵`. A query with no words has
     nothing to rank by and stays by date, and says so.
   - `fit` is the order of rule 7.

   An order by the score of `Matters` (ADR 0052) was tried as a fifth value and removed. That
   score exists only for threads read in the window of `Matters` (119 on the owner's mailbox),
   so on an arbitrary query it reordered a handful of rows and left the rest by date.
5. **The unit is a thread, and a verdict is kept.** A verdict is stored under
   `(promptKey, threadId, lastMessageKey, PROMPT_VERSION)`. `promptKey` is a hash of the prompt
   with white space folded. Nothing new in a thread means no new call for that prompt, which is
   what makes a saved view a place to return to: opening it reads verdicts from the store.
6. **What a verdict holds.** `fit` from 0 to 3 (0 does not fit, 3 fits strongly), `why` in one
   sentence, and a `quote` with the message it is from. The model proposes; code decides (ADR 0051,
   rule 9): the answer is validated against its schema, a thread it names must be one that was sent
   in that turn, and a `fit` above 0 whose quote is not found in the message it names is stored as
   0. `why` is the model's own sentence, so it is shown in the agent's colour (ADR 0052, rule 10).
7. **One mechanism filters and ranks.** The list shows threads with `fit` of 2 or 3, highest first
   and newest first among equals. A `fit` of 1 is kept and not shown: in the first trial it was
   what let loose associations through. A thread fits only when it holds what the prompt asks for
   itself; mail that merely comes from, or mentions, something related does not. A prompt that reads like a filter ("only invoices I have not
   paid") and one that reads like a ranking ("what would I regret not seeing") go through the same
   turn.
8. **Signals from code, not a score.** Each thread goes with a few lines of local facts: how many
   messages the person wrote to this sender or company and in which year the last (the line of ADR
   0066, rule 1), whether the thread is unread, starred or answered, and how many messages it has.
   They hold counts and years, no addresses. The model is told they are context it may use or
   ignore. There are no weights in code.
9. **Turns.** Threads go in batches, clipped and marked as data as in ADR 0051, rule 8, on the
   model for understanding mail. The prompt goes as untrusted text and never into the fixed
   instructions. Turns run in the sync worker; verdicts appear in the list as each batch returns,
   and the bar shows how far the reading is, with Stop. A stopped run keeps the verdicts of the
   batches that finished. Each turn writes a ledger line with the runtime and the number of threads,
   and no prompt or mail text.
10. **A saved view needs nothing new.** The prompt is part of the view's text. Editing it marks
    the view changed as any edit does. Its badge is ADR 0117, rule 4: a count of the mail filters
    alone would not be a count of what the view shows.
11. **Without AI.** While AI is off, or no account has consent, `prompt:` is reported as a
    diagnostic that says AI is off, and constrains nothing.
12. **Verdicts are the agent's data.** They are removed with the rest of it. Verdicts of a prompt
    that no saved view holds are dropped after 30 days.

Not in this decision: actions on a row such as `Done` and `Later`, drafts ahead, and a prompt
longer than the query's 1024 characters. Replacing `Matters`, reading for views in the background
and a badge for views with a prompt are ADR 0117.

## Consequences

- A person can write their own question, save it as a tab, and come back to an answer that only
  reads what is new. `Matters` could later become one such view that ships by default.
- Order is no longer derived from facts by code. The same thread can get a different `fit` on a
  different day or model, and the reason shown is the model's sentence, bounded only by its quote.
- A new prompt costs one search loop and then a batch of verdicts for every ten threads found.
  A broad prompt on a large mailbox can use up a plan's window; the count after the search, the
  question above 200, Stop and `limit:` are what keep that the person's choice. Verdicts are per prompt and share nothing with each other or with the readings of ADR
  0052.
- What the search does not find is not judged. A prompt whose answer cannot be reached by words
  ("mail that sounds annoyed") is served worse than by reading everything; narrowing with mail
  filters first is the way to ask that of a small set.
- A view's kept searches are only as good as the first loop wrote them. `Search again` is the
  remedy, and it is the person's choice.
- The list under a prompt is not chronological and is not paged along the key. With no cap it can
  hold thousands of rows; it is sorted in memory and sent whole (about 3 MB for 5,000 rows, as
  measured), and the window reads it at most once a second while a reading runs.
- Mail can try to steer its own verdict. It can only make itself show or hide in that view; the
  quote check and the lack of any tool bound the harm, as before.
- Whether this is better than `Matters` is a question for the snapshot and the owner's labels
  (ADR 0067), asked before anything is removed.
