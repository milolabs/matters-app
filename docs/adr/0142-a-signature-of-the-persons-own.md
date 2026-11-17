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
   field was opened closes only its own. A save on its way is kept per account, not per field: a
   field closed while its save goes and opened again starts with the text being saved, says
   "Saving…" and lets no Save through until that save ends, so the last Save pressed is always
   what the store ends up holding. The row then says "Signature:" and its first line. A signature is Markdown, at
   most 2,000 characters, kept normalized: line ends as `\n`, no control characters, no white space
   at the end of a line, no empty lines around it, and without a `--` line the person typed at its
   top, since the app writes that line itself. A line that starts with `>` is refused, with the
   reason: it would read as quoted mail to the reply's fold and to the agent's split. A code block
   in it is fenced plainly or refused: the same line of backticks or tildes above and below, with
   nothing after it and no such line inside (rule 4 says why). Images, raw
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
     the quote (a reply with no signature in two). So the delimiter right under a line of text never makes that line a heading, and it
     is never an `<hr>` or a list item. The signature is a quiet block, `<div
     class="matters-signature">`, in the colour the sent HTML already gives quotes (`#6e6e73`) at
     13 px, with the delimiter as its first line, as text. The quote below it stays a
     `<blockquote>`. The three parts are one message: a link defined in one (`[site]: https://…`)
     is a link where another uses it.
   - Where the quote starts (`draftSections`, the one split every part of the app uses: the
     renderer, the sender change, the agent's helpers, a forward's "nobody wrote in", the editor's
     signature lines, its fold and where it offers a value). The split, the blocks the agent's text
     is cut at (rule 6), the agent's check for quoted lines and the editor's look all come from one
     reading of the draft's lines (`readDraft`): each line is code, a `>` line, a `-- ` line, a
     `--` line after an empty one, or text, and nothing else in the app tests a draft's lines for
     these. The quote is the app's own: a reply's "On …
     wrote:" line and its `>` lines, or a forward's part from `> Forwarded message` on, which the
     app always writes under the signature, at the end of the draft. A person may write `>` lines
     of their own anywhere (a blockquote, a `> x` inside a code block); those are their text.
     - A line inside a fenced code block (from a line of three or more backticks or tildes to the
       line that closes it) is never a quote and never a delimiter. This is the reading of a draft
       that may hold the app's signature; text in which the app placed none (a model's answer, the
       person's own text before a turn) is read plainly (rule 6). In a draft a fence never closed
       is text. Fences are read from the top, as Markdown reads them, with one precedence: the
       signature the app placed is never code. A code block that would hold a `-- ` line is closed, the line
       code (an SQL comment), when the text under its closing line closes every fence it opens or
       has a `-- ` line outside code; else, when the text under one of those `-- ` lines closes
       every fence it opens, the block's fence is left open, as text, and that line is the
       delimiter. A signature fenced plainly (rule 1) closes every fence it opens, and a fence above
       it closed at its first fence line would leave its last one open; so a fence the person left
       open above it is never closed inside it. Two shapes read two ways, and are read for the
       signature: a `-- ` line in a code block with a fence left open further down and no other
       `-- ` line (the block's fence is the one left open, the `-- ` line the delimiter); and a
       fence left open with a `-- ` line under it above the signature placed (the first `-- ` line
       is the delimiter, so the signature read is not the one placed, and stays as the person's).
       Markdown reads a fence left open as code to the end; the renderer renders the parts apart,
       so in the HTML that code ends where the person's part ends, and the signature and the quote
       are never inside a `<pre>`. Where the two readings differ, the part boundaries are ours and
       Markdown's reading holds inside each part; the text part is the source as it is.
     - The delimiter is the first `-- ` line. With one, the quote starts at the first `>` line
       below it, with the line just above when that is below the delimiter, not empty, and ends
       in a colon; with no `>` line below it there is no quote. A `>` line above the delimiter is
       the person's, whatever introduces it.
     - With no delimiter, the quote starts at the last opening the app writes: an "On … wrote:"
       line right above a `>` line, or a `> Forwarded message` line, each at the start of a run of
       `>` lines. Without one (the person reworded it), at a line ending
       in a colon right above the run of `>` and empty lines that ends the draft. Else there is
       no quote: `>` lines with nothing of the app's around them are the person's.
     - The signature is the delimiter and what follows it up to the last line before the quote
       that is not empty. A `-- ` inside the quote (`> -- `) is the other side's. A person who
       types their own `-- ` under the app's quote (writing below it, with no signature put in)
       makes everything above that line their own text, the quote included. Everything above the signature (or the quote) is the person's own; everything from
       the start of the quote on is the quote, words typed between its lines included.
     - So the person's blockquote above the signature is rendered as a `<blockquote>` in their own
       part, the signature is the quiet block, and the app's quote stays the quote below it; the
       signature follows the sender (rule 5) with it there; and it goes to the agent as the
       person's text (rule 6). The same holds for `>` lines a model wrote (a line of the message
       it answers, in a prepared reply, an offered message, a rewrite): they stay in the reply's
       own part as a blockquote, and the signature joined under them is still the signature. A
       draft carries no mark of where its quote began; the shape of the app's own lines is the
       anchor.
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
   asked for when the sender changes, and the sender, its message limit and its signature change
   together once the answer came: the sender shown and saved is the new one only from then, so the
   two never disagree. An answer that does not come leaves the sender as it was, with its
   signature, and the composer says so in its line of problems; choosing the account again asks
   again. An answer about another account counts as one that did not come: the chosen account
   was removed meanwhile, and its replacement's signature is not its own. Send and Close wait
   for a sender chosen before them, and once either has begun the sender cannot be changed (the
   list is disabled), so neither goes with a sender and a signature
   that were not chosen together. Send stops when the sender it waited for could not be prepared,
   so the person sees which account it would go from. After that the composer is as it was
   before the choice: the next Send goes from the sender shown. The line that says the choice
   failed stays, a saved draft does not take it away, until the account is chosen again or a
   Send goes from the sender shown.

6. **The agent writes the words; the code places the signature.** The signature is set apart from
   the person's lines as the quote is, so it never goes to the model, as an instruction or as data,
   and is joined back as it was. The prompts for a rewrite, for answers and for writing as the
   person asks now say: do not add a signature or a sign-off block under the text, the app adds the
   person's own. A block the model writes anyway is cut, so a draft is never signed twice; the
   cut is for what the model added, never for the person's own lines, and one function in core
   does it for every helper (`keepOwnBlocks`). Its contract:

   - It takes the person's own text before the turn (empty when the text is all the model's) and
     the model's answer, and gives the text to keep. It never refuses.
   - A block is a delimiter line and the lines after it up to the next delimiter line or the end. A
     delimiter line is `-- ` anywhere, or `--` on the first line or after an empty line, outside
     every fenced code block; a `--` right under a line of text underlines a Markdown heading,
     which is text and starts no block. The answer and the person's text before the turn hold no
     signature the app placed (the person's has it split off), so both are read plainly, by one
     rule, and the person's blocks are found alike in both: fences from the top, as markdown-it
     reads them, with none of rule 4's precedence for the signature. A closed fence is code
     whatever follows it, so a `-- ` line in a code sample is code, and the sample, its closing
     fence and the text under it stay, with or without a fence left open further down. A fence
     never closed is code to the end, as Markdown renders it: a model that left a code block open
     keeps all of it, an SQL comment in it included, and a sign-off it wrote inside that block is
     code and stays (visible in the draft, which the person reads before sending). So in a
     model's text a block starts only at a delimiter line outside every fence, closed or left
     open. When the person's blocks are put back under a body that leaves a fence open, a line
     closing it comes first, so they are not code. One reading of the draft's lines does both
     (`readDraft`, with `placed: false` for this one); containers such as list items are not
     read, so a fence left open inside a list item runs on to a fence after the list.
   - A block of the answer is kept if and only if it is one of the person's blocks: its lines the
     same, line ends and white space at the end of a line aside. A block the model reworded is not
     the person's. Each of the person's blocks is matched at most once, in whatever order the
     answer has them. Every other block is the model's and is cut.
   - A block of the person's the answer does not have is restored in place of one of the model's:
     the first not matched (in the person's order) where the first block of the model's stands (in
     the answer's order), and so on, so a sign-off the model reworded or moved comes back as the
     person wrote it, where the model put it.
   - The person's blocks still missing after that are put back after the last kept block (after
     the body when none is kept), in the person's order, one empty line between parts. The prompts
     tell the model to add no sign-off, and an obedient model often removes the person's typed one
     too; refusing that would fail the helpers for exactly the people who sign by hand. So the kept
     text always holds the person's blocks, each once, as they wrote them.
   - Only then are the answer's checks run (every gap kept, no quoted line, no subject line, not
     most of the draft dropped), on the kept text against the person's draft. A `>` line of the
     person's own text (a blockquote above the signature) is theirs: the prompts say to keep the
     draft's own such lines and to write no other, and the answer may have each of them as often
     as the draft does; any other quoted line is refused as before. A gap in a block of
     the person's that is put back is their text and counts as kept; a gap that stood only in a
     block of the model's, one it moved out of the body included, is cut with that block, and the
     answer is refused for it. Nothing left at all is refused as before.

   This holds for a rewrite, for answers and for a text written as asked. The reply the agent
   prepared in the background (ADR 0052), which is put above the signature and the quote, and a new
   message the agent offered (ADR 0102), whose words get the person's signature under them, are
   all the model's text: every block in them is cut (`withoutSignature`). A prepared reply that is
   empty once cut (only a sign-off block) makes no draft, as an empty answer is refused. The writing prompts
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
