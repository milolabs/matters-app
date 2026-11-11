# 0081. Finding what the question means

- Status: Accepted
- Date: 2026-11-08
- Amends: [0080](0080-the-agent-follows-the-trail.md) (the plan turn, the ranked search, the candidate list)
- Builds on: [0012](0012-performance-budgets.md), [0025](0025-query-language-and-plans.md), [0066](0066-who-the-sender-is-to-the-person.md)

## Context

After 0080 the agent still failed on the owner's real mailbox (about 200,000 messages in three
accounts) for broad questions such as "find the mail about my job change". An evaluation on a copy of
that mailbox (the tool below) showed five generic failures. None of them is about a name, a company
or a language.

1. **Anchoring.** When the talk before had been about one company, the plan turn built every trail
   from that company's names and never searched for the concept of the new question. A thread on
   another account, years older, was never asked for.
2. **Floods.** A broad concept query (`offer OR job offer`, `recruitment OR interview`) matches the
   mail of job boards, digests and seminar mailers by the thousand. The best 300 messages by bm25
   and the best 30 threads of a query were filled by a few bulk senders (one domain held 28 of the
   30), so conversations with people never reached fusion. The sender cap of 0080 acted only after
   fusion, too late.
3. **Unknown headers.** 45% of the stored messages have `automated` unknown (stored before the field
   existed). One job-board sender had 838 unknown and 3 automated messages. Marking mail by its
   headers alone cannot demote a flood.
4. **Inflection.** The search matches a word and the words that start with it. In Polish the forms
   differ at the end of the stem, so `umowa` does not find `umowy` or `umowę`, and `wypowiedzenie`
   does not find `wypowiedziałem`. The thread that was wanted was found only when the query listed
   the forms.
5. **Split conversations.** One conversation sat in nine thread ids of two or three messages each,
   beside an eighteen-message thread that held all of it. The fragments took the candidate slots.

Searching is cheap (16 to 130 ms a query at 300 messages), so fetching more is affordable.

## Decision

### The plan turn

1. **`followsUp`** (boolean) is part of the plan. When it is false, the earlier talk and the carried
   state are background only: the instructions say to take no name from them, to plan for the
   concept of the question across all time and all accounts, and that at least two trails contain
   no name taken from the earlier talk. The carry is still sent to the plan turn in both cases,
   but the trail seeds the threads of the last question among the candidates only when `followsUp`
   is true. A plan without the field (old tests, a model that left it out) is read as false.
2. **`time`** (`recent` or `any`) says whether newer mail is likelier the answer. A question about
   history ("every time", "all the mail about X", a job change) is `any`. A plan without the field
   is `recent`.
3. **Instructions** ask for the events a topic leaves in mail, not only its name (for a job change:
   recruitment and interviews, the offer, the contract and its signing, the resignation and the
   notice, onboarding, equipment, the farewell), in each likely language, and for OR-lists of word
   stems per event rather than an AND of two concepts. A name in the question gets a trail of its own
   with the topic's words, and one with the other names. No `has:attachment`, `in:sent` or `is:`
   filter unless the question asks for it. One trail may aim at signing and e-signature services,
   one at payroll and HR platforms, and one at the evidence such services send (a certificate, a
   confirmation); the model uses the names of services it is sure of, and the code has no list.

### The agent's words

4. **A light stemmer** (`core/domain/stem.ts`) is applied to each plain word of the agent's parsed
   queries (`core/usecases/stemQuery.ts`): the word is folded, and the longest of a list of Polish and
   English endings that leaves four characters or more is cut (five for `-ment`, `-ation`, `-ion`,
   `-ity`, so that `documents` does not become `docu`). Words of fewer than five characters and words
   with digits stay whole. The result is used as a prefix, so `umowa`, `umowy`, `umowę` become `umow`;
   `wypowiedzenie` becomes `wypowiedz`; `contracts` becomes `contract`; `agreement` becomes `agree`.
   Quoted phrases stay exact, and so do `from:`, `to:` and `cc:`. The ranked SQL is unchanged: a
   stem of four characters or more is expanded through `message_terms` into exact terms as before.
   The person's own search bar does not use the stemmer, and a test pins that.

### The ranked search and the flood

5. **Who wrote it.** `searchRanked` returns, per message, the sender address, whether the message is in
   the person's Sent mail, the `automated` verdict (absent when unknown) and the number of messages the
   people index holds for the sender. This costs two statements over the keys after the cut (1 to 4
   ms).
6. **The window is chosen after an adjustment.** The best `RANKED_MESSAGES = 1500` messages are taken
   by `bm25 + BULK_PENALTY` for mail the headers call automated and `bm25 - RELATIONSHIP_BOOST` for the
   person's own Sent mail, so a flood of programs cannot fill the window. `relevance` stays the plain
   bm25.
7. **Threads are scored per query** (`rankQueryThreads`):

   ```
   message = relevance - w(time) * ln(1 + ageDays / 30)       w(recent) = 0.7, w(any) = 0.1
   thread  = best message
             + HITS_WEIGHT * ln(matching messages of the thread)
             + RELATIONSHIP_BOOST * relationship
             - BULK_PENALTY      if every matching message is bulk and there is no relationship
             - STRANGER_PENALTY  if no header says person or program, and the relationship is under 1
   ```

   *relationship* is 1 when the person wrote a message of the thread or has written to the sender's
   address, and 0.5 when they have written to the sender's company and the message is not automated
   (`listWrittenTo` and `companiesWrittenTo`, cached for a minute). *bulk* is `automated = 1`, or
   `automated` unknown, no relationship, and the sender has `BULK_SENDER_MESSAGES` messages or more in
   the people index.
8. **Cap before the cut.** Each sender key (`senderKey`: the company, or the address at a shared
   domain) keeps its best `SENDER_CAP_PER_QUERY = 2` threads ahead of the rest; the person's own
   messages are not capped, and neither is a query that names a sender with `from:`. The threads
   beyond the cap follow in their order, so nothing is lost when there is room. Then the best
   `MAX_THREADS_PER_QUERY = 40` are kept.

### Candidates

9. **One conversation, one candidate** (`core/domain/conversation.ts`). Threads of one account with the
   same subject (folded, `Re:`, `Fwd:`, `Fw:`, `Odp:`, `PD:`, `AW:`, `WG:`, `Sv:`, `Vs:` stripped however
   often), and a shared participant other than the person (directly or through a third thread), are one
   conversation, represented by the thread with the most messages. The representative takes the place
   of its best-ranked fragment; the siblings are not shown and not counted against the limits. The
   summaries are made in steps of 40 threads until the conversations fill the list (at most 240).

### Mail relayed by a service (and a vocabulary that was tried)

10. **Reply-To stands for the sender of relayed mail.** E-signature envelopes, payroll and HR
    platforms and comments on shared documents come from the service's address, with the person they
    are sent for in Reply-To (and "Name via Service" as the display name). Seen as the service, every
    such message was a stranger, and the cap of two per query cut all envelopes of a service
    together. `effectiveSender` takes the first Reply-To address instead of From when it differs from
    From, the sender authentication did not fail, and either the person has written to that address
    or its company, or it is at another company than From. It then decides the relationship, the
    sender key of the per-query cap and of `orderCandidates`, and the sender of the candidate summary
    ("Name (via service.example)", so the service stays visible). A Reply-To never raises a message
    whose authentication failed. The ranked search returns the Reply-To address and the
    authentication verdict for this.
11. **A concept vocabulary was tried and removed.** The plan carried up to 40 words and two-word
    phrases for the topic, which code turned into one OR query of words only (no field or operator
    could pass through it) and ran in the first round as its own list. Three independent samples of
    plans gave 6/11, 6/11 and 7/11 targets in the top 20 and 8/11, 7/11 and 7/11 in the top 60,
    against 7/11 and 8/11 without it: inside the spread of the planner, no gain. In a long OR a
    message that matches two of forty words scores below the many that match several, so the
    thread it was meant to lift stayed outside the window. It cost 0.4 to 0.8 s per question,
    because bm25 is computed for every message that matches any of its words, against a median of
    about 25 ms for the other queries. A top-4 guarantee per list in fusion was also tried and gave
    nothing. A plan that still holds a `vocabulary` key (an old cache) is read and the key ignored.

### The evaluation tool

12. **`tools/eval-talk-search.ts`** runs the first round of the real pipeline on a copy of a mailbox
    and prints, for each question, where the expected threads land. The pipeline (rounds, fusion,
    summaries, order) lives in `apps/desktop/src/backend/trailPool.ts`; the backend's trail and the
    tool share it. How to run it on one's own mailbox:

    ```
    cp ~/…/matters.db /somewhere/snap.db          # a copy: the tool opens it read-only
    ELECTRON_RUN_AS_NODE=1 electron tools/eval-talk-search.ts \
      --db /somewhere/snap.db --questions q.json --plans plans.json --warm
    ```

    `q.json` is `{"questions":[{"id","question","history":[{"role":"you"|"agent","text"}],
    "targets":[{"name","subjectLike"}]}]}`; a target is every thread whose subject matches the SQL
    `LIKE` pattern. Keep that file out of the repository: it is about one person's mail. The planner
    (Claude Code, model `haiku`) sees only the question and the history, never mail, and is called
    only when `plans.json` has no plan for this question, history and planner prompt. The tool runs
    one round, so no follow or answer turn exists and no mail goes to any model. Its output holds no
    text of mail: target names, ranks (`absent` when outside the 60 candidates), the queries the
    planner wrote with their hit counts and timings, the best position of the target in each query's
    own list, and the domains of the senders of the top ten. `--warm` runs each round once before
    the measured one.

## Measured

On the copy of the owner's mailbox (197,000 messages, three accounts), five questions with eleven
expected threads (a job change asked alone and after a talk about one company, "all company
contracts", an offer from a named person, one company's contract). The planner is a model, so a
change of its instructions changes its plans; the rows show the whole system at each step, with
plans made by the instructions of that step (steps G2 and G3 reuse the plans of G1).

| step | targets in the top 20 | in the top 60 |
|---|---|---|
| 0080 as it was | 6 / 11 | 6 / 11 |
| + `followsUp` and `time`, new plan instructions (G1) | 6 / 11 | 6 / 11 |
| + stems (G2, same plans) | 5 / 11 | 6 / 11 |
| + flood control, 1500 messages, conversations (G3, G5, same plans) | 5 / 11 | 7 / 11 |
| + event-minded plan instructions (G6), tuned constants | **7 / 11** | **8 / 11** |

Stems raised the number of hits of a query modestly (for example 93 to 182, 26 to 29, 102 to 143,
43 to 60 messages; most queries by 0 to 10%), which is their false-positive and recall cost on this
mailbox. `umow*` also matches `umówmy`; a stem is a prefix of more words than its forms.

Search time on the copy, per query at 1500 messages including the sender facts, warm: median 12 ms,
p95 55 to 80 ms, max 255 ms (a query whose stem of four letters has no expansion falls back to the
native prefix). The 100,000-message test, with 1500 messages, stems, the adjusted order and the
scoring, has a median of 11 ms and a p95 of 35 ms and keeps its budget of 50 ms.

What still fails, from the numbers: a thread that the plan has no word for. The one thread left
`absent` in every question is a signing-service notice whose only words are two English ones; no query
the planner wrote held them, and a different plan finds it. The one conversation that stays outside
the top 20 in the open question is found by a single query at a low position: nothing links it to the
other lists, and fusion favours threads several queries agree on. These are failures of the plan, not
of the engine; the follow turns exist for them.

## Tuned constants

| constant | value | place |
|---|---|---|
| `RANKED_MESSAGES` | 1500 (was 300) | core `talkTrail.ts` |
| `MAX_THREADS_PER_QUERY` | 40 (was 30) | |
| `RECENCY_WEIGHT` / `RECENCY_WEIGHT_ANY` | 0.7 / 0.1 | |
| `RELATIONSHIP_BOOST` | 6 (company: half) | |
| `BULK_PENALTY` | 10 | |
| `STRANGER_PENALTY` | 3 | |
| `BULK_SENDER_MESSAGES` | 5 | |
| `HITS_WEIGHT` | 5 | |
| `SENDER_CAP_PER_QUERY` | 2 | |
| `RRF_K` | 60 (unchanged; 15 and 30 gave no better result) | |

The weights are starting values for a mailbox of one person, tuned on eleven threads: they are
judged again whenever the tool is run on a new mailbox. Relevance in this index is about 10 to 50 for
the top 1500 matches of a broad query, so 6 points is about one standard deviation.

## Consequences

- The agent's search is not the person's. The person's search bar, its ordering and its word
  semantics are untouched; the stemmer, the sender facts and the adjusted window exist only on the
  ranked path.
- The ranked search reads three more columns per match and two small statements; it fetches five times
  as many messages. The cost is measured above.
- More mail leaves the machine than in 0080 only through the follow turns' list, which is the same size;
  candidates are chosen better, not more of them.
- A plan from a model can still be wrong. The evaluation tool is the way to see it: run it before and
  after any change to the plan instructions or the weights.
