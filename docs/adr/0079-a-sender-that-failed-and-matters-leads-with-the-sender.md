# 0079. A sender that failed shows it, and Matters leads with the sender too

- Status: Accepted
- Date: 2026-11-08
- Amended by: [0117](0117-matters-is-a-view-with-a-prompt.md) (the reader of Matters is gone; the
  warning on a sender that failed stays)
- Builds on: [0048](0048-trusting-authentication-results.md), [0078](0078-the-sender-leads.md)

## Context

ADR 0078 put the sender at the top of the thread view, but the reader of the Matters view kept its
own header: the agent's headline and a line of names. The owner opened a thing there and could not
see who had sent it. The mail used a bank's name and logo, asked for action before a date "to avoid
a limit on the account", and hid words from filters with zero-width characters. Its address was the
one thing that could not be copied, and it was not on the screen.

ADR 0078 also showed nothing when the authentication result was a fail. A fail then looked the same
as no result, which is common and says nothing.

## Decision

1. **The Matters reader leads with the same sender header** as the thread view: the avatar, the
   name, the address with its relationship line, and the badge. Its reply, reply-all and forward
   buttons sit beside the name, as the thread view's actions do. The agent's headline follows as the
   title.
2. **A fail is shown.** When the authentication result for the sender is `fail` (the verdict of ADR
   0048), the header shows "Not verified · domain" in the late colour, with a shield and an
   exclamation mark, and a title that says the domain did not confirm it sent the mail. A pass still
   shows "Verified · domain". No result shows nothing, because most mail without one is ordinary.
3. The domain shown is the one in the address, so a copied display name next to a stranger's domain
   is visible at a glance.

4. **In the list of Matters, a warning only.** The owner chose to warn, not to hold back: a thing
   whose sender failed authentication keeps its place, its score and its section. Its row says
   "Check the sender" in the late colour, its why ends with "The sender's domain did not confirm it
   sent this mail. It may not be who it says.", and the reader says so above the actions. A thing
   that is already suspect for the reasons of ADR 0066 (rule 5) says that instead, once, and keeps
   that rule's place after the rest.

## Consequences

- The person sees who wrote before they read what the agent made of it, in both readers.
- Mail whose sender passed authentication for a domain that only looks like the real one is not
  caught by this; the address in the header is what shows it.
