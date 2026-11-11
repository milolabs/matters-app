# 0042. Replies go where the sender asked

- Status: Accepted
- Date: 2026-11-04
- Refines: [0020](0020-sending-outbox-and-compose.md) (rule 13)

## Context

`Reply-To` names the address a sender wants answers at. Mail from a contact form, a shop, a ticket
system or a mailing list often comes from one address and expects answers at another. The parser
drops the header and `buildReply` answers `From`, so these replies go to `noreply@…`, to the wrong
person, or nowhere.

The header can also be abused: a message from your bank's address that asks for answers at another
domain is a classic way to collect them. Following the header silently would swap one problem for
another, so the person writing has to be able to see it.

Mail that is already stored was parsed without the header, and we do not keep message sources.
ADR 0037 accepted "unknown" for the sender's authentication on old mail. That is not good enough
here, since a reply to old mail would still go to the wrong place. IMAP can tell us without a
download: `ENVELOPE` carries the field. RFC 3501 has the server fill it in with `From` when the
header is absent, so "same as From" and "no header" look alike there and have to mean the same.

## Decision

### Who a reply goes to

1. A message has `replyTo`: the addresses of its `Reply-To` header. **Absent means not known yet**,
   an empty list means there are none. A list equal to `From` is stored as empty, so both ways of
   learning it (the parser and `ENVELOPE`) give the same answer.
2. **Reply** goes to `replyTo` when it has anyone left once the user's own addresses are removed,
   and to `From` otherwise.
3. **Reply all** follows RFC 5322 section 3.6.3: `To` as in rule 2, `Cc` the message's `To` and
   `Cc`. `From` is not added when `Reply-To` replaced it, since the sender asked not to be answered
   there. The user's own addresses are excluded as before.
4. A reply to the user's own message keeps going to that message's `To`. `Reply-To` is not read
   then: it describes where answers to the user should go, not where the user is writing to.

### The person writing can see it

5. When a reply's `To` differs from who sent the message, the composer says so in one line above
   the fields, and the fields keep the addresses so they can be changed:

   > Replies go to **help@shop.example**, as the sender asked. Sent from orders@mailer.example.

   If the receiving server could not authenticate the sender (`senderAuth` is `fail`, ADR 0037),
   the line uses the `late` color and goes on: *The sender could not be verified. Check this
   address before replying.* It blocks nothing; the decision stays with the person.
6. The reader's "Reply to …" prompt names who the reply goes to, not who sent the message.

### Mail stored before this

7. `messages.reply_to_json` is `NULL` until known. Each sync of a folder asks `ENVELOPE` for up to
   one batch of that folder's messages still unknown, in the same batch that carries its flag
   changes, so the cursor and the answers commit together. Until then a reply goes to `From`, as
   it did before.
8. A partial index on the unknown rows keeps this free once it is done: a mailbox with nothing left
   to learn pays for one index probe per folder, at any size.

## Consequences

- Replies to forms, shops and lists reach a person, and a reply going somewhere unexpected is
  visible before Send.
- A large mailbox learns the field over several syncs. Replying to old mail during that time goes
  to `From` with no line in the composer, which is what every earlier version did.
- `Message` gains an optional field, so fixtures and fakes need no change, and existing drafts keep
  their fingerprints: recipients are stored on the draft.
- A draft already written keeps its recipients. This only decides how a new reply starts.
