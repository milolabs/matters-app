# 0037. Remembering image choices: one list of rules (amends 0024)

- Status: Accepted
- Date: 2026-11-04

## Context

ADR 0024 keeps remote images off and lets the reader allow them per message or per sender.
Today "per sender" is a list of addresses in `localStorage`, and it has four gaps:

- **A choice cannot be taken back.** The list can only grow, and nothing shows what is on it.
- **Mailing lists ask forever.** Many send from an address that changes, such as
  `bounce-123@mail.shop.example`, so a choice for one address does not hold for the next message.
- **The address is taken on trust.** Anyone can write a trusted address in `From` and learn that
  the message was opened, when, and from which IP. We do not read `Authentication-Results` yet.
- **There is no general preference.** A reader who wants images everywhere has no way to say so.

A separate allowlist and blocklist would give two places to look for one answer. A blocklist also
means little while the default is to block.

## Decision

1. **One list of rules, four levels.** The first level that has an answer decides:
   1. The choice for this message, which lasts while it is open and is not stored.
   2. A rule for the sender's address.
   3. A rule for the sender's domain.
   4. The general setting: `ask` (the default) or `always`.

   A rule is `allow` or `deny`. There is no separate blocklist: `deny` exists for an exception to a
   domain rule and for a sender blocked under `always`.
2. **A click never changes the general setting.** It changes only in Settings.
3. **The offer above the message:** `Show images` (this message), and `Always show…`, a menu that
   names the address and the domain in full, each only where the rule would hold for this message:
   the domain needs the verdict `pass` (point 6), and the address needs anything but `fail`. Once
   images are showing because of a rule, the message says so and offers `Turn off`. That removes
   the rule, and adds a `deny` for the address only if a broader rule or the general setting would
   still allow it. The words live together in `imageBar.ts` as whole sentences, and the layout does
   not depend on their length, so the bar can be translated.
4. **A domain means the registrable domain,** found with the Public Suffix List, and covers its
   subdomains. A rule for all of `co.uk` cannot exist.
5. **Domain rules are not offered for public mail providers** (Gmail, iCloud, Outlook, WP, Onet and
   the like), from a short list of our own, because they would allow millions of strangers.
6. **Allowing depends on the sender's authentication:**
   - The verdict is read when parsing and stored with the message: `pass`, `fail` or `unknown`. It
     comes from the topmost `Authentication-Results` header only, since that is the one the
     receiving server wrote, and lower ones can come from the sender. DMARC decides; without a
     DMARC result, an aligned DKIM pass counts.
   - `fail`: no `allow` rule applies, and neither does `always`. The reader can still choose
     `Show images` for the message, and the bar says the sender could not be verified.
   - `unknown`: address rules and `always` apply, domain rules do not.
   - `pass`: all rules apply.
   - `deny` rules apply whatever the verdict.
7. **Allowed images still lose declared pixels.** Images declared as 1×1 or 0×0 in the markup are
   removed before the page loads. A list of known tracker hosts is left for a later decision.
8. **Rules live in SQLite,** in a table of their own, with the general setting beside them. They
   are shared by all accounts on this computer and do not sync. Addresses already in
   `localStorage` become `allow` rules once, and the old key is then removed.
9. **Settings gets an Images section** (ADR 0036) with the general setting and the list of rules,
   each of which can be removed.

## Consequences

- A choice can be seen and taken back, and mailing lists stop asking after one choice.
- Images still load directly, as ADR 0024 decided, so an allowed sender's image host sees the IP.
  Settings and the `always` option must say so plainly.
- The verdict is only as good as the receiving server. One that neither writes nor strips the header
  lets a sender forge a `pass`. The harm is limited to learning that a message was read, and we do
  not verify DKIM ourselves, because that would mean a DNS query for each message.
- Mail synced before this keeps the verdict `unknown`, so domain rules do not apply to it: sync does
  not download a message it already has, so only adding the account again changes that. On a
  provider that writes no header, domain rules never apply.
- A rule given on a personal account also applies to a work account. If that proves wrong, rules
  gain an optional account; the table does not need it yet.
- Removing declared pixels is a heuristic: a tracker that declares no size, or a larger one, still
  loads.
- The Public Suffix List is MPL-2.0, allowed with a note under ADR 0013. It ships in the app, and
  its copy goes stale until the next release, which at worst offers too broad or too narrow a domain.
- Parsing reads one more header, and each opened message looks up its rules; watch both against
  ADR 0012.
