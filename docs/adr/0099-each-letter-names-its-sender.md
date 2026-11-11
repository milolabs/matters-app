# 0099. Each letter names its sender

- Status: Accepted (changes ADR 0078 for the thread view; Matters keeps its sender head)
- Date: 2026-11-09

## Context

ADR 0078 put the other side of a thread on top: a 48 px avatar, the name, a line about the person,
then the subject. Each letter below named its sender again, with an arrow to its recipients. A
single message read its sender twice, and the user found the reader busy and unprofessional next to
Apple Mail, which shows one header per message. The agent's notes under a message (ADR 0075) were
one quiet line with a dot: easy to miss, and they did not say they came from the agent or what to
do about them.

## Decision

1. The thread view has no sender block on top. It shows its tools on the right, then the subject and
   one quiet line (ADR 0097).
2. Each open letter has its own header: the avatar, the sender's name (its menu as before) and
   address, the verified or not-verified badge of that message (ADR 0078, 0079), and under them
   "To: …". The date and Original/Text stay on the right. A click on the "To" line folds the letter.
3. Under an open letter, each promise or ask is a note of the agent: "✦ Agent noticed", whose move
   it is ("Waiting for you", "You promised", "You're waiting", "They promised"), the due date (late
   or within two days in the late colour), the quoted words in the letter's serif, and, when the move
   is the person's, one button: Reply. Violet stays the agent's colour (ADR 0052, rule 10).
4. Folded letters keep the one-line promise rows of ADR 0075.

## Consequences

The sender reads once per letter, and the agent's notes are visible and say what to do. The person
line of ADR 0078 ("In 30 messages · last mail today") is not in the thread view any more; Matters
still shows it. The smoke check of ADR 0078 now measures the letter's header after the subject.
