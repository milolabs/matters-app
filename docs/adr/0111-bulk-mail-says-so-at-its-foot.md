# 0111. Bulk mail says so at its foot

- Status: Accepted
- Date: 2026-11-10
- Amends: [0052](0052-things-that-matter.md) (rule 4: what makes a message `automated`), [0066](0066-what-you-would-regret-not-seeing.md) (rule 6: how stored mail learns the flag)

## Context

- **A class of bulk mail rang as a person.** Notifications sort new mail by `automated` and the
  no-reply address (ADR 0106): a list is off by default, a person rings a banner. Marketing digests
  from a large shop, sent from an address that is not a no-reply one, came through as a person.
- **Their headers do not say so.** `automated` is set only by `List-Unsubscribe`, `List-Id`,
  `Auto-Submitted` and `Precedence` (ADR 0052, rule 4). On a real mailbox of about 200,000 messages,
  46,000 are stored with `automated = 0` and 37,000 do not know yet. Many of them are newsletters and
  offers that carry none of those headers: older bulk mail rarely did, and some senders still do
  not. The headers are not kept locally; only the parsed text is (ADR 0009).
- **Their text does.** Every copy of a mailing ends with a way out of the list (*unsubscribe*,
  *manage your email preferences*, *wypisz się*, *nie chcesz otrzymywać*) or with the address the
  copy went to (*This email was sent to ...*, *wiadomość została wysłana na adres ...*).
- **The same words appear where a person writes.** A reply or a forward quotes a newsletter's
  footer. A calendar invitation from a person says how to stop updates for the event. A bank's
  signature says what to do if the mail was received in error. Bills, claims and sign-in alerts say
  they were generated automatically and ask not to be answered. Marking any of these as from a list
  hides a person's mail, or a notice the person waits for, from banners, which is worse than one
  banner too many.
- **A small business writes from `info@` both ways.** A hotel's `info@` sends templated offers and
  a named person's payment confirmation from the same address and the same mail program, with
  nothing in the stored text that tells them apart.

## Decision

1. **A mailing's footer makes a message `automated`.** `isAutomatedByBody(text, subject)` in core is
   true when the end of the sender's own words (the last 2,000 characters, on folded text) has a
   phrase about a list: a way out of it, a list's preferences, the address the copy was sent to, or
   that the reader signed up for it. English and Polish, as the service words of ADR 0066, rule 6.
   It is added to the headers: `automated` is `isAutomatedByHeaders(headers) ||
   isAutomatedByBody(text, subject)`. It only ever adds; it never clears what the headers set.
2. **Only the sender's own words.** A subject that answers or passes on (`Re:`, `Fwd:`, `Odp:`,
   `PD:`...) never counts. Reading stops at the first quote mark or at the line a mail program writes
   above quoted or forwarded mail (`On ... wrote:`, `W dniu ... pisze:`, `From:`, `-----Original
   Message-----`).
3. **Precision over recall.** Left out on purpose: "generated automatically, do not reply" (bills,
   claims, sign-in alerts; programs, but not lists), "you are receiving this because you are an
   attendee" and "to stop receiving updates for this event" (invitations from people), "if you
   received this in error" (signatures), a bare *opt out* (contracts), and a bare *wypisz* ("write
   out", as an invoice). The sender's address alone stays as it was: `info@`, `office@`, `kontakt@`
   are often a person. A templated mail with no footer, like the hotel's, still rings.
4. **New mail is decided by the parser**, from the text it stores, so the two never disagree.
5. **Stored mail is read once, in the background.** Migration 49 puts one row into `counters`
   (`automated_body_before`, above every key). After launch the sync worker takes steps of 500
   messages that are not marked automated, newest first by key, reads their stored text, marks those
   with a footer, and moves the row; the last step deletes it. The same small-step runner as the HTML
   repack (ADR 0088): 20 s after launch, 100 ms between steps, an error ends it until the next
   launch, which goes on where it stopped. No column, no index, no fetch from the server. Mail newer
   than the row was parsed with the rule. Like the header backfill, nothing is announced.
6. **Both backfills agree.** The header backfill asks only about rows that do not know; the step
   reads rows that are 0 or do not know. A row the step marks is never asked about; a row the
   headers set to 0 first is still read by the step when it gets there.

## Consequences

- On the real mailbox (counts, read-only): 14,236 of 46,193 messages stored as not automated, and
  19,874 of 37,113 that did not know, have a footer and become automated; no message goes the other
  way. Of the newest 300 visible messages, 54 were not automated and 21 of them become automated;
  19 of those were not caught by the address either, so they no longer ring as a person. The 21 left
  are mail from people, accountants and small businesses, bills and receipts.
- Spot-checks: of the marked messages that were 0, 18 come from an address the person wrote to or
  sit in a thread the person wrote in; all are newsletters or notices of a service. Of those that
  did not know, 671 come from an address the person once wrote to: nearly all newsletters of
  services they signed up with, and one help-desk reply of a shop. 5 of 5,300 sent messages
  would match (the person's own tests of a mailing). Calendar invitations, replies and forwards are
  not marked.
- Bulk mail with no footer in its text, or whose footer is only an image, is still missed, and so
  are templated mails from a small business's shared address. They need the headers a mailing tool
  adds, which are not stored.
- A notice of a service that also keeps a list (a receipt or a sign-up confirmation with an
  *unsubscribe* line) becomes automated: it stops ringing as a person, as a no-reply sender already
  did. Matters still keeps it when its subject reads like a service notice (ADR 0066, rule 6).
- Cost: the parser folds at most the message's text once more. The stored pass read 83,306 rows in
  167 steps, about 36 ms each and 79 ms at most, about 6 s of the worker in all. A mailbox of
  500,000 messages takes roughly two and a half times that, spread over a few minutes after the
  first launch with this version. Search ranks the newly marked mail lower (ADR 0081), as it does
  all automated mail.
