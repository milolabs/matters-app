# 0052. Things that matter

- Status: Accepted
- Date: 2026-11-05
- Amended by: [0066](0066-what-you-would-regret-not-seeing.md) (what may become a thing, with the reading of what a thread asks of the person)
- Amended by: [0069](0069-the-agent-has-its-own-column.md) (the plans sit in the agent's column, and `Write the draft` is in the agent colour, not black)
- Amended by: [0112](0112-what-you-answered-waits-for-its-reading.md) (rule 9: a reply takes the thing out until the thread is read again; that reading decides)
- Amended by: [0111](0111-bulk-mail-says-so-at-its-foot.md) (a mailing's footer in the text also makes a message `automated`; stored mail is read for it once)
- Amended by: [0115](0115-every-window-hears-a-changed-status.md) (a push says when the status itself changed; a window reads it then, however fresh its copy)

## Context

A person with 180k messages does not get value from statistics or from tags on old mail. They get it
when the app quotes their own promise back to them with the reply ready. The owner chose proactivity
over analysis: read a recent window by default, and let the assistant search the rest on demand.

Analysing all of 180k messages would take on the order of 140 million input tokens. That does not fit
a plan's limits, and it would send a whole mailbox's history away for little gain.

## Decision

1. **A view, the first tab.** `Matters` sits before `All mail` and opens by default once AI is on.
   Without AI the app opens as it does today. It uses the toolbar, the query bar, the 380 px list, the
   68 px rows and the reading column of the rest of the app.
2. **The unit is a thread.** An analysis is stored under `(threadId, lastMessageKey, analyzerVersion)`.
   Nothing new in a thread means no new call.
3. **A window of 30 days, editable.** Reading back is part of turning AI on, and the window is a
   setting. It selects threads with activity in the window and reads their earlier messages for
   context. Reading goes newest first and shows results as they arrive. Older mail stays searchable
   locally; a promise older than the window with no activity is knowingly missed.
4. **A local filter first.** A message with `List-Unsubscribe`, `List-Id`, `Auto-Submitted` other than
   `no`, or `Precedence: bulk|list|junk` is `automated` and never goes to a model. The parser records
   this on new mail. Mail stored before the field exists counts as not automated until a re-parse; a
   no-reply sender address also counts as automated.
5. **Analysis gives facts, code gives order.** The model returns the thread's state, promises, asks
   and dates, each with a quote and the message it comes from. `rankThings` scores these by lateness,
   an explicit date, the person's own word, money or contract terms, and the person's feedback. The
   same facts always give the same order, so "why it's here" can be derived and shown.
6. **Few things.** (Amended by ADR 0055: all of them show, and the 7 now bounds drafting ahead.) At
   most 7 show. Drafts are prepared only for what shows, which also bounds their
   cost. A low-confidence analysis does not show: a wrong first item costs more trust than a missed one.
7. **A draft or a question.** Preparing a thing gives either a draft or what is missing with up to
   three directions. The model never guesses a fact.
8. **Sending is the existing path.** `Send` hands the text to the outbox with its undo window
   (ADR 0020). `Edit myself` opens the existing composer on the same draft, and the person owns it
   from there.
9. **Feedback.** `Not important` hides the thing and lowers the score of later things from that sender.
   `Later` hides it until the next morning. A reply sent by any means closes it.
10. **Agent or person, visibly.** Everything an agent made is one layer: a violet token (`--agent`,
    `--agent-soft`, `--agent-edge`, in both themes), a dashed edge and the open ring. The white sheet
    inside a draft is what would go out, and words the person gave are underlined. Mail from people
    keeps its solid hairline. Taking over turns the frame solid.
11. **The status of the plans sits at the bottom of the reading column.** Its model and its windows
    are one line there, expanding to session and week. The prompt above it is not part of this work
    and comes later; the line keeps its place so that nothing moves when it arrives. The list's footer
    stays about accounts and sync. Settings has an `Agents` section with the same facts and the choice
    of model per kind of work.

## Consequences

- `Message` gains an `automated` flag, and the store gains tables for analyses, feedback and the ledger.
- One accent joins `--late` and `--good`. It must only ever mean "an agent made this".
- The list can be empty for a while after turning AI on. It must say that it is reading, and how far.
- Ranking weights are a judgment to be tuned on real use.
- Searching the whole history from a question needs the prompt, and the agent's search tool needs a
  local MCP server. Both are later work.
