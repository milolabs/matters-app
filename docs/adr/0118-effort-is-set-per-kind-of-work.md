# 0118. Effort is set per kind of work

- Status: Accepted
- Date: 2026-11-11
- Amends: [0051](0051-agents-on-the-users-own-plans.md) (rule 6: what the person sets for each
  kind of work)
- Builds on: [0116](0116-a-prompt-is-a-filter.md), [0117](0117-matters-is-a-view-with-a-prompt.md)
- Amended by: [0119](0119-a-runtime-on-this-machine.md) (rule 4: the levels can differ by model)

## Context

A runtime can be told how hard to think. The port already carries that as `effort`, and the
adapter passes it on. Which level a turn gets was decided in code, turn by turn: a few turns ask
for `low`, and the rest say nothing and get the runtime's own default. The turn that reads
threads for a prompt says nothing, and since ADR 0117 it is most of what runs on the person's
plan.

Effort changes both the answer and what it costs, as the model does. The person chooses the
model for each kind of work; they could not choose this. The port also knew three levels where
the runtime we ship takes five.

## Decision

1. **Effort is a setting beside the model, per kind of work.** The kinds are the ones that have
   a model: understanding mail, writing when asked, questions about mail, and talk titles. Every
   turn that runs on a kind's model runs with that kind's effort.
2. **Values.** `default`, `low`, `medium`, `high`, `xhigh`, `max`. `default` sends nothing, so
   the runtime decides.
3. **Starting values.** Understanding mail and talk titles start at `low`; writing and questions
   start at `default`. For reading threads for a prompt this is a change: it ran at the
   runtime's default before.
4. **A runtime says which levels it takes.** It lists them with what else it reports about
   itself. Settings offer only those, and none when the list is empty. A stored level the chosen
   runtime does not list is sent as `default`.
5. **A level a model refuses is said, not dropped.** The turn fails, and where a failed turn is
   already shown it names the model and the level and points to Settings. The words are ours:
   what a runtime writes never reaches the person as text. We do not retry with another level.
6. **Turns that are not a kind of work stay as they are.** The test that marks a runtime ready
   and remembering what the person said run at `low`.
7. **The ledger says the effort of each turn**, so use of the plan can be read against it. A
   line from before this has none.
8. **Stored settings from before** read as the starting values.

Not in this decision: effort per view or per prompt, and choosing a level from what a turn
holds.

## Consequences

- Reading for prompts costs less by default. Whether verdicts at `low` are as good as at the
  runtime's default was not measured before this was decided; a person who finds them worse can
  raise it.
- A high level on background reading can use a plan's week much faster. The share of the week
  that background work may use (ADR 0051, rule 7) still bounds it.
- A runtime that takes no effort shows one control fewer, and nothing else changes for it.
