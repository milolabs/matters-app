# 0082. What the plan asks for is not put behind

- Status: Accepted
- Date: 2026-11-09
- Amends: [0080](0080-the-agent-follows-the-trail.md) (rule 5, the order for reading, and what is read)
- Builds on: [0081](0081-finding-what-the-question-means.md)

## Context

After 0081, the agent was measured on a wider set of questions on the copy of the owner's
mailbox: 20 questions with 83 expected threads. The questions covered:

- work and contracts;
- shops and parcels;
- travel;
- banks and their terms;
- subscriptions and invoices;
- public offices;
- sign-in notices;
- the talks with one person.

Two thirds of the expected threads (56) were sent by services, that is, by senders the person
barely writes to (fewer than five messages, or less than a tenth of what the sender sends). They
were 82 of the 96 targets lost in each arm of the first measurement.

Each lost target was traced through the pipeline on the twelve questions whose queries had been
examined (the split is below). Of 240 targets over six samples, 143 were lost:

- 57 were never searched: no query of the first round found them, so the plan failed.
- 53 were ranked low by fusion.
- 7 were never summarised.
- 26 were in the first 20 after fusion and were pushed out by the order for reading (0080 rule 5).

That order puts every thread written only by programs behind every thread of a person, and the
fourth thread of a company behind the rest. The plan had often written exactly the right query: a
`from:` naming the service, with the words of the topic. One such thread was first in that
query's list and eighth after fusion, and still was not among the 60 shown.

A question about a service's mail is answered by programs, and the order assumed the opposite.
0081 rule 8 already lifts the per-query cap for a query that names a sender, but the order for
reading did not.

## Decision

1. **A list asks for a sender** when its query requires one. That means every match must come
   from a sender the query names: a `from:` on every path of the query, outside a negation
   (`requiresSender`). `from:x`, `from:x words` and `from:x OR from:y` require a sender;
   `words OR from:x` does not.

   A thread of such a list is asked for when the search found in it a message the person did not
   send. So `from:me` asks for no one. The pool collects these threads as each query runs, so a
   list added from outside (the carry of the last question, a list of Matters) shifts nothing.

2. **A candidate is asked for** when any thread of its conversation is. In the order for reading
   it stands first, with the people within the cap, whoever wrote it. It is outside the cap and
   does not count toward it. A candidate that was not asked for is ordered as before.

3. **What is read.** Programs are normally dropped in two places: in the extra threads of the
   last round, and when the follow turn keeps nothing usable and the best ranked are read. In
   both places a candidate asked for is read like a person's, not dropped as a program.

4. **Nothing else changes.** These stay as they are:
   - the per-query score;
   - the fusion (k = 60);
   - the per-query cap (it still lifts on any `from:`, 0081 rule 8);
   - the cap of three.

## Measured

The method is the evaluation of 0081 (rule 12), applied to the wider set with three changes:

- "Today" is pinned to the newest mail of the copy.
- The plans are made once and cached: 120 of them, by the planner the app uses (the `understand`
  setting, at the app's default effort). Each question has three samples in two arms: the plan
  instructions as they are, and the same with a map of the mailbox (below).
- Each ranking variant is replayed on the same 120 plans, with no model call, through a copy of
  the pool with hooks. Before any variant ran, the copy gave exactly the pool's ranks (498 of 498).
  Once ported, the chosen rule gives exactly the copy's ranks again, and two runs give the same.

The rules for accepting a variant were fixed before the first one ran:

- the mean number of targets in the top 20 per sample rises by at least 2;
- no sample gets worse by more than 1;
- the targets sent by people do not drop;
- no question loses more than half a target per sample;
- the 8 held-out questions do not drop (the variants were designed on the other twelve, and the
  queries of the held-out eight were never examined);
- the code holds no domain, address or name from the evaluation;
- the ranking stage takes no more than 1.5 times as long;
- a fresh reviewer, given only the diff, finds no failure scenario left unanswered.

| variant (same 120 plans) | top 20, mean per sample (of 83) | top 60 |
|---|---|---|
| 0081 as it was | 51.0 | 64.8 |
| **asked for, not put behind** | **55.5** | **66.8** |
| programs never put behind | 51.2 | 63.0 |
| fusion with k = 10 / k = 20 | 51.7 / 51.2 | 64.7 / 64.5 |
| each list weighted by how specific its query is, `ln(N / matches) / ln N` | 50.3 | 63.0 |
| best place in any list first (round robin) | 50.8 | 63.5 |
| asked for, with k = 10 / k = 20 / the weights / best place | 55.2 / 56.2 / 54.7 / 54.0 | 66.8 / 66.8 / 65.2 / 66.7 |

**Per sample.** With the rule, the six samples gave 53, 54, 59 and 51, 62, 54 in the top 20.
Without it they gave 50, 50, 53 and 48, 53, 52. Over all samples, targets sent by people rose from
134 to 138, and targets sent by services from 172 to 195.

**Two forms of the rule.** The first form promoted every thread of a list with any `from:` and
counted promoted threads toward the cap. The review found four failure scenarios in it:

- threads that matched only the words of `words OR from:x`;
- `from:me`;
- a relayed envelope pushed behind promoted threads ranked below it;
- flags shifted by the carried list.

The rule above closes all four. Both forms give the same top 20 and top 60 in every sample. Ten
targets moved down by one or two places, and none of them crossed the 20th or the 60th place.

**Held-out and dev.** The held-out questions gained 0.17 per sample (209 to 210 of 258), and the
other twelve gained 4.33 (97 to 123 of 240). The held-out questions had less to win: only 26 of
their 258 targets were in a first-round list but outside the top 20, against 86 of 240 in the
other twelve. The rule won back all 26 losses of the order for reading in the twelve, so the
held-out losses are of another kind.

**Questions that lost.** Invoices lost 0.5 a sample, complaints 0.33, and offices and sign-in
notices 0.17 each, all inside the rules.

**Fusion.** k = 20 added 0.7 on top of the rule, which is inside the spread of the samples, so
`RRF_K` stays 60. In 0081, 15 and 30 also gave nothing.

**Time.** The ranking stage takes about 1 ms per plan, as before.

**The map.** In the second arm the plan turn also saw a map of the mailbox, about 3,700 tokens,
made on the computer from metadata only: the people and organizations the person writes with,
the senders of automated mail grouped by what they send, and the person's labels and saved
searches. The map:

- changed nothing in the top 20: 51.0 against 51.0 without the rule, and 55.7 against 55.3 with
  it;
- halved the spread of a target's place across samples, from a median of 4 places to 2;
- doubled the plan's input tokens (3.7k to 7.4k) and added about a second (median 10.6 s to
  11.6 s);
- sent the plan for subscriptions to payment processors.

It is not built in.

## Consequences

- A question about a service's mail now sees that mail when the plan names the service.
- A plan that names a flood sender, such as a job board, puts that sender's mail level with the
  people's, uncapped. The question asked for it, but it can push a person's conversation that only
  one list found at a low place beyond the 60 shown.
- The same holds for what is read. Two places normally drop programs: the extra threads of the
  last round, and the fallback when the follow turn keeps nothing usable. In both, the named
  sender's mail now fills the 20 threads read (`MAX_TALK_THREADS`) alongside people's mail, which
  used to fill them alone.
- `from:` matches a prefix of the sender's name or address, so `from:mark` also asks for a
  marketing sender. The query language already worked this way, and the per-query cap with it.
- The evaluation measures the first round, so what is read (rule 3) is pinned by tests only.
- Two failures remain, and they are most of what is left: a thread found by a single broad query
  at a middling place, and a thread no query of the first round found. Both are the work of the
  plan and the follow turns.
- The evaluation's questions, plans and scripts are about one person's mail and stay outside the
  repository. The method is recorded here and in 0081.
