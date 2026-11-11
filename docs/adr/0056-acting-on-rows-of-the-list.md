# 0056. Acting on rows of the list

- Status: Superseded by [0117](0117-matters-is-a-view-with-a-prompt.md)
- Date: 2026-11-05

## Context

Every action on mail worked on the thread in the reader, so clearing away several messages meant
opening each one. Matters had fewer ways still: its keys were swallowed because they would have acted
on a row of a list nobody could see. Its search did not exist at all: text in the bar left Matters for
All mail, which is the opposite of what the bar promises everywhere else (ADR 0026, 0052 rule 1).

## Decision

1. **The bar searches the view it is over, Matters included.** Text in the bar no longer leaves
   Matters. The heading says `Results`, an empty answer says `Nothing found.`, and the reader then
   stays empty, because how far the reading is does not answer what was asked. A search of Matters
   cannot be saved: a saved view is a query over mail.
2. **Matters searches with the real index.** The same query language as the mailbox, answered by
   intersecting the search with the threads of the things, in their ranked order. The walk ends at the
   oldest message of those threads, so a common word costs what those threads span and not what the
   mailbox holds. Nothing here goes to a model.
3. **Several rows can be chosen.** ⌘-click joins or leaves, ⇧-click and ⇧ with an arrow make a range,
   ⌘A takes what the list has loaded, Esc lets go. The reader then shows the chosen threads as a stack
   of their letters, each showing who and what, so that what is about to happen can be checked. The
   actions stand above the stack and do not move as it grows. A stack is nobody reading: no thread is
   marked read under it (ADR 0039). A sheet opens alone on a click, and leaves the group on its ×.
4. **Every row has a menu.** The right button acts on the row under it without opening it, so nothing
   is read by accident; on a chosen row it acts on the whole group. One row offers reply, reply all and
   forward, read or unread, the moves, and `Show mail from` the sender. A group offers only what fits
   several. The menu names the key that does the same.
5. **Matters adds its own words to the menu.** `No reply needed`, `Later` and `Not important`, for one
   thing or several, with one line and one Undo in the tray. A rule is offered only after closing one
   thing, because a rule is about one sender. Delete and spam take the thing off the list because its
   mail is gone; archive and move leave it, because it is still on the person. **Send is never offered
   for several:** each draft is read before it goes (ADR 0052, rule 8).
6. **Moving several threads is one action.** `moveThread` takes further threads and gives them one
   action id in one unit of work, so the tray has one line and ⌘Z takes all of it back. A folder belongs
   to an account, so `Move to…` is off for a group across accounts.

## Consequences

- `agentThings` takes a query. With one it reads every thing before cutting a page, which is what the
  first read of a list did before ADR 0055 and stays a local read.
- Keys in Matters still do not move mail: `e` edits a draft there. The menu is the way.
- Rows of one thread can be chosen apart, but a move takes the whole thread, as it always has.

### Refinement, 2026-11-06: the search asks once, and says it is asking

The owner's search of Matters took seconds and nothing on screen moved. Measured on the owner's 197,000
messages, over 140 threads: `a` took 6.1 s and `f` 2.9 s. The list was not the cost. Walking the index down
to the oldest message of those threads meant about 40 windows, and each one ran the whole MATCH again. The
reader is synchronous, so every other read waited behind it, and each key pressed queued another walk.

1. **One question to the index.** `matchesAmong` names the messages of the things and asks which of them
   match, in one statement. This replaces rule 2's walk. The same query now takes 150 to 270 ms for `a`
   and single milliseconds for a word, with the same threads found.
2. **One search at a time.** While a search is out the renderer only remembers the newest text, and asks for
   it when the answer comes. The letters in between are never asked. Clearing the text does not wait.
3. **It says so.** Until the newest text is answered the bar says `Searching…` and the rows on screen fade,
   because they answer the text before. Both wait 150 ms, so a search that answers at once shows nothing.
   `Nothing found.` is said only once the answer is in.
