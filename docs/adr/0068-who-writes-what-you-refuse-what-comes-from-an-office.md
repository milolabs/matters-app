# 0068. Who writes, what you refuse, what comes from an office

- Status: Accepted
- Date: 2026-11-06
- Amends: [0066](0066-what-you-would-regret-not-seeing.md) (relation to the sender, when a decision is for now, what may become a thing), [0067](0067-what-the-owners-labels-taught.md) (how long a reading may stay unsure, what is checked)

## Context

ADR 0066 made the person's relation to a sender only a support: a few points for a regular contact or a known
company. The owner then said plainly what matters most: whether they had interaction with the person writing,
at the same address or at another address of the same person, with points that fall with the time since the last
one. Three more things came with it.

- The owner wants to say "do not show this kind of mail any more", by a click and in a few typed words.
- Important mail from people the owner never wrote to, such as government and local government, is not
  recognised by any relation. It has to be recognised by what it is.
- An offer from a company the owner has not dealt with for a long time, and that sends a lot of mail nobody
  answers, is not important, whatever its topic and however personal the model finds it. A reading of a real offer
  also came back with an empty case name and no anchors, so a real topic match was lost.

## Decision

1. **A bug.** `sharesTopic` also takes the thread's subject, wherever it is asked, so a reading with no name
   for the matter still matches what the person wrote about.

2. **Interaction recency** replaces `REGULAR_CONTACT` and `KNOWN_COMPANY`, and overrides ADR 0066's "relation is
   only support": it is the strongest single signal, still points, not a hard tier. There are three levels,
   each with a maximum: the same address (30), the same person at another address (24), the same company (12).
   The best level counts. Points are `round(max * 0.5 ^ (days since the last message the person sent there / 180))`,
   so an old relation fades to nothing by itself (30, 15 and 1 points for the same address at 0, 180 and 1000 days).
   It applies on every path. The `why` says it: "You last wrote to them N days ago.", "You last wrote to what
   looks like the same person at another address N days ago.", "You last wrote to this company N days ago.", with
   months or years in words when large. The stranger penalty applies only with no level at all, and never to an
   office.
   - The same person is matched by the name the person's own Sent mail gave a recipient: the fold of the sender's
     display name against the folded recipient names. The name must have at least two words and none of a small
     list of role words (biuro, kontakt, info, support, team, office, obsluga, pomoc, customer, service, sales,
     sekretariat, administracja). This is knowingly approximate: two people can share a name and one can be
     written to under two spellings. A mistake costs a few points and a sentence that says "looks like"; it never
     hides or invents a thing.
   - `know` may also show without a personal passage when the same address or person was written to within 180
     days. A `know` from anyone written to at address or person level within 365 days is marked `check` after 45
     days of silence instead of 14. `CHECK_UNKNOWN_DAYS` is 30 instead of 14.

3. **Kinds of mail, and "Not like this…".** The reading has a required `category`: personal, work, official,
   bill, paymentProblem, account, order, offer, terms, newsletter, notification or other (definitions are in the
   prompt). A value outside the list reads as `other`. It is stored in `reading_json` and used only by code; the
   model's prose never reaches `why`.
   - A rule has a new scope, `category`, whose subject is one of the kinds but `other`. The table of rules is
     rebuilt to widen its check, keeping rows, ids and the unique index. Unlike a sender rule it cannot stop a
     thread from being read, because the kind is known only from the reading, so it hides at read time. One helper
     (`categoryRuleCovers`) serves the list, the count a closing covers, drafting ahead (through the list) and a
     thread's own banner. A category rule therefore still spends a reading on a thread of that kind the first time.
     It is the person's, appears in Settings and the journal, and has an Undo.
   - The prompt says: if the person's own instructions say they do not want a kind of mail, answer state `none`
     and intent `none` for it.
   - The reader has `Not like this…` for every intent: "Don't show <kind in words>" when the kind is not
     `other`, "Don't show mail from <sender>" (the existing sender rule path), and a short text box whose Save
     keeps a standing instruction for reading (`understand`), with the honest line "Applies to mail read from now
     on." A rule hides the row at once and is undone from the line.

4. **Mail from an office.** `isOfficialAddress` (core, pure) is a Polish-first starting list: a host ending in
   `.gov.pl`, `.gov`, `.gov.uk` or `europa.eu`, or `zus.pl`; a registrable label starting with powiat, gmina,
   starostwo or urzad; a host starting `um.` or `ug.` under `.pl`. A local part of newsletter, news, biuletyn and the
   like is not official, so a public body's bulletin does not count.
   - `selectCandidates` keeps a thread whose other side includes an official address, even if every message is
     from a program or the subject is no service notice; `orderForReading` reads such threads first.
   - The reading calls mail `official` when a public authority, court, tax office, social insurance,
     municipality or similar writes about this person's own case, document or obligation. A public body's bulletin
     is `newsletter`. The AI category is checked only by its quote and by the address; the code cannot know more.
   - A new path, `official`: category official, a passage and an intent other than `none`. It needs no personal
     passage and no relation. Base 25; +10 on the state path when the category is official and the address is an
     office's. No stranger penalty. The lead is "This is from a public office." It is for now when the intent is act,
     reply or decide and it is not `check`, or a date is near, or it is news within 14 days. It is checked only
     after 60 days of silence, and an office's mail never leaves the list for silence, unless a date is ahead. The
     thing is `official`, and the row says "Official".
   - Category official claimed from a shared free-mail address is `suspect` instead, with "It says it comes from
     a public office, from a free mail address. It may not be genuine." The money sentence stays for the other case.

5. **Interaction decides what is for now, and unanswered mail costs.** This corrects ADR 0066, rule 2. A
   `decide` is for now only when its window ends within `DUE_SOON_DAYS`, or the person dealt with the sender at any
   level within 180 days and it arrived within 7 days. A topic match or the model's `forYou` alone no longer
   makes it for now: it shows in the rest. The plain "arrived within 7 days" rule is removed.
   - A new local signal, `ignoredSince`, counts the messages that reached the person from the sender's company
     (their address when it has none) after the last one the person sent there, or in all, not counting this
     thread's own. It is asked once per company per list build, only for offers and news on the list, for at most a
     year back and 100 messages, so the cost follows the candidates. At 5 or more on a `decide` or `know` path it
     takes 10 points, with "They have sent N messages since you last wrote." Never for an office, and not on a state
     path.

`ANALYZER_VERSION` stays 4: no real mailbox has run it yet, so the prompt and the schema could still change.

## Consequences

- The owner chose interaction recency as the strongest single signal. The half-life of 180 days and the maxima
  (30, 24, 12) are judgments, not tuned; so are 60 and 45 days, 5 messages and 10 points. A thing from someone the
  person wrote to this week now scores up to 30 points above one from a stranger, which is more than ADR 0066
  allowed, on purpose.
- Name matching is approximate. A common name can match another person, and a person written to under another
  name does not match; the wording ("looks like") says so.
- The official list is a start. A public body outside it is not let past the program filter by its address, and
  depends on the model calling its mail `official`; an unlisted office writing from a program may not be read at
  all. The AI category is checked only by its quote and the address, so a model can call something official that is
  not; a free-mail address that claims it is marked, but a look-alike domain is not caught.
- A category rule hides at read time and still spends a reading on each thread of that kind the first time it is
  seen. A rule cannot change what an earlier reading already stored as a different kind.
- The person's own words under `Not like this…` apply to mail read from now on; what was read before keeps its
  reading, and the line says so.
- An old offer from a company that keeps writing is in the rest, with a penalty and no interaction points. A
  company that writes five unanswered messages and then makes an offer the person does want is penalised too; the
  person can still find it in the rest.
- The `ignoredSince` count reads at most a year back and 100 messages per company, so "20 messages" may be a floor.
- On real mail the model often called an e-government system's notice plain `notification`, so an act, reply or
  news from an office's address counts as official unless the model called it `newsletter` or `offer`. Only
  the model's own `official` makes news for now. A `windowEnd` is kept only on a `decide`, because a model gave
  one on a failed payment and it passed for a deadline still to come. Words of organisations stop a name like
  a company's from matching a person.
