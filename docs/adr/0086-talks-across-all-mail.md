# 0086. Talks across all mail

- Status: Accepted
- Date: 2026-11-09
- Amends: [0064](0064-one-prompt-for-a-thread-or-all-mail.md) (rule 2: one talk for all mail), [0069](0069-the-agent-has-its-own-column.md) (rule 4: the header of the column)
- Builds on: [0051](0051-agents-on-the-users-own-plans.md), [0081](0081-finding-what-the-question-means.md)

## Context

ADR 0064 gave every thread its own talk and all mail exactly one. A talk about a thread ends where the
thread does. The talk of all mail has no end: every question the person ever asked across their mail is
appended to one column, so after a few days it is one long scroll of unrelated questions. The owner
finds it a mess.

It also costs the agent. An all-mail turn reads the latest 200 entries (`MAX_TALK_SHOWN`) and sends the
newest of them, up to `MAX_TALK_HISTORY_ENTRIES` and `MAX_TALK_HISTORY_CHARS`, to the plan turn,
whatever they were about. ADR 0081 added `followsUp` so the model can say the new question does not
continue the old one, because anchoring on an earlier topic was the first failure on the real mailbox.
The model still has to guess where one question ends and the next begins, and every turn pays for the
earlier text.

Endless scrolling upward was considered. It solves how much the column renders, not the mixing: the
questions stay in one stream and the model keeps guessing. Within one talk it is still useful.

## Decision

1. **Talks in all mail.** The scope `All mail` holds any number of talks. One is open at a time. A new
   talk starts empty; nothing from another talk is sent with its turns, and it carries no state (`carry`)
   from another talk. Within a talk, `followsUp` works as in ADR 0081.
2. **A thread keeps one talk.** `This thread` is unchanged: the thread is the boundary of its talk.
3. **Starting a talk.** A `New talk` button in the column's header, beside the scope control, while `All
   mail` is chosen, and `⇧⌘J`, which also switches to `All mail` and opens a hidden column (ADR 0069, rule
   5). The cursor goes to the prompt. While the open talk is empty, both do nothing: there is never more
   than one empty talk. A question sent from the search panel to the agent (its ask row or `⌘↵`, ADR 0076)
   starts a new talk.
4. **After a pause, a new talk.** When the open talk's last entry is older than 2 hours, the next question
   in `All mail` starts a new talk. The old talk stays in the list. Opening an old talk from the list and
   asking in it continues that talk, however old it is.
5. **The list of talks.** A control in the header, at the left of `New talk`, names the open talk and
   opens a list of the others, newest first, grouped `Today`, `Yesterday`, `This week` and `Earlier`. A
   row shows the title and the time of its last entry. The list is read locally and opens without a model
   (ADR 0064, rule 13).
6. **A cheap model names the talk.** After the first answer in a talk lands, one `P3` turn asks the model
   of `models.titles` for a short name of what the talk is about: at most 6 words, in the language of the
   question. It gets only the person's own words of that talk (its first three questions), as untrusted
   text, never mail, answers or quotes, so no summary of mail leaves the machine for it. The answer is
   checked by a schema and cut at 60 characters; anything else is dropped. The turn counts toward the
   plan like any other. It adds no line to the ledger, as the plan turn does not: the ledger counts
   mail sent per account, and none is.
7. **The first question is the fallback.** Until the model has named the talk, and whenever it does not
   (titles off, the plan at its limit for `P3`, a failure, a refused answer), the talk is named by the
   person's first words in it, cut at 60 characters on a word boundary. A talk whose turn could not run is
   tried once more after its next answer, never in a loop. A talk with no name from the model is never
   worse off than with one.
8. **Titles in Settings.** The agent's models in Settings get one more row, `Talk titles`, with the same
   choices as the others plus `Off`, as drafts ahead have. The default is `haiku`. `Off` names every talk
   by its first question and sends nothing.
9. **Renaming.** A row's menu has `Rename`. A name the person gave is never replaced by the model.
10. **Deleting one talk.** A row's menu has `Delete talk…`. It asks once, because it cannot be undone, and
    removes the talk and its entries from the local store. A turn running in it is stopped first. When the
    open talk is deleted, an empty new talk opens.
11. **Deleting all talks.** The foot of the list has `Delete all talks…`. It names how many talks it
    removes, asks once, stops a running turn and leaves one empty talk. It removes the talks of `All mail`
    only; the talks of threads stay with their threads.
12. **Neither removes anything else.** Rules, instructions, drafts, the journal and the ledger stay: they
    record what was done and what left the machine, not the words of the talk.
13. **Older entries load upward.** A talk shows its latest 200 entries. Scrolling to the top loads the 200
    before them, keeping the reading position. This is the only endless scroll, and it is per talk.
14. **Storage.** A table `agent_talks` (`id`, `started_at_ms`, `last_at_ms`, `title`, `title_by`: `first`,
    `model` or `person`) and a column `talk_id` in `agent_talk`. Entries of a thread have no `talk_id`:
    the thread is their talk. The open talk of all mail is kept for the next launch, as the scope is.
15. **The old stream is cut, not dropped.** The migration splits the existing entries of all mail into
    talks wherever two entries are more than 2 hours apart (rule 4), titles each by its first question
    (rule 7), and opens the newest. The model names old talks only when one is opened. Nothing is deleted.
16. **Running turns.** A turn belongs to the talk it was asked in. Moving to another talk does not stop
    it; its answer lands in its own talk, and the list marks a talk whose turn is running. One turn across
    all mail runs at a time, as now.

## Consequences

- The column shows one question and what followed from it, and a new question starts clean. The
  anchoring of ADR 0081 has a boundary the model no longer has to guess, and turns early in a talk send
  less earlier text.
- A question that does continue an old one after a pause has to be asked in that talk, from the list.
  If the owner finds 2 hours too short or too long, rule 4 is the one number to change.
- A talk gets a name that says what it is about, for the cost of one small turn of the cheapest
  model, at the lowest priority. The person's words go out for it, which they already did for the
  answer; mail does not. With titles off or the plan at its limit, names fall back to the first
  question and are sometimes poor ("and the other one?"); `Rename` covers that.
- Deleting is final, and only local: what was sent to a model for a turn cannot be called back, and
  the ledger keeps saying it was sent.
- The agent's journal and the ledger do not change: they record what was done and what left the
  machine, not which talk asked for it.
- Search across old talks is left for later.
