# 0142. A signature of the person's own, per account

- Status: Accepted
- Date: 2026-11-16
- Amends: [0020](0020-sending-outbox-and-compose.md) (rule 11: the HTML of a text with a signature
  is rendered in parts), [0045](0045-forwarding.md) (rule 13: the signature put in is not what the
  person wrote), [0098](0098-the-agent-helps-write-a-reply.md) and
  [0132](0132-the-agent-helps-write-a-new-message.md) (the signature is set apart like the quote, and
  the prompts say the app adds it), [0138](0138-erasing-what-matters-keeps.md) (the review names
  signatures with the mail)
- Builds on: [0011](0011-markdown-compose.md) ("signatures are Markdown too"),
  [0012](0012-performance-budgets.md), [0036](0036-settings-window.md),
  [0100](0100-a-reply-is-written-under-its-thread.md),
  [0101](0101-a-new-message-reads-like-a-letter.md)

## Context

The reader folds the signatures in other people's mail (`splitSignature`, at the last `-- ` line of
a plain segment), but the person had no signature of their own. ADR 0011 said in one line that
signatures are Markdown too, and nothing more was built.

Read from the code on 2026-11-16:

- A message starts in core: `prepareNewMessage`, `prepareReplyDraft` and `prepareForwardDraft` read
  the accounts (`AccountStorePort.list`) and build the first text. A new message starts empty; a
  reply with `\n\n`, then "On …, … wrote:" and the `>` lines; a forward with `\n\n` and
  `> Forwarded message`. The editor opens with the caret at 0, above all of it.
- The composer may change the sender of a new message and of a forward (`canChangeSender`), and
  asks `prepareNew` of the new account for its message limit. A reply stays with its account
  (ADR 0050).
- The agent's help (ADR 0098, 0132) gets the person's lines above the quote (`splitDraft`), never
  the quote, and its answer is joined back above it (`joinDraft`). The prompts already said "do not
  add … a signature the draft does not have"; the background drafts say "no signature block".
- An account's settings are columns of `accounts` in SQLite. Removing an account deletes its row;
  erasing everything deletes the database (ADR 0138).
- The text part of a message is the Markdown source itself (ADR 0020, rule 12); nodemailer encodes
  it as quoted-printable when it needs to, which keeps a trailing space as `=20`.
- In Markdown, `--` under a line of text makes that line a heading (a setext heading). `-- ` alone
  after an empty line is a paragraph, not a rule (that takes three) and not a list item (the dash
  is followed by a dash, not a space).

## Decision

1. **One signature per account, empty by default.** Matters adds no line of its own, ever: no
   "Sent with", nothing under the person's signature. It is set in Settings › Accounts, in the
   account's row: a *Signature* button opens a small field with the composer's own editor (the live
   Markdown of ADR 0100, the same type and colours), *Save signature* and *Cancel*, ⌘↵ saves and
   Escape closes, in the field or on its buttons. One field is open at a time; what is typed in it
   survives the list of accounts being read again, and a save that ends after another account's
   field was opened closes only its own. The row then says "Signature:" and its first line. A signature is Markdown, at
   most 2,000 characters, kept normalized: line ends as `\n`, no control characters, no white space
   at the end of a line, no empty lines around it, and without a `--` line the person typed at its
   top, since the app writes that line itself. A line that starts with `>` is refused, with the
   reason: it would read as quoted mail to the reply's fold and to the agent's split. Images, raw
   HTML and anything remote cannot come out of it: the renderer has images off and raw HTML off
   (ADR 0020, rule 11), so such text is sent as text.

2. **It is text in the draft, not something added at send time.** A new message, a reply or a
   forward started for an account with a signature starts with it in its text, where the person
   sees, changes or deletes it like any other line. What is sent is what was approved: the
   fingerprint and the approval of ADR 0020 are unchanged, and nothing is appended after them. A
   draft that exists is never changed by a later change of the signature, and a text that already
   has one never gets a second (`placeSignature`).

3. **Where it goes.** The core places it in the prepare use cases, from the account they already
   read. A new message: an empty line to write on, an empty line, then the signature
   (`\n\n-- \n…`). A reply and a forward: in the same place above the quote or the forwarded part,
   one empty line from it. The caret stays at 0, above the signature, where the person writes. A
   new message the agent offered (ADR 0102) opens with the agent's words and the signature under
   them, put there by the code.

4. **The delimiter.** The signature stands under the line `-- ` (dash, dash, space; RFC 3676,
   section 4.3).
   - In the Markdown source and the text part it is that line exactly, the space included. The
     editor, the draft store, the renderer's `text` and the MIME builder keep it as it is (tested
     through each, and through the parser back).
   - In the HTML part the text is rendered in three parts: the person's lines, the signature, and
     the quote. So the delimiter right under a line of text never makes that line a heading, and it
     is never an `<hr>` or a list item. The signature is a quiet block, `<div
     class="matters-signature">`, in the colour the sent HTML already gives quotes (`#6e6e73`) at
     13 px, with the delimiter as its first line, as text. The quote below it stays a
     `<blockquote>`. The three parts are one message: a link defined in one (`[site]: https://…`)
     is a link where another uses it.
   - The signature is the first `-- ` line above the quote and everything under it up to the quote
     (`draftSections`). A `-- ` inside the quote is the other side's.
   - The reader's `splitSignature` folds what we send: the words above are the body, and the
     signature under them is shown quietly. In a reply, the plain text under `-- ` holds the line
     that introduces the quote as well; that is how any reader that folds at the delimiter sees a
     signature above a quote, and the quoted lines stay quoted.

5. **Changing the sender.** While the signature in the text is exactly the one that was put in
   (the delimiter and the lines, as they were), it follows the account: the new account's takes
   its place, or it goes for an account with none, or one is put in when there was none. Once the
   person changed or deleted it, it is theirs and is left alone, then and after. For a draft
   opened again, "the one put in" is the account's signature as it is now. The new text replaces
   only what changed in the editor, so the caret stays. Choosing a sender is still not writing: a
   message nobody wrote in leaves nothing behind (ADR 0101). The new account's signature is
   asked for when the sender changes; Send and Close wait for that answer, so the new sender never
   goes with the last one's signature.

6. **The agent writes the words; the code places the signature.** The signature is set apart from
   the person's lines as the quote is, so it never goes to the model, as an instruction or as data,
   and is joined back as it was. The prompts for a rewrite, for answers and for writing as the
   person asks now say: do not add a signature or a sign-off block under the text, the app adds the
   person's own. A block the model writes anyway is cut before the text is joined, from its
   delimiter on: a `-- ` line, or a `--` line that does not stand right under a line of text (under
   one, `--` underlines a Markdown heading, which is the model's text and stays), so a draft is never signed twice; that holds for the reply the agent prepared in the
   background too (ADR 0052), which is put above the signature and the quote. The writing prompts
   are not cached and carry no version, so there is no marker to change.

7. **Where it is kept.** In the account's row of `accounts`, a column `signature` added by
   migration 58 (NULL is none). The composer reads it with the account it already reads; removing
   the account removes the row; erasing everything removes the database, and the review now names
   signatures with the mail. It leaves this computer only inside a message the person sends. The
   worker writes it, as every account change (`setSignature`), and the windows hear that the
   accounts changed.

8. **Speed.** Opening a composer costs nothing new: the signature comes with the account the
   prepare use cases already list, and with the answer to `prepareNew` the composer already asks
   when the sender changes or a draft is opened again. No new request, no new read per open.

### Not tried, and why

- **Adding the signature at send time.** It would keep drafts clean, but what is sent would not be
  what was seen and approved (ADR 0020), and the person could not change it for one message.
- **A separate field under the editor for the signature.** It would make rule 5 trivial, but it is
  a second place to write in, and a reply under its thread (ADR 0100) has room for one.
- **`-- ` as a hard break or an escaped line in the Markdown.** Writing `\-\- ` or adding two
  spaces would change the text part, which must carry the line exactly for other mail programs.

### Not in this decision

- Images and HTML in a signature, and remote content of any kind.
- Several signatures per account, a different one for replies, one per alias.
- Taking the signature from the server or the provider's settings.
- Putting the signature under the quote.

## Consequences

- People get a signature the way they expect, and see it before they send.
- A plain-text reader that folds at `-- ` folds a reply's attribution with the signature. The
  quoted lines stay quoted, and our own reader shows them as a quote.
- Changing a signature does not reach drafts already started; they show the old one until it is
  changed there.
- A `[placeholder]` in a signature blocks Send like any other gap (ADR 0096): it is text in the
  draft. The field shows it marked as the composer does. A value the agent suggests for a gap is
  offered and put in only in the person's lines, never in the signature, which the agent did not
  read: the person fills a gap of their signature themselves.
- A model told to write in a fixed form could still end with a sign-off line of its own ("Best,
  Anna") without a delimiter; that is words, not a signature block, and is kept.
- Not verified: how other mail programs show the HTML part's quiet block, beyond its being a
  plain `div` with inline styles. Our renderer, nodemailer and the parser are tested end to end.
