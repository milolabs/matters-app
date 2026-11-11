# 0095. The reader says what a button does

- Status: Accepted
- Date: 2026-11-09
- Amends: [0066](0066-what-you-would-regret-not-seeing.md) (rule 8, the buttons of the reading column), [0068](0068-who-writes-what-you-refuse-what-comes-from-an-office.md) (rule 3, where `Not like this…` lives)

## Context

Read side by side with Apple Mail, the reader of Matters was the harder of the two to read. For a
reminder from an accounting office it showed:

- the sender four times: the head, the line under the title, the quoted letter and the thread;
- the first sentence of the mail as a quote, then the same sentence again in the mail below;
- the agent's why as a run of short sentences next to a separate "2 days late" line;
- four grey buttons of one weight (`Done`, `Later`, `Not important`, and `Not like this…` on a row of
  its own). The maintainer could not tell what any of them would do: whether `Done` replies, how
  long `Later` hides, whether `Not important` archives, and that `Not like this…` teaches the agent
  rather than acting on the mail.

Four layouts were drawn on the app's tokens. The maintainer chose the one that turns the agent's
part into a card with one clear answer.

## Decision

1. **One card for what the agent made of it.** Above the mail sits a card in the agent's colours,
   in this order: what the thing asks (`To do`, `To decide`, `Worth knowing`, `Needs a reply`,
   `Waiting on them`, `Needs you`), the why, the facts as chips (an amount, the end of an offer, a
   due date; lateness in the late colour), and the passage it was read from, at most three lines,
   with sender and date under it. The quoted letter with its own avatar and head is gone; the
   passage stays as evidence (0060).
2. **For a thing to decide, to do or to know, the answers sit in the card's footer.** One of them
   is the primary and is drawn solid: `I'll take it`, `Mark as done`, `Got it` (`Ignore` for a
   suspect sender). The others are plain.
3. **Every button says what it does.** A line under the buttons gives the consequence of the one
   the pointer or focus is on, and the primary's at rest: "Closes it. A new message opens it
   again.", "Hides it until tomorrow morning, then brings it back.", and so on. Where the buttons
   sit inside a draft or a question, the same words are their tooltips.
4. **`Later` is `Remind me tomorrow`,** because that is what it does. `Done` is `Mark as done`.
5. **`Not for me…` is one menu, last, quiet.** It holds `Not important` (with its consequence: it
   closes the thing and lowers the sender), then what `Not like this…` held: don't show this kind
   of mail, don't show mail from this sender, and the text box for the person's own words. The
   separate `Not like this…` row is gone. The menu is also on a reply that has nothing prepared yet.
6. A reply, a wait or a thing with no stated intent has no primary in this row: the draft's `Send`
   is the primary there. Its order becomes `No reply needed`, `Remind me tomorrow`, `Not for me…`.

## Consequences

- The person sees what is asked, by when, and which button ends it, before the mail, and the mail
  starts higher.
- Teaching the agent is one click further away. Watch whether `Not like this…` rules are made less
  often; if so, show the two rule choices beside the menu.
- `Remind me tomorrow` is still the only time. Choosing a time (this evening, next week) needs the
  backend to take a time instead of always the next morning.
- A checklist taken from the mail (the documents asked for, the last step) was part of the chosen
  layout. The reading has no such list yet; it would be a new field of the analysis.
- The why still says the due date in ISO form beside the chip that says it in words. Shortening
  the why is left to the reading's own wording.
