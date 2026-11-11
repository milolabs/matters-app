# 0069. The agent has its own column

- Status: Accepted
- Date: 2026-11-06
- Amends: [0052](0052-things-that-matter.md) (rules 10 and 11: where the plans sit, what is black), [0064](0064-one-prompt-for-a-thread-or-all-mail.md) (rules 1, 10 and 14, and the field of the agent's question)

## Context

ADR 0064 put a prompt and the plans line under the reader, and the talk in a pane beside it. The owner found the
chat overwhelming: two strips across the bottom, a pane at the right, a chip with a menu, a title, two small
buttons, filled boxes with white cards inside them, and a second field in the agent's question. The agent is a
place of its own, not a bar across the mail.

## Decision

1. **One column.** Everything of the agent is in one column at the right of the reader. Nothing stands under the
   reader: it has the full height. While AI is off, none of this shows.
2. **On by default, and it can be hidden.** The column is open unless the person hid it. Nothing stored, an old
   value or no storage at all mean open. One button in the top right corner of the window, a window with a
   panel at its right, opens and closes it. Opening puts the cursor in the prompt, closing gives the focus to the
   reader, and `g` also opens it. There is no second close button in the column and nothing stands in its place
   while it is closed. While it is closed and the plan is at its limit, a dot in the late colour on the button says
   so and its tooltip names it, so the status of the plan stays in reach (ADR 0052, rule 11). What was typed is
   kept in the talk and comes back.
3. **Prompt and plans at the foot of the column.** One box: the field, which grows to about six lines, and under
   it the model, a hint of the keys, the plan button and the round send button. The plans line has no input of
   its own and no other control. Its menus open upward. When the account was not shared, the box says so and
   offers `Settings…` instead of a field and a send button.
4. **What the agent looks at is in the header.** One control with `This thread` and `All mail ⌘J`. In All
   mail a quiet line names the accounts it searches. `⌘J`, `esc` and `g` do what they did.
5. **Every way to the prompt shows the column first.** `g`, `⌘J`, the header button, the strip under the thread's
   header, `Answer` and the button in the corner all open a hidden column before they put the cursor in the prompt.
6. **Width 300 to 640.** The person drags the line on the column's left edge, as they drag the list's. Dragging
   left widens. Double click, and `Enter` on the line, go back to 360, and a drag within 6 px of 360 lands on it.
   The arrows step 8 px, with `Shift` 40, and `Home` and `End` go to the ends. The width is kept for the next
   launch. The column is never wider than the window leaves room for: the list keeps 300 px and the reader 400 px
   (`max(360, min(640, window - 700))`). The chosen width is kept and comes back when the window grows. The list
   narrows for the column, but not under 300 px, and keeps 520 px of reading beside it (ADR 0064, rule 14).
7. **Under 1060 px it opens on request only.** There the column lies over the reader (ADR 0064, rule 14), so being
   open by default would cover the mail. In a window under 1060 px the column starts closed and shows only after
   the person asked for it. Opening or hiding it there does not change the kept choice. When the window grows to
   1060 px or more, the column follows the kept choice again.
8. **A tint for the agent's place.** `--agent-wash` is the column's ground and `--agent-line` its borders (the
   agent's edge colour mixed into the hairline). Like the other agent tokens they mean the agent's. There are no
   shadows or gradients beside the overlay's, and nothing else in the column has the soft fill.
9. **Answers have a dashed left edge only.** An answer of the agent has no box and no inner card: a dashed edge
   at its left, the line with the runtime, the model and `your plan`, the content, and the footnote of what left
   the machine (ADR 0064, rule 10). A dashed edge, the agent colour and the open ring still mean that an agent
   made this (ADR 0052, rule 10).
10. **One field for the agent's question.** The question keeps its words and its ways forward, and has no field of
    its own. With a way forward chosen, its button is `Write the draft`. With none chosen it is `Answer`, which
    shows the column and puts the cursor in the prompt. The open question goes with the next turn of the talk:
    when the thread has a prepared question, its text and ways forward are added to the turn as their own
    labelled part, with the data, never in the fixed instructions. A draft, a question or a closing from that turn
    replaces or ends the question as before. This settles the merge ADR 0064 left for later.
11. **Black sends mail.** `Write the draft` is in the agent colour. Black is for the button that sends mail
    (ADR 0052, rule 10).

## Consequences

- The reader is quieter and taller, and the agent is always at the same place. A narrow window pays for it: under
  1060 px the person asks for the column each time they open the app.
- A window of 1060 to 1340 px cannot give the column more than 360 to 640 px; a wide choice shows narrower there
  and is back when the window is wide.
- A reply typed in the prompt to the agent's question has the question with it. A draft from that turn replaces
  the question, as a draft from `Write the draft` does.
- `g` works only while a thread is open whose account was shared with the agent. The button works always.
- The segmented control replaces the menu of ADR 0064, so the scope is one press away and its state is read
  from the control, not from a chip's words.
