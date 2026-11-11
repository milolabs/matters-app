# 0080. The agent follows the trail

- Status: Accepted
- Date: 2026-11-08
- Amends: [0064](0064-one-prompt-for-a-thread-or-all-mail.md) (rule 7, the talk across all mail)
- Amended by: [0081](0081-finding-what-the-question-means.md) (the plan turn, the ranked search, the candidate list), [0082](0082-what-the-plan-asks-for-is-not-put-behind.md) (rule 5: what the plan asks for is not put behind)
- Builds on: [0012](0012-performance-budgets.md), [0025](0025-query-language-and-plans.md), [0074](0074-finding-files-by-name.md)

## Context

The owner asked the agent, across all mail, for "contracts", for a "job change" and for the offer
from a named person at a named company. The mail that answered all three existed: an English thread
from the summer, from people at the company, with a signed offer letter attached. The agent said
that there was no such mail.

The cause was not the model. The talk made one search from the person's words, newest first, and
read the first twenty threads it found. The word that named the company also named dozens of recent
build notifications, and a broker's weekly newsletters shared the word "contracts" with the
question. They filled the list; the one old thread never reached it. The answer turn was then told
that the threads it was given were all it knew, and it reasoned from that to "there is none".

Four things were wrong:

1. The search ranked by date. A thread that merely mentioned a word yesterday beat the thread that
   was about it five months ago. There was no bm25 anywhere.
2. One query, in one wording, from a model that could not see what the mail looked like. Any fault
   in it ended the whole question.
3. The names of attached files, which are indexed (0074), were not used. "offer letter" is the file.
4. The answer turn could claim absence it had no way of knowing.

## Decision

### The engine for the agent (the person's own search is unchanged)

1. **A ranked search**, `RankedSearchPort.searchRanked`, on the same index and the same query
   language. It takes the plan the person's search takes (`planQuery`: conditions, dates, accounts,
   Trash and Spam left out before anything is cut) and orders the matches by FTS5 `bm25` with the
   weights `sender 3, recipients 1, cc 0.5, subject 5, body 1`. The best 300 messages come back,
   whatever their age. `bm25` works on the contentless `message_fts` under the bundled SQLite. The
   FTS table drives the join (`CROSS JOIN`): left to itself the planner scanned `messages` and ran
   the `MATCH` for each row, which took seconds.
2. **Recency is a mild prior**, applied by code on the messages and then on threads:
   `score = relevance - 0.7 * ln(1 + ageDays / 30)`. Five months cost about 1.4 points and three
   years about 2.4, against a relevance of 5 to 30 for a subject match on a rare word, so a clearly
   better old match beats a weak new one, and equal matches are ordered newest first. The best
   message stands for its thread.
3. **Words.** Several plain words are ANDed prefixes, a quoted text is a phrase, `OR`, `-` and
   brackets are as in the grammar of 0025. The parser already splits `labs-acme.example` into ANDed
   prefix words, so the agent's search and the person's agree on words; the ranked search has no
   word semantics of its own.
4. **File names.** When a query is plain words only (no field, filter or negation), the names in
   `file_fts` join the matches. Each group of words that must all occur is searched by its longest
   word, and the other words are checked on the names, so "offer letter" finds
   `Offer_letter (signed).pdf`. A file match counts for a fixed relevance (5 for one word, 9 for
   several).
5. **Merging.** Several queries are merged by reciprocal-rank fusion, `sum 1 / (60 + rank)`.
   Candidates are then ordered for reading: threads from one company (an address at a shared mail
   domain counts alone) beyond the third, and threads written only by programs, go behind the rest.
   Nothing is dropped, so a search for what one sender wrote is still answered in full. The person's
   rules are not an ordering: a thread they cover is never seen by a model.
6. **Budget.** On 100,000 messages in 30,000 threads (a long-tailed vocabulary, a burst of
   notifications, the common words of a mailbox), a ranked query, with the ranking by thread, takes a
   median of about 5 ms and a p95 of about 23 ms; the test fails above 50 ms (the person's own search
   keeps the budget of 0012).

### The plan and the trail

1. **Plan turn** (the understanding model). Input: today's date, the earlier talk (the person's
   lines and short earlier answers, labelled as data), what the previous question of the talk came to
   (point 5 below), and the person's words. No mail. Output: `goal`, `assumptions`, up to five
   `trails` (`name`, `why`, `priority` 1 to 5, one to three `queries`), `traps` (kinds of mail that
   would only add noise), and the old `state` and `olderThanDays`. At most eight queries in all, 300
   characters each. A plan with more is not refused: the likeliest trails keep their queries up to
   eight and the rest are dropped, because a real plan for a broad question ("mail about my job
   change") came back with five good trails and eleven queries, and refusing it would have ended
   the question. The instructions ask for the forms mail would use in each likely language and for
   likely senders and services.
2. **Round one.** The code runs, in parallel, the queries of the trails of the top priority and the
   one below it (at most six); the rest of the plan is shown to the follow turns as not yet run. A
   query with a fault is dropped with its diagnostic and the others run; only if every query fails
   does the turn end with nothing found.
3. **Candidates.** Each thread found becomes a short summary: its number, subject, newest sender
   (name and address), date, message count, up to three attachment names and a passage of at most
   300 characters of the message that matched best. Summaries are labelled data; a subject or a
   passage cannot pass for a marker or an instruction.
4. **Follow turn** (the understanding model), at most twice. Input: the person's words, the plan, the
   queries run with the number of threads each found, up to 60 candidates best first, and the current
   hypothesis. Output: `decision` (`answer` or `follow`), `keep` (up to 20 candidate numbers worth
   reading), `newQueries` (up to four, never one already run), `dropTrails`, `hypothesis`. The loop
   ends on `answer`, on queries that find nothing new, on the third search round, or on the time cap.
   The last round has no turn after it: what it found joins what was kept. A follow turn that does not
   fit its schema steers nothing, and the best candidates are read as they are.
5. **State carried on.** The answer is stored with a compact `carry` (the hypothesis, the thread ids
   read, the queries run; schema migration 38). The next question of the talk sees it in the plan
   turn, and the threads read before are candidates again, so "and when did she say it?" builds on
   the last answer. The state is model text made from mail, so it is data wherever it is read.
6. **Answer turn** (the answering model). It gets the full text of the kept threads (without a choice,
   the best ranked, people before programs), at most 20 and at most `MAX_TALK_ALL_CHARS` characters
   in all; a first thread over the cap is cut to it (it used to pass). Quotes are verified as before.
7. **Honesty.** The instructions say that the threads are all it read and that it knows nothing of the
   rest: it never claims that a mail does not exist. When the threads do not answer, it says what it
   did find in them, names what was searched for (the queries are in its input), and suggests what
   to search next. A question that finds no thread at all ends with a fixed sentence that says what
   was searched for found nothing, not that the mailbox holds nothing.
8. **Progress and stop.** Each query that runs and each follow decision is an `agentTalkStep` event
   (`kind` `search` or `follow`); the talk pane lists them as secondary lines. Stop aborts at any
   point of the loop. The whole question gives up after 90 seconds.
9. **Ledger.** The summaries that go to a follow turn are counted per account, as the threads of the
   answer turn are (purpose `talk`, counts only). The demo runtime answers both new schemas.

## Consequences

- A question costs a plan turn, one or two follow turns on the cheaper model, and the answer turn:
  two to three extra short turns. For a clear question that finds good threads at once, the follow
  turn is the only addition. The person's plan limits drive it as before; none of it runs without a
  yes.
- More of the person's mail text leaves the machine than before: up to 300 characters of the best
  message of up to 60 threads per follow turn, to the same runtime and plan. The footer of an answer
  says so. Nothing leaves while AI is off or an account has no consent; consent is checked in the
  index query and again on every thread.
- The agent's recall no longer depends on how recent a mention is. It does depend on the plan's
  wording, on the model's judgment of the summaries, and on three rounds; a hard question can still
  end with "not found in the threads I read", which is the honest answer.
- Tuning is open: the weights, the recency constant, the cap of three, the six queries, and the 300
  characters are starting values to be judged on real questions.
- A second migration to carry (38) and a new port (`RankedSearchPort`) are the only changes to
  storage and to core's ports. The person's search bar, its ordering and its word semantics are
  untouched.
