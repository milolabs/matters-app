# 0104. A reply without ids joins the thread it answers

- Status: Accepted
- Date: 2026-11-10
- Amends: [0091](0091-a-reply-joins-the-thread-it-answers.md) (rule 7, no subject matching)

## Context

0091 joins threads through message ids only. Its rule 7 refuses the subject: "A sender whose
replies carry no ids at all stays split." Such a sender showed up. The person wrote twice in a
conversation with a contractor. The contractor's next reply, "Re: Re:" and the same subject,
carried no `In-Reply-To` and no `References`. It became a thread of one message. The agent no
longer saw it as the person's own matter: that signal needs the person's messages in the same
thread.

Measured read-only on the owner's mailbox on 2026-11-10, 81 622 messages on local threads:

- 192 replies from other people carry a reply prefix and no ids.
- The rule below joins 35 of them, from 23 senders. 25 have one candidate thread; 10 are links of
  a chain of such replies.
- The gap to the previous message of the conversation has a median of 0.8 days and a maximum of
  12.9 days.
- Without rule 5 (the person wrote to the sender in the thread) it would join 71.
- By subject, sender and gap, none of the 35 joins unrelated mail. The bodies were not read.

## Decision

When a message on a local thread is stored, and the id rules of 0091 found no other thread for it,
it joins an existing thread by its subject only when all of these hold:

1. **It points to nothing.** Its headers were read and name no other message. Its own
   `Message-ID` is not blank (nor `<>`). A message whose headers were not read is not joined.
2. **Someone else wrote it.** The person's own messages are those in a Sent mailbox or from the
   address of one of the accounts.
3. **Its subject is a reply's.** It starts with `Re`, `Odp`, `AW`, `SV` or `VS`, with or without a
   counter (`Re[2]:`), in any case. A forward (`Fwd`, `FW`, `PD`, `WG`) is not a reply. Normalised
   as 0081 normalises subjects, it has at least 3 characters.
4. **The thread has that subject, recently.** The thread is a local thread of the same account,
   not its own, and holds a message dated before it with the same normalised subject, at most 30
   days older.
5. **The person wrote to the sender there.** In that thread, before it, the person wrote a message
   with its sender in `To` or `Cc`. Addresses are compared in any case.
6. **The newest wins.** Of several threads, it joins the one whose message of rule 4 is the newest;
   a tie goes to the smaller id. The other threads are not merged into each other.
7. **The merge is 0091's.** The oldest thread keeps its id, everything a thread owns moves, and the
   agent's readings are dropped (0091, rules 3 and 4). Provider threads are never touched.
8. **The lookup is rare and bounded.** It runs only for a message that passes rules 1 to 3. It
   reads one account's mail of 30 days, on an index of `messages` by account and date.
9. **The mail stored before this is joined once.** A stored message points to nothing when it has
   no row in `message_refs` and its thread is named by its own `Message-ID`. Messages are taken
   oldest first, so a chain of such replies becomes one thread. The pass is planned apart from
   being written, so the plan can be read on a copy opened read-only.

## Consequences

- A reply from a program that sends no ids lands in its conversation when the person wrote to its
  sender there, and the agent reads it as the person's own matter.
- A merge cannot be undone.
- The same person replying within 30 days to two different matters that carry the same subject
  would be joined into one thread.
- A reply stored before the conversation it answers (an out-of-order first sync) stays split.
- A message whose `Message-ID` is blank is never joined this way.
- A reply that the person wrote without ids stays split; so does a reply from someone the person
  never wrote to in that thread.
- Each message that passes rules 1 to 3, about 0.2% of mail, costs one read of its account's mail of
  30 days. `messages` has one more index.
