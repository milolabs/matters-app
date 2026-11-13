# 0131. The person sets the background limit, and the log leaves Settings

- Status: Accepted
- Date: 2026-11-13
- Amends: [0051](0051-agents-on-the-users-own-plans.md), rule 7 (the share of the week is the
  person's, any whole percent or no limit), [0054](0054-closing-in-the-persons-own-words.md),
  rule 6 (the log is no longer shown in Settings), [0121](0121-a-runtime-for-each-kind-of-work.md),
  rule 6 (the one share may be no limit)

## Context

Settings > Agents offered three shares of the week for background work: 5, 10 and 25%. A person
with a large plan they rarely use had no way to let the reading go further, and one who wanted
something between had to take the nearer step. The gate already takes any share from 0 to 100; only
the list was short.

The same section showed the local log as `What the agent did`, with Undo on its lines (ADR 0054,
rule 6). The section is long, and what can be taken back has a control of its own elsewhere: the
tray's Undo right after a closing, and Remove beside each rule and instruction in the rows above.

## Decision

1. **The log is not shown in Settings.** The `What the agent did` row goes. The log itself stays as
   it was: written in the same transaction as the feedback, undone in the same transaction that
   takes the feedback back, kept on this machine, never sent to a model, and its lines go with the
   thread. The request that reads it stays; the smoke run uses it.
2. **Undo from Settings goes with the view.** The tray's Undo after a closing or after something
   was remembered stays, with its eight seconds. A rule or an instruction is taken back with its
   own Remove in Settings.
3. **The person sets the share.** The background limit lists `Up to 5%`, `10%`, `25%` and `50% of
   my week`, `No limit`, and `Custom…`. `Custom…` opens a field for a whole percent from 1 to 99,
   filled with the current share; nothing is sent until it holds a valid number, on Enter or when
   it loses focus. A stored share that the list does not name shows as `Custom…`, with its number in
   the field. The default stays 10%.
4. **No limit is 100%** (`NO_WEEK_LIMIT_PERCENT`). At that share background work (`P1` to `P3`)
   has no share of the week and no ceiling: like `P0`, it stops only when a window is full, until
   that window's reset. It still never runs while the runtime bills overage, and `P2` and `P3`
   still wait while the windows are unknown. A share below 100 behaves as before: the ceilings of
   ADR 0051, rule 7 and the even share with the spare of the week.
5. **One setting for every plan**, as ADR 0121, rule 6 has it: no limit applies to each plan with
   limits by itself.

## Consequences

- With no limit, the reading can spend the whole of a quiet week, and the person's own asks then
  meet a full window. The hint under the choice says so: it runs until the plan's limit and waits
  for the reset, never on paid credits.
- What a closing was based on can no longer be read in the app. If people miss it, it comes back
  as a view of its own, not as a row in Settings; the data is there.
- The ceilings now apply only below 100%. A share of 99% still stops `P3` at a quarter of the
  session, so the step from 99 to no limit is large. That is what the person chose; the field and
  the list make both visible.
