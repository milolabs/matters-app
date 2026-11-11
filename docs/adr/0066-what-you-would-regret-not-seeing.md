# 0066. What you would regret not seeing

- Status: Superseded by [0117](0117-matters-is-a-view-with-a-prompt.md)
- Date: 2026-11-06
- Amended by: [0067](0067-what-the-owners-labels-taught.md) (own threads, dates ahead, ended offers, doubted requests)
- Amended by: [0068](0068-who-writes-what-you-refuse-what-comes-from-an-office.md) (interaction recency replaces relation by company as support; when a decision is for now; mail from an office)
- Amended by: [0111](0111-bulk-mail-says-so-at-its-foot.md) (a mailing's footer in the text also makes a message `automated`; stored mail is read for it once)
- Amends: [0052](0052-things-that-matter.md) (what may become a thing), [0057](0057-what-the-mail-itself-says-about-a-thing.md) (relation to the sender), [0058](0058-what-ignoring-it-costs.md) (what a no teaches, and what is for now)

## Context

Matters asks "does someone owe something?" (ADR 0052). The person asks "would I regret not seeing
this?". The two differ in both directions:

- A sales offer that concerns the person's own tax history is read as `fyi`: nobody owes anything, so it
  never reaches the ranking, however much the person would want to see it.
- A small invoice, months old and possibly paid long ago, ranks first. The ranking gives points for being
  late, and lateness never stops growing (capped at ten days of points, but never forgotten), so what was
  once urgent rules for ever. Silence is read as nothing, when it only means that nothing is known.
- A request for money from an address nobody ever wrote to looks like any other request for money.
- Mail from a program that is also a notice about money, a deadline or an account (a no-reply
  payment notice) is dropped before reading, because the program filter looks at the address alone.
  Most stored mail does not even have the flag that filter uses: it is empty for mail stored before the
  parser set it.
- Closing a thing and saying it does not matter are one click apart and look the same to the ranking
  rules. Ten closed invoices may be ten paid invoices.

This does not call for a new score. It calls for changing what gets a chance to appear, keeping the weights
of ADR 0052, 0057 and 0058, and using the person's relation to a company only as support. A person who
writes to a company is not always above a program: an urgent domain renewal may still beat a friend's offer.

## Decision

All of it is code, on quotes found in the mail. A model proposes; code checks (ADR 0051, rule 9).

1. **A new reading (`ANALYZER_VERSION` 4).** The model keeps `state`, `facts`, `stakes`, `consequence`,
   `case` and `anchors`, and also gives, all required except where said:
   - `intent`: `reply` (someone expects an answer), `act` (pay, upload, confirm, renew: outside a reply),
     `decide` (the person may take or refuse something; nobody owes anything), `wait` (someone owes the
     person), `know` (it changes something for the person; nothing to do), or `none`. `intentQuote` is the
     passage that shows it, copied exactly; empty only for `none`.
   - `amount` (optional): `value`, `currency`, `role` (`debt`, `price`, `refund`, `other`) and a `quote`.
     1090 as a price, a debt and a refund are three different things.
   - `windowEnd` (optional): the day an offer or chance ends.
   - `forYou`: `specific` when the thread is about this person's own matter (their project, complaint,
     contract, a tax year they are dealing with, something they wrote about), `generic` when it would go to
     anyone on a list. A known company and a price are not by themselves specific. `forYouQuote` is the
     passage and is required for `specific`.
   - `status`: `open`, `done` or `unknown`, from the thread itself. Intent and status are separate.

   The instruction on `due` is tighter: a stated pay-by line ("Zapłać do: 15.09.2026") must become `due`;
   a fact with a date in its quote and no `due` was the cause of a bad ranking.

   A line from code, not from the model, goes near `Depth`: `History: You wrote N messages to this
   company, the last in YYYY`, or `You have never written to this company` (`sender` instead of `company`
   at a shared mail domain). It holds counts and a year, no address, and the thread's own replies are not
   counted. The model is told it is context for `forYou`, and that an old relationship alone does not make
   a thread specific. Without a Sent folder nothing is known and the line is left out.

   `acceptAnalysis` checks every claim: an `intentQuote` not found in a message turns any intent but
   `none` into `none`; `specific` without a found quote becomes `generic` and carries no evidence; an
   `amount` is kept only if its quote contains a digit and is found, and its value is finite and above
   zero; `windowEnd` goes through `parseIsoDay`. Each passage is stored with the key of the message that
   holds it (the newest, when several do), as facts are. The store keeps `intent` in a column and the
   rest as one JSON object (`reading_json`), with no CHECK, so a newer build's values read as absent.

2. **The gate.** One exported predicate, `shownPath`, is used by the list, by what is drafted ahead, by
   the count a closing covers (ADR 0065), and by a thread's own banner (ADR 0063). A reading may become a
   thing when its confidence is at least `MIN_CONFIDENCE`, the person has not hidden it, `status` is not
   `done`, and any of:
   - a. `state` is `onYou` or `waiting` with a quoted fact on the needed side (ADR 0052, unchanged);
   - b. `intent` is `decide`, with its passage, and a personal reason: `forYouEvidence`, or the local signal
     `sharesTopic` (rule 3). A decision with no personal reason does not show, even from a known company:
     Matters must not become a catalogue of offers;
   - c. `intent` is `act` or `reply`, with its passage, while `state` is `fyi` or `none`. The two disagree;
     the quote, which is checked, decides;
   - d. `intent` is `know`, with a personal passage, from a sender the person knows (the address or the
     company). It goes to the rest, never to now.

   For b, c and d the thing's quote is the passage of the intent. `why` gets a lead sentence from code:
   "You can take this or leave it." and "It is about your own matter." or "You wrote to them about this
   before." for `decide`; "This is for you to do." for `act` (a reply says "They expect an answer from
   you."); "This changes something for you." for `know`. Model prose never goes in `why`.

   Scores are those that exist: `decide` has a base of 18, `know` of 6, `act` and `reply` through c have
   `BASE_ON_YOU`; everything else is as it was. A `decide` is for now when its `windowEnd` is within
   `DUE_SOON_DAYS`, or it arrived within 7 days from someone the person wrote to in the last 180 days (ADR 0068, rule 6: a topic match or the model's `forYou` alone no longer makes it for now). `intent`, `amount`, `windowEndMs`, `check` and `suspect`
   pass to the page on a `Thing`.

3. **Relation by company, as support** (the bonuses of the next two bullets, `REGULAR_CONTACT` and `KNOWN_COMPANY`, are replaced by interaction recency in ADR 0068, rule 2). The query for Sent mail also gives the time of the newest message
   to each address. From it code derives, per company (the registrable-enough domain: the last two labels,
   three under `com.pl` and the like), how many messages and when the last. Shared mail domains (gmail,
   icloud and the like: the list of ADR 0058's rule offers) are no company. Two signals follow:
   `wroteToCompany` and `lastWroteMs`.
   - `STRANGER_PENALTY` applies only when neither the address nor the company was written to. A new
     person at a known company loses nothing.
   - A known company within two years, when the address itself is not known, adds 4 with "You have written
     to this company." Older than two years: no bonus and no penalty. `REGULAR_CONTACT` also needs the last
     message within two years.
   - `sharesTopic(caseName, anchors, subjects)` is a pure function: words are folded; years, words of one
     letter and a small Polish and English stoplist are dropped; it is true when one subject of the person's
     mail shares two different words with the name and anchors of the matter, or one word of five letters or
     more. It is asked only for `decide` and `know` readings that have a case name or anchors and no
     personal passage of their own, and only at list-read time: one read of at most 200 newest subjects of
     Sent mail to that company, once per company per list, so the cost follows the candidates and not the
     mailbox.

4. **Is it still alive.** Silence lowers the certainty that a thing is current. It never proves that it is
   finished, so nothing disappears for it. A thing gets `check` when no message has come in its thread for:
   an act with a date, more than 14 days late and 14 days of silence; an act or reply with no date, 30 days;
   a wait, 30 days (60 when money is owed to the person: a refund, or stakes of money); a decision, 21 days,
   or at once when its `windowEnd` has passed; news, 14 days; or any reading with `status` `unknown` and 14
   days. A `check` thing loses the LATE and EXPLICIT_DATE points, is never for now, sorts after everything
   that is not `check` or `suspect`, and says "Nothing has come about this for N days, so it is not known
   whether it is still open. Check it once." `lateByDays` stays as a fact. In a series the newest mail
   decides: a lead that may be stale stays so; a fresh reminder is not marked by the older mails behind it.
   The row in the rest has a small "Check once" mark. There is no third section.

5. **Suspicious.** An act (or money with the person owing it) from an address and a company never written
   to, which sits at a shared free-mail domain or failed the check of who sent it (ADR 0048), is `suspect`.
   It is never for now, gets no draft ahead, sorts with `check` at the end, and says "It asks for money from
   an address you have never written to. It may not be genuine." The row says "Check the sender". It still
   shows: only low confidence hides it.

6. **The program filter keeps service mail.** `isAutomatedSender` also matches a no-reply marker at the end
   of a name (`messaging-digest-noreply@`, `x-no-reply@`). `selectCandidates` drops a thread written only by
   programs unless its subject reads like a service notice (`looksLikeServiceNotice`: an invoice, a
   payment, a deadline, a blocked or expiring account, a password, a refund, in Polish and English, on
   folded text). The `automated` flag is filled in for stored mail the way `Reply-To` was (ADR 0042, rule
   7): a partial index of the unknown rows, a batch per folder per sync newest first, a fetch of four
   headers (`List-Unsubscribe`, `List-Id`, `Auto-Submitted`, `Precedence`) and no source, the decision of
   the parser's own function (`isAutomatedByHeaders`, now in core), and a message the server does not
   return stays unknown and costs one batch per sync, never a loop. `orderForReading` reads threads in
   which no other person's message has a known flag after all the rest, so the backfill can spare the plan.

7. **Why it was closed.** Feedback learns `outcome`: `done`, `notRelevant`, `taken` or `declined`
   (`Not important` writes `notRelevant`). Closing is not complaining: only `Not important` lowers the
   score of the sender, as before, and this is now a stated rule. Declining a proposal also stores the
   folded name of the matter and its amount. A later `decide` from the same company, with the same folded
   name, in the same calendar year as the decline and the same amount (or either missing) is hidden, a
   whole series with it. A new year, a changed name or a changed amount opens it again
   (`isDeclinedProposal`). Undo works as before and removes the row.

8. **Actions that fit what is asked.** The reading column follows the intent. A decision has no draft
   ahead and offers `I'll take it` (closed as taken), `Not this year` (closed as declined) and `Ask for
   details` (the existing path with the direction "Ask for the details that would help decide"), with
   Later and Not important; it shows the amount with its role and the end of the offer. An act has `Done`;
   news has `Got it`; both show the amount and the date. A reply, a wait or a reading with no intent keeps
   what it had. A suspect thing closes with `Ignore` and says why in a clear line. Rows say "To decide",
   "To do" or "Worth knowing" where they said "Needs you". Only a reply, a wait or no stated intent is
   drafted ahead, and never one that is `check` or `suspect`.

## Consequences

- Every thread in the window is read again, on the person's plan, because the instructions and the schema
  changed (`ANALYZER_VERSION` 4), and the list empties meanwhile. The backfill of the `automated` flag and
  the order of reading (rule 6) limit the cost, since programs fall out as flags arrive and unknown ones
  are read last. How many threads that is is not known until the pass runs; the consent screen's count
  counts the threads the filter lets through, which is more than it did before.
- Scores are not rebuilt in this step, on purpose. The weights are those of ADR 0052, 0057 and 0058 with
  three small additions (18 and 6 as bases, 4 for a known company). What changes is what can appear and what
  silence is worth. A later step may weigh by lane or tier once real use shows what it should say.
- `amount` is stored and shown but does not change the order yet. Its role is kept so that a price is
  not mistaken for a debt when it does.
- The thresholds (14, 21, 30 and 60 days, two years, 200 subjects, 5 letters) are judgments, not tuned.
  They are constants in one place each, and every one maps to a phrase in `why` or a mark on the row.
- A thing marked "Check once" may be finished; the person looks once and closes it. A suspect thing may be
  genuine from a new address; the mark is a reason to look, never a verdict, and nothing but low
  confidence hides it.
- A decision shows only with a personal reason. A model that is too careful with `specific`, and a person
  who has not written to a company about the matter, see fewer offers than they might want. That is the
  cost of not becoming a catalogue.
- The history line tells the model how often the person wrote to a company, from counts only. The model is
  warned that it is context, but a model can still lean on it; the checks on every passage are what bound the
  harm.
- A declined offer stays closed for the calendar year only on a name the model gave the matter. Two names
  for one offer open it again; this is a known gap, chosen over hiding two different offers as one.
