# 0102. The agent proposes, the person presses

- Status: Accepted
- Date: 2026-11-10
- Amends: [0083](0083-the-agent-searches-in-a-loop.md) (the tools, the final value)
- Builds on: [0027](0027-saved-views.md) (saved views), [0056](0056-acting-on-rows-of-the-list.md) (acting on rows), [0064](0064-one-prompt-for-a-thread-or-all-mail.md) (the talk across all mail), [0071](0071-notifications.md) (notifications)

## Context

The loop of 0083 is made to find a message. People also ask it for other things:

- "create useful filter views from my mail" (asked in Polish);
- "tell me when my accountant writes";
- "archive everything from this shop older than a year", "mark promotions as read";
- "write to Anna that I will be late";
- "how many mails from X this year?", "who writes to me most?".

The loop could only answer in one paragraph. For the views it wrote "1) ... 2) ...", from the few
threads it had read, without seeing the views that exist or testing a query, and nothing in the
talk let the person make a proposal real. A question about numbers was answered from the threads
it happened to read.

These questions have the same shape. The agent can work out what to do, but it must not do it:
mail is written by other people, and a message must not be able to make the agent create, move or
send anything. The person can do it with one press, if the press is ready.

## Decision

1. **Three more tools, read-only, ours.** The same MCP server as 0083, with the same token, the
   same budget of 30 calls and the same lock-down. The adapter's allow-list is the server's list of
   tools, so it now names six.
   - `list_views()` returns the person's saved views, name and query, fenced as data.
   - `count_mail(query)` counts the messages a query matches, as a saved view runs it (no
     stemming), with how many of them are unread and the 8 senders with most of them. It stops at
     500 and says "500+". It reads keys, senders and flags in chunks of the index, at most 40
     chunks, and never a message's text.
   - `mail_overview(months)` returns who wrote most to the person in the last months (3 unless the
     model asks for 1 to 12): the top 30 senders and the top 15 domains, with counts and unread.

   Only consented accounts count. A thread the person's rules cover is left out of `count_mail`
   the way `search_mail` leaves it out: by all its visible messages. Only threads whose matched
   senders are all covered by rules are read whole to decide it. The overview leaves out a sender a
   rule covers and a domain a domain rule names.
2. **One new port method,** `MessageStorePort.listSenderCounts(sinceMs, { accountIds, by, limit })`.
   It walks the visible messages on the partial index of `All mail`, from the newest down to the
   window, groups them by sender or by domain, and returns at most `limit` rows. Its cost follows
   the window. It runs in the sync worker, where the loop's other tools run, never on the router.
3. **The steps are true.** The tool server writes "Counted: <query> 128 messages, 12 unread",
   "Looked at: your views" and "Looked at: who writes most, the last 3 months" when a call runs.
   They are two new kinds of step, `count` and `look`.
4. **The loop's final value gains `offers`.** It is a list of at most 6, of all kinds together.
   Each offer is one flat object: `kind` (an enum), `why` (1 to 160 characters), and the fields of
   every kind, all optional. Structured output takes a flat object more reliably than a union, so
   the code checks, kind by kind, which fields must be there, as it does for the scopes of what to
   remember. The instructions say when to make an offer: only when the person asked for that kind
   of thing. They name no word, sender, company or language.
5. **One check per kind; an offer that fails is dropped, never repaired.** One function per kind
   sits behind one dispatcher. The renderer has one block with a row component per kind. A new kind
   is a new value of the enum, its fields, one check, one row and one rule below. Every kind drops
   an offer whose `why` is empty or too long. Counts are always counted by code when the answer is
   accepted, with the same function as `count_mail`; the model's numbers are never used.
6. **Kind `view`: a view to save.** Fields `name`, `query`, and optionally `notify`.
   - The code drops it when its name fails the checks of `createView` (shared, not copied) or is
     taken by a view or an earlier view offer, ignoring case and accents; when its query does not
     parse without a diagnostic, is empty, or is the text of a view or of an earlier view offer
     (trimmed, folded, one space between words); when its name or query holds control or invisible
     characters; when code counts 0 messages for it.
   - The row shows the name, the query in the mono face, why, the count and `Save view`. With more
     than one unsaved there is `Save all views`. Saving calls the existing `createView`, through the
     sync worker (0027). A saved view shows as saved and opens its tab; "saved" is read from the
     person's views (the same name and query), never stored. Clicking the query puts it in the bar
     on `All mail`; that never changes a view.
   - `notify` is for "tell me when ...". The button then reads `Save view and notify`. After the
     view is saved, the existing prefs call turns on its notifications (0071), every channel, as
     `people` and `replies` have by default. If that write fails the view stays, and the row says
     so.
7. **Kind `act`: a clean-up.** Fields `action` (`archive`, `trash` or `markRead`) and `query`.
   There is no spam, no folder (a folder belongs to one account) and never delete for good.
   - The code checks the query as for a view and counts it; 0 drops it, and so does `markRead` with
     nothing unread.
   - The row says what it would do with the count ("Archive 128 messages"), the query (a click
     shows it in `All mail`), why, `Show them` and the action's button.
   - The set acted on is what the query matches **when pressed**, in the same scope as the count:
     the code matches it again on the sync worker, as `count_mail` does, in the accounts agreed to
     and without the threads the person's rules cover. It is not the count from the offer, but it
     is never wider. The press gets keys, threads, accounts, subjects and seen flags, no text.
     `Show them` shows the person's own search of `All mail`, which may hold more. Past 500
     messages, either at the offer or at the press, there is no action button, only `Show them`,
     and the row says there are too many to do from here.
   - Pressing asks once, in place: "Archive 31 threads? They hold the 128 messages that match, and
     move whole." A move takes whole threads (0056), so it names the threads. `Archive` and
     `Cancel` answer it; there is no modal.
   - It runs only through the list's own paths. Archive and Trash are one `moveThreads` of the
     list store, with `others`: one action, one line in the tray, one Undo (0056, rule 6). That path
     already resolves the place per account, so mixed accounts are one action. Mark read is the
     list's own mark of the unread messages, and the row offers `Undo` for it.
   - The row then says what was done and where the Undo is. Nothing of it is stored on the entry.
   - Mail cannot make anything move. An offer is text until pressed, the question shows the true
     count, and what it did can be undone.
8. **Kind `message`: a new message as a draft.** Fields `to` (at most 5 addresses), `subject` and
   `body` (plain text, at most 4000 characters).
   - **The guard on recipients.** An address is kept only when the person has sent mail to it
     before (`listWrittenTo`, the To and Cc of their Sent mail). The others are kept apart, as
     `unknownTo`, never in the draft, and the row says "Not added: x@y — you have not written to
     them before." With nobody left, the offer stands with an empty To. This keeps mail from making
     the agent address a stranger.
   - Subject and body are cleaned of control and invisible characters; an empty one drops the offer.
   - The row shows To, the subject, the first lines and `Open draft`. Pressing opens the composer of
     0101 filled in. It is not touched, so nothing is saved until the person writes in it; the
     person reads, edits and sends. The agent never sends and never saves a draft.
   - The loop finds addresses with the tools it has: `search_mail`, `open_thread` and `count_mail`
     already show senders' addresses. Nothing more leaves the machine for it.
   - Only in the talk across all mail. The reply help of 0098 is unchanged.
9. **Answers that rest on counts.** What `count_mail` and `mail_overview` counted is kept by the
   tool server as facts: each count with its query and numbers (the latest per query, at most
   12), and the latest overview's first 8 senders and 5 domains.
   - The facts go to the answer turn in their own fenced part, as counts made by code. Its fixed
     text gains a paragraph: it may answer from them, must not change a number, and needs no thread
     or quote for one.
   - A loop that ends with counts and no thread still has an answer turn, with no mail in it,
     instead of "nothing found". The entry then has 0 threads.
   - The facts are kept on the entry and shown under the answer as "Counted on this Mac, not by the
     agent", apart from the text, as the steps are (0083, rule 4). The text's numbers are the
     model's; the list under it is the code's. No code checks the numbers of the text against the
     list: a checker of numbers in prose would be fragile, and showing both side by side is honest.
10. **The answer turn and the offers.** With accepted offers and something to answer from, the
    answer turn is told of them in their own fenced part, as data written by a model, and its fixed
    text gains a paragraph: introduce them, do not repeat their names, queries, recipients or
    wording, cite threads only as examples, and never say that anything was done. With offers and
    nothing to answer from, or an answer the code rejects, the offers are not lost: the code writes
    one fixed sentence, "Here is what I would suggest. Nothing happens until you press a button."
    Otherwise the flow, the check of quotes and the ledger are as before.
11. **The entry keeps them.** A `found` entry gains `offers` and `facts`, kept as JSON in
    `agent_talk.offers_json` and `facts_json` (migration 47, which adds a column only when it is
    missing).
12. **Only the person's press writes.** The model gets no tool that writes, and 0083 rule 2 holds.

Not in this ADR: the old trail (loop off, 0080) and the talk about one thread are unchanged; the
agent does not edit, rename or delete views; no rules that move mail.

Later kinds, not now: agent rules ("stop reading mail from X") and instructions ("remember
that ...") as offers; unsubscribing; sums of amounts.

## Consequences

- A question that is not "find a message" ends in rows the person can press. Each is checked by the
  code and shows numbers the code stands behind.
- The ledger counts threads, per account, as before. `count_mail` and `mail_overview` send sender
  addresses, names and counts; `list_views` sends the names and queries of the person's views; the
  answer turn gets the same counts. None sends a subject or a message's text, and none is a thread,
  so the ledger does not count them. The entry counts the calls that sent senders (`loop.counts`)
  and marks that the views went (`loop.views`), and the footer under the answer names both. With no
  thread it says "No message left this Mac".
- What a clean-up acts on is matched at the press in the scope of its count: the accounts agreed
  to, without the threads the agent's rules cover. Mail in other accounts, or in those threads,
  is never moved or marked from an offer, even when `Show them` lists it; the person acts on it
  from the list. The question asked before anything runs shows the count at the press.
- Cost: a count reads at most 501 keys, their messages' headers, and the whole thread of each
  thread whose matched senders a rule covers. An overview groups the window's received mail twice.
  Both run on the sync worker's connection, so a sync batch may wait behind one; this has not been
  measured on the owner's mailbox. A clean-up's press makes the same walk once more.
- An offer can be dropped for a reason the person never sees. Fewer rows is the price of rows the
  code can stand behind.
- `count_mail` counts as a view would, so a query that `search_mail` found with stemming may count
  fewer. The instructions say so.
- A filled-in message that the person closes without writing in it leaves nothing; the offer stays
  in the talk to open again.
