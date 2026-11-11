# 0112. What you answered waits for its reading

- Status: Accepted
- Date: 2026-11-10
- Amends: [0052](0052-things-that-matter.md) (rule 9: what a reply does to its thing),
  [0109](0109-the-badge-counts-what-is-in-matters.md) (consequences: the Dock and the tab after
  *Send*)
- Amended by: [0115](0115-every-window-hears-a-changed-status.md) (rule 5: a push for a request that changed the agent's status says so)

## Context

- **A thread with a newer message keeps its thing.** The list kept the old reading and marked the
  row `updating` until the agent read the thread again, so that a thing does not vanish while its
  new reading comes. It did this for every newer message, the person's own reply too.
- **The window hid it anyway.** After *Send* in Matters the window hid the row in a set of its own.
  The set let an id go only once the backend stopped listing it. When the new reading still put
  the thing on the person, or when no reading came (paused, out of plan), that window hid it until
  it was reloaded. Its tab said one less than the Dock (ADR 0109), and a second window or a reload
  showed the thing again although the person had just answered it.
- **Two other ways the set outlived the truth.** A move to Trash or Spam undone from the tray left
  the row hidden, since nothing took the id out of the set. A sender rule made with *Not like
  this…* hides a thread only when it covers every other sender (ADR 0054); in a thread with someone
  else in it the backend kept listing it, and the window kept hiding it.
- **The reply is not in its thread for a while.** *Send* puts it in the outbox with a 10 s undo
  window (ADR 0020); then it is sent, and its Sent copy is recorded in the thread up to 1.5 s later
  (ADR 0092). Until then only the outbox knows that the person answered.
- ADR 0052, rule 9 already said that a reply closes its thing. The old rule kept the other half of
  it right: the reply may be "I will look at it tomorrow", so only a new reading can say that
  nothing is owed.

## Decision

1. **What the person answered is not listed until it is read again.** A thing whose thread's
   newest message (by date) is the person's own, and newer than the message it was read from, is
   not listed, not counted, not drafted ahead and not said (`answeredSinceReading`). When the agent
   has read the thread again, that reading decides, as for any thread: it shows again if it is
   still on the person. A newer message from anyone else keeps the thing listed and `updating`, as
   before; one from someone else after the person's answer does too.
2. **A reply in the outbox counts as an answer.** A send that is pending, held, running, of
   unknown outcome, or sent while its draft is still there (its copy not yet in the thread) takes
   its thread's thing out in the same way (`answeringThreads`). An undone, failed or voided send
   brings it back. The read is of the few sends the outbox shows, with their drafts, not of mail.
3. **One bar for every reader.** The list, its `total` (the tab and the Dock), what a closing
   covers, what is drafted ahead and the thread's own reading (`shownReading` for notifications,
   ADR 0106, and the banner in a thread, ADR 0063) all apply rules 1 and 2. The last two already
   showed only a reading of the thread's newest message, which covers rule 1.
4. **The window's hiding is a bridge the backend confirms.** A row the person dealt with is hidden
   at once and stays hidden only until the first read of the list asked after the backend recorded
   what makes it leave. That read decides: if the backend still lists it, it shows again. A read
   asked before that moment, still on its way, does not bring it back.

   | What the person did | What the backend holds when the action returns | The bridge ends |
   |---|---|---|
   | *Send* (button, ⌘↵) | the send in the outbox (rule 2), then the reply in the thread (rule 1) | at once |
   | *Not important*, *Later*, *No reply needed*, a closing that says what it meant, one or a group | the feedback, at the analysis's message | when the write returns; a refused one comes back |
   | A closing from the person's words (*Prepare*, the talk) | the closing, written before the answer | at once |
   | *Not like this…* | the rule | at once; the backend decides whether the rule covers the thread |
   | Delete, Spam (a thing's menu) | the move, committed locally (ADR 0044, rule 8) | when the move returns; an undo of the move brings it back |

5. **Windows hear what changed without the agent.** A change of the outbox makes every window read
   the list again and the badge count at once. A count after mail commits (at most once per 5 s,
   ADR 0109) that differs from the last one tells the windows too, so a reply sent from another app
   or mail that left leaves every tab with the Dock. After an agent write they read it already.

## Consequences

- The Dock, the Matters tab of every window and a reload say the same number once the list has
  caught up: at once after *Send*, an action the agent records or a move in this window; within
  about 5 s after mail from elsewhere, while the badge counts what is in Matters.
- A reply that leaves the person still owing something takes the thing out until the agent has
  read the thread; then it comes back, as a new row. While reading is paused or the plan is spent,
  it stays out.
- A thing no longer reappears in another window or after a reload while its reply is in the outbox,
  and comes back everywhere when the send is undone or fails.
- A thread the sender rule does not cover now comes back after *Not like this…* with the line
  saying what was kept. That is what the rule does; hiding it was the window's alone.
- When the Sent copy cannot be recorded (the send's warning says so), the draft is gone and the
  thread does not yet show the reply: the thing shows until the copy comes with the next sync.
- With the badge on another source, a window catches up with mail from elsewhere at the next agent
  write, as before.
- Each read of the list, and of a thread's reading, also reads the sends the outbox shows (those of
  the last 10 minutes) and their drafts: a few rows. Nothing is read per mail commit beyond the
  count of ADR 0109; a window reads the list again only when that count changed.
