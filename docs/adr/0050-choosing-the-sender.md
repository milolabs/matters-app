# 0050. Choosing the sender of a message

- Status: Accepted
- Date: 2026-11-05

## Context

With several accounts, the composer showed `From` as text: a new message went out from the account
of the open thread, or the first account, with no way to change it. A draft's `accountId` and
`from` decide everything about a send: the server, the credentials, the message limit, and the
Sent folder.

## Decision

1. With more than one account, a new message and a forward have a `From` list of the accounts. A
   forward is a new conversation (ADR 0045), so it has no thread to stay with.
2. A reply keeps the account of its thread. The thread's messages, its draft lookup and the sent
   copy all belong to that account, so answering from another would split the conversation.
3. An account without an outgoing server is listed but cannot be chosen.
4. Choosing a sender changes `accountId` and `from` together. Both are in the fingerprint, so a send
   waiting on the old sender is voided, as for any other edit.
5. Choosing a sender is not writing: a message with nothing else touched leaves no draft behind.
6. A draft's files move with it (`AttachmentStorePort.moveDraft`), so removing an account takes the
   files of its drafts and no others. `update` never changes whose a row is: a copy still running
   writes a row it read before the move.
7. The limit of the new account applies at once. A file the old server refused has no copy, so it is
   read again if the new limit takes it. A file the new limit refuses blocks Send as usual.

## Consequences

The account is now a choice the person sees, not a guess they can only find out about afterwards.
Answering a thread from another address is not possible yet; it would need rule 2 reconsidered.
