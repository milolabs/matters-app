# 0091. A reply joins the thread it answers

- Status: Accepted
- Date: 2026-11-09
- Amends: [0014](0014-labels-threads-identity.md) (threads)
- Amended by: [0104](0104-a-reply-without-ids-joins-the-thread-it-answers.md) (rule 7: a reply that points to nothing joins, by its subject, the thread where the person wrote to its sender)

## Context

0014 says a thread without a provider thread id is computed from `References` and `In-Reply-To`
with the JWZ algorithm. What was built is simpler: `localThreadRoot` names a thread by the first
`References` id, else `In-Reply-To`, else the message's own id. Nothing looks at the messages
already stored. A sender whose program does not carry the first id forward starts a new thread
with every reply.

The case that showed it, on the owner's IMAP account, 2026-11-06 to 2026-11-09:

| Message | From | Thread it got |
|---|---|---|
| WYCENA: Anhydryt+ jastrych | the contractor (op.pl webmail) | A, its own id |
| Re: WYCENA | the owner (Apple Mail), `References` = A | A |
| Re: Re: [SPAM] WYCENA | the contractor, `References` without A, parent = the owner's reply | B |
| Re: WYCENA, sent from Matters, two copies | the owner | B and C |

One conversation became three threads. Matters read each one on its own, so thread A still said
"waiting for an answer" after the answer had come. The reply sent from Matters made it worse:
it built `References` from the open thread, which was B alone, so its copy from the server
started C. The `[SPAM]` tag the server put in the subject played no part.

On a read-only copy of the owner's mailbox (81 613 messages on local threads, 76 569 threads),
joining a thread to the thread of a stored message that its root names, and joining threads that
hold the same `Message-ID`, merges 585 threads into 285. The largest group is 24 threads and 146
messages, all one correspondence; no group joins unrelated mail.

## Decision

1. **The headers are kept.** Each message on a local thread stores the ids it points to
   (`References`, then `In-Reply-To`), one row per id in `message_refs`, indexed by id.
   `messages` gets an index on `(account_id, message_id_header)`.
2. **A message joins what it touches.** When a message on a local thread is stored, the thread
   it gets is chosen among: the thread its headers name; the threads of stored messages whose
   `Message-ID` it points to; the threads of stored messages that point to its `Message-ID` (a
   parent that arrives after its reply); and the threads of stored copies with the same
   `Message-ID`. Only messages of the same account count.
3. **The oldest thread wins.** When the candidates are more than one, the thread whose first
   message is the oldest keeps its id; a tie goes to the smaller id. The others are merged into
   it.
4. **A merge moves everything a thread owns.** The messages move, and so do the thread's drafts,
   the agent's feedback, instructions, journal and talk. The agent's readings and prepared work
   of every thread in the merge are dropped: they describe part of a conversation, and the agent
   reads the merged thread again. Bodies stay where they are; their blocks are found by message.
   Moved messages get a new change number, so open lists and the reader follow.
5. **Provider threads are left alone.** A Gmail thread id (`pt:`) is the provider's word, and no
   message on one is moved or joined.
6. **The mail stored before this is rethreaded once.** Its headers were not kept, but its thread
   id names its root. A migration stores that root as the message's one reference and joins
   threads by rules 2 and 3. Later reads of the headers add the rest.
7. **No subject matching.** 0014 named it as the fallback. It is left out: "Re: Faktura" from two
   senders is two conversations, and a joined thread is far worse than a split one. A sender
   whose replies carry no ids at all stays split.

## Consequences

- A reply from a program that drops the first `References` id lands in its conversation, and a
  reply written in Matters to such a conversation carries every id of it.
- A message that arrives can change the thread id of messages already shown. Lists and the reader
  follow the change number; a thread that was open goes on showing the messages it had until it
  is opened again.
- Each stored message on a local thread costs one indexed lookup per id it points to.
- The agent reads the merged threads again, once: about 285 on the owner's mailbox, most of them
  older than the 30 days it reads.
- Two copies of one sent message (the one recorded at send and the server's) now share a thread,
  but both are still shown. Why the server's copy was not matched to the recorded one is open.
