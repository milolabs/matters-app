# 0045. Forwarding carries the message and its files

- Status: Accepted
- Date: 2026-11-05
- Builds on: [0020](0020-sending-outbox-and-compose.md), [0041](0041-attachments-never-block.md), [0043](0043-received-attachments.md)

## Context

A message can be answered but not passed on. Forwarding looks like a small variation of a reply, and
it differs in the three ways that matter:

- It has no recipients yet, and it starts a new conversation instead of joining one.
- People expect the files to go along, and those files are on the server, not on this machine. ADR 0043
  downloads a part on demand and ADR 0041 captures a file once into an immutable copy that a draft
  owns. Forwarding needs the second to be able to start from the first.
- The composer writes Markdown. Names and subjects written by strangers must not become links or
  formatting in a message the user sends under their own name.

We keep a message's text and sanitized HTML, not its source, and compose has no way to send HTML it did
not render itself (ADR 0020, rule 11). So a forward is text, and it has to say so.

## Decision

### What a forward is

1. `f`, or a button beside Reply all, forwards **the newest message of the open thread** that is not
   in Trash or Spam, unless the thread is being viewed from there. Its draft has no recipients and the
   focus goes to To. The composer's title is *Forward*.
2. **It is a new conversation.** No `In-Reply-To`, no `References`, no thread id: the recipient's client
   must not attach it to a thread they have never seen, and the sent message starts its own thread here.
3. The subject gets one `Fwd:` in front, whatever chain it already has (`Fwd:`, `FW:`, `PD:`, `WG:`, any
   case). `Re:` stays: `Fwd: Re: Budget` says what it is.
4. The body starts empty, for the user's own words, and then quotes the original:

   ```
   > Forwarded message
   > From: Anna Nowak (anna@example.com)
   > Date: 3 Nov 2026, 10:29
   > Subject: Budget
   > To: Miłosz Sobczak (milosz@example.com)
   >
   > The text of the message.
   ```

   One line each in both the text and the HTML part (the renderer breaks on every newline, so this
   holds, and a test goes through it). `Cc` appears when there is one. `Bcc` is never known. An
   address sits in round brackets, not angle ones: the text part is the Markdown source (ADR 0020,
   rule 12), so `<address>` would need a backslash that every plain-text reader would see.
5. **Everything in that header is escaped for Markdown**, one tested function in core, so a sender named
   `[Click here](https://evil.example)` is text in the mail the user sends. Names and subjects are
   escaped completely: no link, no formatting, not even a bare address or a `https://` in them. The
   body keeps the quoting replies have (`quoteLines`), since it went through the same text conversion.

### The files

6. Listed attachments of the message (not inline ones) become attachments of the draft, in order, each
   with its own id, name and size. Each is a chip at once, in the same frame as the composer, in the
   language of ADR 0041. A chip can be removed like any other, which is how a person forwards without
   them, and removing one that is downloading cancels what is left of it.
7. A forwarded file is captured the way any file is (ADR 0041, rule 2): the part is downloaded through
   the cache of ADR 0043 and copied into the draft's own immutable copy, so the cache can be swept with no
   effect on the draft. What is sent is what was captured, and the id names those bytes (ADR 0040, rule 2).
8. Where a file came from is stored with its row: `(message key, part id)`. That is what **Try again**
   uses, because the original path is a cache entry that may be gone.
9. Send follows ADR 0041, rules 7 and 8, unchanged. It may be pressed while a file is still on its way and
   the tray says what it waits for. **A message never goes out without a file that is on its chips.** If a
   download fails, the operation fails with the file's name and **Open draft**.
10. A file over the account's limit is not downloaded at all: it stays as a chip and `notifyIfLarge` says
    why, with Remove as the way on (ADR 0040, rule 3). The estimated size is what the limit is compared
    with, and it is replaced by the true size when the capture ends.

    | What happened | The chip | Action |
    |---|---|---|
    | Downloading | Ring with the true bytes (none under 1 MiB) | Remove |
    | Offline or failed | Couldn't download | Try again · Remove |
    | No longer on the server | No longer on the server | Remove |
    | Over the limit | The notice of ADR 0040 | Remove |

    A file already in the cache is not downloaded again, and several drafts forwarding the same file
    share one download, each keeping a copy of its own. Removing a chip stops its copy, and stops the
    download only when nobody else (another draft, a reader) is waiting for it. The cache copy is never
    touched by a removal.

### Saying what is not carried

11. If the message's list of files is not known yet (ADR 0043, rule 2), nothing can be added, and the
    composer says so in one line: *The attachments of this message aren't known yet, so they weren't
    added.*
12. If the message has a designed HTML layout or inline parts, one quiet line says: *Forwarded as text.
    Its layout and inline images stay behind.* Nobody should learn this from the recipient.

If the app quits during a download, the file stays `reading` and the next start downloads it again; a
send waiting for it stays held, and fails with the file's name if the file cannot be had then.

### Drafts

13. A forward autosaves like any draft. Like a new message, it can be reached again only through the tray
    until there is a list of drafts, a limit ADR 0041 already names. A reopened forward is titled *Forward*:
    the draft carries a flag for this, which is not in the fingerprint because it changes nothing that is
    sent. Closing one with nothing typed above the quote, no recipients and the subject as it came discards
    it, along with its copies. The quote is not what the person wrote, and neither is taking files off.
    The notices of rules 11 and 12 are shown when the forward is made, not when it is reopened.

## Consequences

- Forwarding keeps the guarantees of sending: approval is bound to the exact draft, files included, and the
  undo window and lanes apply.
- A forward needs the network for its files, and is honest about it, chip by chip. Text forwards work
  offline.
- A message's layout does not survive. Forwarding as an attached `.eml`, or carrying the original HTML, would
  fix that and is a separate decision. It needs the source, and rendering rules for HTML the user didn't write.
- `$Forwarded` is not set on the original, so other clients don't show it as forwarded. It belongs with
  `\Answered`, which is not set for replies either.
