# 0078. The sender leads

- Status: Accepted
- Date: 2026-11-08
- Builds on: [0028](0028-people-in-suggestions.md), [0048](0048-trusting-authentication-results.md), [0073](0073-the-thread-on-one-grid.md)

## Context

The owner could not see who had written. The reader opened with the subject, and the sender was one
line of grey names under it, behind the title; the list showed the name as one more line of text.
Everything about the mail was louder than the person it came from. The avatars of ADR 0073 were
neutral grey, so even where a person was drawn, one person looked like the next.

## Decision

1. **The reader leads with the sender.** Above the subject, a header on a grid of
   `48px minmax(0,1fr) auto` with a 14 px gap, centred vertically:
   - a 48 px avatar (letters 16 px, semibold);
   - line 1: the name, 17 px semibold, and the verified badge when there is one;
   - line 2: 12 px, secondary: the address, then what the index knows (rule 4);
   - the thread's toolbar, and the "N matches ↑↓" control of ADR 0077 when it is there.
   The subject (22 px serif) follows 16 px below, then the line with the other people, the number of
   messages, the labels and the account. That line no longer names the person the header shows.
2. **Who the header shows** is the other side of the conversation: the sender of the newest message
   that is not the person's own. A message is the person's own by the rule of ADR 0048 (their address
   and either the server's word for it or a Sent or Drafts folder). If every message is the person's
   own, it is the first person they wrote to, with an arrow before the name. If they wrote to nobody
   else, it is the person, as "You", on their account's filled avatar. The name and the avatar open
   the same menu as a name in a letter (only from, exclude, ADR 0028), when the header shows a sender.
3. **The verified badge** says "Verified · domain" with a shield and a tick, in the `--good` colour,
   only when the authentication result of the message the sender was taken from is a pass. That is the
   verdict the message already carries (`senderAuth`, decided by ADR 0048 from the headers of a server
   the account trusts) and the one the image bar reads; nothing else is consulted. A failed or unknown
   result shows nothing; the warnings elsewhere are unchanged. The domain is the one after the `@` of
   the address. A person who was written to never gets a badge.
4. **The line under the name** has the address at once and, when the index answers, "In 14 messages ·
   last mail 5 days ago". `count` in the `people` table (ADR 0028) is the number of messages that name
   the address as sender, recipient or cc, and `last_ms` is the date of the newest such message. Neither
   knows who wrote. So the line does not say "together", and does not say "you last wrote": it says
   in how many messages the person is named, and when the newest mail naming them is from ("today",
   "yesterday", "5 days ago", "3 months ago", by calendar day). `count` stays the hint ADR 0028 calls it
   (removed mail does not lower it); the read still checks that the index holds mail for the address.
   The answer comes from a new read, `getPerson(address)`: one primary-key read of `people` and the
   same one-phrase check of `message_fts`. It is asked once when a thread is opened and never waited
   for: the name, the avatar and the address draw first, and the line has its height (16 px) from the
   start, so the arrival moves nothing. No answer, or a failed one, leaves the address alone.
5. **Avatars in the list.** Each row starts with a 32 px avatar (letters 12 px, semibold) on the grid
   `32px minmax(0,1fr) auto`, 10 px gap; the row is still 68 px, and the sender, subject and snippet
   lines, the account dot, the clip, the date, the selection and the marks of ADR 0077 are as before.
   The unread dot sits on the avatar's top-left corner, 8 px, ringed in the row's own background (the
   selected colour on a selected row), so the unread state stays the one dark dot. A row of the person's
   own mail shows the person it went to, with an arrow before the name, as the reader's header does.
   Matters rows use the same avatar for the other person; the late dot or the agent's ring takes the
   corner. A matter knows the person by name only, so its hue comes from the name.
6. **One colour per person.** `personTint(address)` hashes the lower-cased address (FNV-1a) into one
   of eight hues, the account palette `--acct-*`, which already has a light and a dark value. The
   avatar is a 24 % wash of the hue on the page, with the hue pulled 30 % toward the ink as the letters.
   Both colours are opaque. The letters reach at least 4.5:1 against the wash on every hue in both
   themes (the lowest are ochre in light and plum in dark, at about 5.2:1 and 5.4:1); a test reads the
   tokens and the two shares from the stylesheet and fails if a change breaks it. The person's own
   messages keep the account's filled avatar (ADR 0073). The list, the header, the rows of a thread and
   the people in ⌘K use the same function. Letters and hue are worked out once per address and name
   (a small `Map`), so a row draw is a lookup.

Not in this ADR: photos or logos, a contact card, "you last wrote" (needs to know which address is
the person's when the index is written), a verified badge for mail the server never judged.

## Consequences

- The person is the first thing in a thread, and a face (letters and a hue) in every row, so a list
  can be scanned by person.
- The header costs one indexed read per opened thread, off the path of drawing.
- The text of a list row starts 22 px further right than before; a narrow list shows fewer letters.
- Eight hues mean two people in a thread can share one. The letters and the name still tell them
  apart; the hue is a help, not an identity.
- The count is only as true as ADR 0028 says it is.
