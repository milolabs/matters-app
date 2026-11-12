# 0121. A runtime for each kind of work

- Status: Accepted
- Date: 2026-11-12
- Amends: [0119](0119-a-runtime-on-this-machine.md) (rule 2: no single runtime is chosen; rule 3:
  what "never a fallback" means with several), [0051](0051-agents-on-the-users-own-plans.md)
  (rule 7: windows, shares and limits are kept per runtime)
- Builds on: [0118](0118-effort-is-set-per-kind-of-work.md), [0120](0120-codex-is-a-runtime.md)

## Context

ADR 0119 made runtimes a list and let the person choose one. Everything the agent does then
runs on that one: reading mail for a view, writing a draft, answering a question, naming a talk.

Those kinds of work do not want the same thing. Reading mail for a view is many small turns,
which a model on this machine does for nothing and without mail leaving it. A draft or a hard
question is one turn where the best model the person pays for is worth its cost. A person with
two plans also has two sets of windows, and one choice lets the second sit unused.

Model and effort are already set per kind of work (ADR 0118), and kept per runtime (ADR 0119,
rule 4). Consent is stored per account and runtime. The ledger names the runtime of each turn.
What is missing is only that the runtime, too, is chosen per kind.

## Decision

1. **Each kind of work has its own runtime.** The kinds are those of ADR 0118: understanding
   mail, writing, questions, talk titles. For each, the person chooses a runtime, then a model
   and an effort of that runtime. The same runtime can serve several kinds or all of them.
   There is no chosen runtime for the whole app any more.
2. **A runtime is in use when a kind names it.** Only runtimes in use are checked, tested and
   run. Every runtime the app knows is still listed in Settings with its state, so it can be
   connected before a kind is moved to it.
3. **Never a fallback, per kind.** A turn runs on the runtime of its kind and on no other. If
   that runtime cannot be used, that kind of work says why and waits; the other kinds go on.
   Nothing moves to another runtime by itself, and nothing is retried elsewhere.
4. **Consent follows the mail.** Mail of an account goes only to a runtime that account agreed
   to (ADR 0119, rule 2). So each turn works with the accounts that agreed to the runtime of
   its kind, and the others are left out of it, as accounts without consent are today. Moving
   a kind to a runtime asks the consent question for that runtime first, naming where the mail
   goes, of every account the agent works with that has not agreed to it. Settings also lists
   each account with a box for each runtime in use, where it can be agreed to or taken back. A runtime on this machine still asks: the
   question says the mail stays here.
5. **What a runtime remembers.** Each runtime keeps its model and effort for each kind (ADR
   0119, rule 4). Moving a kind to another runtime takes what that runtime has for the kind,
   or its starting values.
6. **Windows, shares and limits are per runtime.** Each runtime with a plan has its own
   windows, its own count of what we used, and the gates of ADR 0051, rule 7 are asked of the
   runtime the turn runs on. A runtime with no plan has none, as before. The share of the week
   that background work may use is one setting, applied to each plan by itself. Settings shows
   the windows of every runtime in use.
7. **Turns at once are per runtime**, so work on one does not wait for a free place on another.
8. **A talk can change its runtime.** The model choice of a talk lists the models of every
   runtime that is ready and has consent for the mail in question, grouped by runtime. A talk
   about all mail starts at the choice for questions, a talk in a thread at the choice for
   writing. Choosing there changes that talk only, and is kept while the app runs: it is not
   stored with the talk in this step.
8a. **One turn of work stays on one runtime.** A question plans, searches and answers on the
   runtime for questions; where its steps use a lighter model, that is the model the same
   runtime keeps for understanding mail. A prompt searches and reads on the runtime for
   understanding mail. So one piece of work has one place its mail goes and one set of
   accounts.
9. **Reading in the background** runs on the runtime for understanding mail. `Pause reading`
   stays one switch. A refusal for a limit that pauses the reading (ADR 0120, rule 9) pauses
   it as before.
10. **What is stored for one runtime is not redone for another.** A verdict, a kept search or
    a title was made from the person's mail and is kept on this machine; changing the runtime
    of a kind does not throw it away or make it again. New work is done by the new runtime.
11. **The ledger and the journal** name the runtime of each turn, as they do.
12. **Starting values and stored settings.** Until the person chooses otherwise, every kind is
    on the first runtime they connect. Settings stored with one chosen runtime read as every
    kind on that runtime, with its models and efforts.
13. **AI on and off stays one switch.** Off, nothing runs on any runtime.

Not in this decision: sending one turn to several models to compare them; a runtime per saved
view or per account; choosing a runtime by cost or load; any automatic change of runtime.

## Consequences

- A person can read mail for views on this machine and write on a plan, or spread work over
  two plans. The cost is one more choice per kind, which starts filled in.
- Mail can now go to more than one place in one session. Consent per account and runtime is
  what bounds that, and the consent question appears where a kind is moved, not only at first
  run.
- An account that agreed to one runtime and not another is read for some kinds and not for
  others. A view can then show verdicts for mail that a question will not see. Settings has to
  say plainly which account goes where.
- Each runtime in use needs its own test before it is ready, so several are tested, each
  costing a turn where the runtime has a plan.
- Verdicts for one prompt can come from different models over time. They are not marked by
  model in the list; the ledger has it.
- More states to show: one kind waiting on a runtime that is not ready while others work.
