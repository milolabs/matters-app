# 0092. One copy of a sent message

- Status: Accepted
- Date: 2026-11-09
- Amends: [0020](0020-sending-outbox-and-compose.md) (rule 10, the Sent copy)
- Builds on: [0091](0091-a-reply-joins-the-thread-it-answers.md) (copies share a thread)

## Context

After a send, Matters appends the message to the Sent folder, except on Gmail, which files what
its SMTP accepted by itself (0020). It knows Gmail by the `X-GM-EXT-1` capability and treats every
other server as one that files nothing.

Zoho files sent mail itself too. A reply sent from Matters on 2026-11-09 was in the Zoho `Wysłane`
folder twice, UID 4810 (Zoho's copy) and 4811 (ours), and both showed in the thread.

It is not only Matters. On the owner's Zoho account 1 071 sent messages are on the server twice,
from 2015 on; one pair is ours, the rest came from years of Apple Mail doing the same APPEND. Every
pair has the same `Message-ID`, sits in the same folder, and differs in date by less than a
second.

## Decision

1. **The server's copy is looked for before one is appended.** After a send succeeds on a server
   without `savesSent`, Matters searches Sent for the `Message-ID` (`SEARCH HEADER`). Found: that
   copy is recorded where it is, and nothing is appended. Not found: the APPEND is done as before.
2. **Three looks in about 1.5 s:** at once, after 0.5 s, after another second. The message shows
   in its thread only after this step, so the wait is short. A server that files later than that
   gets a second copy, as before; rule 4 keeps it from showing.
3. **The search finds the place.** A search in Sent returns the location of the copy as well as
   its provider id, so it is recorded the way an appended copy is.
4. **A second copy of a message is not shown.** A message is a copy when the same account holds
   the same `Message-ID` in the same mailboxes under a smaller key. `messages.copy_of` holds that
   key, kept by triggers on every insert, delete and change of mailboxes. The shown thread, All
   mail, search and the agent's candidates leave copies out. Moving, archiving and deleting a
   thread still take every copy. When the shown one goes, the next copy is shown.
5. **The same `Message-ID` in different mailboxes is not a copy.** Mail sent to oneself is in Sent
   and in the Inbox, and both are shown.
6. **Nothing is deleted from the server.** The 1 071 pairs stay where they are and are not shown
   twice.

## Consequences

- A send on Zoho, iCloud or any server that files its own copy leaves one copy, with no setting.
- Each send on such a server costs one or more Sent searches; on one that files nothing, three
  searches and up to 1.5 s before the message shows in its thread.
- Every write of a message runs an indexed lookup to keep `copy_of`.
- A flag set on a shown copy is not set on the hidden one. The hidden one is only read when the
  shown one is gone.
