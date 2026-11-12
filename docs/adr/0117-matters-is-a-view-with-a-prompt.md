# 0117. Matters is a view with a prompt

- Status: Accepted
- Date: 2026-11-11
- Supersedes: [0052](0052-things-that-matter.md) and what was built on its list
  ([0053](0053-reading-that-shows-itself.md) to [0062](0062-the-list-holds-still-after-you-act.md),
  [0065](0065-a-closing-covers-only-its-own-ask.md) to
  [0068](0068-who-writes-what-you-refuse-what-comes-from-an-office.md),
  [0075](0075-promises-under-the-message.md),
  [0109](0109-the-badge-counts-what-is-in-matters.md))
- Amends: [0063](0063-the-agent-in-ordinary-threads.md) (no stored reading in a thread),
  [0116](0116-a-prompt-is-a-filter.md) (rules 3 and 10: reading in the background, a
  badge), [0071](0071-notifications.md) (what the badge counts, the notice kind for the agent's
  list), [0078](0078-the-sender-leads.md) (the sender header went with the reader),
  [0079](0079-a-sender-that-failed-and-matters-leads-with-the-sender.md) (its reader is gone; the
  warning on a sender that failed stays)
- Builds on: [0027](0027-saved-views.md), [0051](0051-agents-on-the-users-own-plans.md),
  [0093](0093-a-tab-number-is-always-unread.md)

## Context

The `Matters` tab is one question we wrote, with a ranking in code whose weights were tuned on
one person's mail (ADR 0066 to 0068). ADR 0116 made a prompt a term of the query, so a person can
write their own question and keep it as a tab. Tried on a copy of a real mailbox, a view with a
prompt listed what was asked for and nothing automated, and coming back to it cost no model call.

Keeping both means two readings of the same mail on the person's plan, two lists that answer the
same question differently, and a built-in tab nobody can edit in a client whose point is that the
person's own words drive the model. The built-in tab did four things a view with a prompt did
not: it read new mail in the background, showed a number, fed the dock badge and sent
notifications. Those are what a view has to gain before the tab can go.

## Decision

1. **There is no built-in `Matters` tab.** Its list, its ranking (`rankThings`), bundles and the
   map, the actions on its rows, drafts written ahead for its top rows, and the pass that read
   every thread of a window of days into facts are removed. With that pass go what it alone
   produced: the stored reading shown in an ordinary thread (ADR 0063) and the promise lines
   under a message (ADR 0075), and its settings (how many days to read, the question before
   the first reading, the model for drafts ahead). The name of the product stays.
2. **A starter view takes its place.** The first time AI is on with an account that has consent,
   a view named `Needs you` is added in front of the others, with the text
   `after:-30d prompt:"mail that needs my reply or decision"`. It is added once and recorded as
   added: renamed, edited or deleted, it is the person's, and it is not added again. It is an
   ordinary saved view (ADR 0027) with nothing built in. While the person has not chosen a tab
   or typed, the app opens on it, as it did on `Matters`.
2a. **An opened view shows only what fits its prompt.** From the moment a view with a prompt
   is opened, at launch too, its list is the prompt's rows: empty while they are fetched or
   while its first search runs, never the mail filters' result. A tab named for a prompt that
   lists mail the prompt did not keep says something untrue. Text typed in the bar is not a
   view yet and still shows the filters' result until it is run (ADR 0116, rule 2).
3. **A view with a prompt reads new mail in the background.** When a sync batch is applied, each
   saved view that holds a prompt, and that the person has run at least once, finds its new
   candidates on this machine with no model: the threads its mail filters match when the view
   reads those whole (ADR 0116, rule 4), otherwise the threads its kept searches match. Only
   threads with mail newer than the view's last reading and no verdict are sent; "newer" allows
   two days before that reading, so mail that arrives late or backdated is not missed. This is
   the reading of ADR 0116 with these differences:
   - It never searches with a model and never asks. A view the person has not run stays unread
     until they open it.
   - It is `P1` for mail of the last two days and `P3` for older (ADR 0051, rule 7), so it
     gives way to anything the person asks for. One pass reads at most `PROMPT_ASK_ABOVE`
     threads per view.
   - It obeys the same switches as the pass it replaces: AI on, consent, a runtime that is
     ready, the plan's limits, and `Pause reading`.
   - Ledger lines are `prompt`, as for a reading the person started.
   - It never runs beside a reading the person started for the same prompt. It does not start
     while one runs; one that starts waits for the turns already sent and keeps their verdicts,
     so no thread is sent twice.
   - A thread sent twice with no verdict back is left until it changes.
   - It also reads what a run of the person's left unread above the line of ADR 0116, rule 4,
     so a saved view is read to its end with no other `↵`. That is old mail, `P3`: on a plan
     it goes only while the plan's gates for background work let it, and waits otherwise. One
     pass takes at most `PROMPT_ASK_ABOVE` threads of a view, and the next follows by itself
     while threads are left and nothing was refused. (At first only mail newer than the
     view's last reading was read, and the rest waited for the person.)
   - On a runtime with no plan nothing is counted against the person, so one pass reads a
     view whole, and a run the person starts never stops to ask.
4. **A view with a prompt has a badge.** Its number is the unread threads among those it shows
   (fit 2 or 3 under its mail filters), counted from stored verdicts with no model. It means
   what every tab's number means (ADR 0093), counted in threads. A view never read shows none.
5. **The dock badge counts a view.** The badge source `matters` becomes `view`, with the id of
   the view it counts; it starts as the starter view. A stored `matters` reads as that. If the
   view is gone, or AI is off, the badge counts the inbox.
6. **Notifications come from views, as for any view.** The notice kind `matters` is removed. A
   view with a prompt can notify like any saved view (ADR 0071): mail that its filters match is
   held until the background reading gives its thread a verdict, and notifies if the thread
   fits. Mail whose thread is not a candidate, or whose verdict does not come within the hold,
   does not notify from that view. The hold is two days. One verdict settles every held
   message of its thread, and only the newest notifies. While AI is off such a view does not
   notify. A stored `kinds.matters` is ignored.
7. **What is kept.** Asking in a thread or across mail (ADR 0064, 0083), drafts on request,
   reply help, rules, instructions and the journal, the test that marks a runtime ready, and the shared
   parts the tab's code held (how a thread is rendered for a model, the checks on a quote, which
   threads are eligible).
   Two of the superseded decisions keep a part that lives outside the tab: closing a thread
   from a talk and what the agent remembers (ADR 0054), and the menus on rows of mail
   (ADR 0056). A runtime is tested, and the security corpus runs, with the verdict turn of
   ADR 0116 in place of the reading that is gone.
8. **Stored data.** Tables are left as they are; a schema that drops them is not part of this
   step. Nothing reads the rows that only the tab used.

## Consequences

- One mechanism reads mail for a list: a prompt. The weights, the facts and the code that scored
  them are gone, and so is the difference between our question and the person's.
- What the list shows depends on the wording of a prompt and on a search. The eval of ADR 0067
  no longer applies to anything that ships; a new one would compare prompts.
- `Done`, `Later`, closings on a row and drafts ahead are gone with the tab. A view with a
  prompt is a list of mail with the reason beside each row; acting on it is acting on mail.
- The background reading costs a verdict turn for every ten new candidate threads of every view
  with a prompt. Several such views read the same new mail several times, once per prompt.
- New mail that a view's kept searches do not match is not read for that view until the person
  runs `Search again`.
- Old installs keep rows in tables nothing reads until a later schema removes them.
