# 0043. Received attachments: listed at once, downloaded on demand, never run by accident

- Status: Accepted
- Date: 2026-11-04
- Refines: [0007](0007-local-first-sync.md) (rule 6)
- Follows: [0041](0041-attachments-never-block.md) ("seeing and saving received files is a separate piece of work")

## Context

The reader shows a paperclip and the word "Attachment". The file cannot be seen, opened or saved, so
an invoice that arrived by mail has to be opened in another client.

- We keep text and sanitized HTML, not message sources. The bytes of an attachment are on the server.
- `postal-mime` gives names and sizes when a message is parsed, but no part numbers, so it cannot say
  how to fetch one part later. IMAP `BODYSTRUCTURE` gives names, types, encoded sizes and part numbers
  for a few hundred bytes per message, with no download, and it works for mail stored long ago.
- `ImapFlow.download(uid, part, { uid: true })` returns a decoded stream of one part.
- An attachment is the most dangerous thing a mail client hands to the operating system. A name can
  hide what a file is (`invoice.pdf` + U+202E + `exe`, `../../.zshrc`), and a double click can run a
  program.
- Electron's `BrowserWindow.previewFile` shows a file in Quick Look on macOS, which runs nothing.

## Decision

### Knowing what is there

1. A message's attachments are rows in `message_attachments`: `(message_key, part_id, position, name,
   mime_type, size, content_id, inline)`, read with the thread, so the list is there in the same frame
   as the letter. `size` is the decoded size estimated from the encoded one (base64: 57 bytes of every
   78), which is close enough once a person sees it rounded. Inline parts are kept
   with `inline = 1` and are not listed. `messages.attachments_known` says whether the structure was
   read; a message whose `has_attachments` is 0 is known from the start.
2. Rows come from `BODYSTRUCTURE`, added to the metadata fetch of new mail. Mail stored earlier is
   filled in the way ADR 0042 fills `Reply-To`: the final batch of a folder's sync asks for up to one
   batch of that folder's messages with `has_attachments = 1 AND attachments_known = 0`, through a
   partial index, so a finished mailbox pays one probe.
3. **What counts as an attachment**: a leaf that is not the message's text or HTML body. It is inline,
   and not listed, when it has a Content-ID inside `multipart/related`. `message/rfc822` is one
   attachment and is not walked into. A part with no name gets one from its type (`message.eml`,
   `invite.ics`, `attachment.pdf`).
4. `has_attachments` is corrected from the structure when they disagree, since it decides the paperclip
   in the list and `has:attachment`. A correction is an ordinary change, with a `change_seq`.

### The name

5. Names are untrusted. One pure function in core, `safeFileName`, is used everywhere a name is shown
   or written. It decodes nothing further. It removes path separators, control characters and every
   format character, which covers the bidirectional overrides as well as zero-width characters and
   soft hyphens that would hide what an extension really is. A run of spaces becomes one, so spaces
   cannot push the real extension out of sight. It strips leading dots and trailing dots and spaces,
   avoids Windows device names, caps the length at 200 bytes keeping the extension, and falls back
   to a name from the type. What is stored is the result.

### Getting the bytes

6. Nothing downloads until someone asks. A chip press asks the sync worker for that part, over a
   connection of its own (a large download never holds up sync), at most two at a time per account.
   It streams to `received/<message key>/<part id>/<safe name>` in the app's data directory
   (`MATTERS_RECEIVED_DIR`) through a temporary name (`.part-...`) and a rename, so a broken download never looks like a file. No write transaction
   contains file I/O and no bytes pass through SQLite (ADR 0041, rule 10).
7. Progress follows ADR 0041, rule 5: at most four posts a second, not stored, no change event, one CSS
   variable on one ring. The same part asked for twice joins the running download.
8. The downloaded copy is a **cache**, not a record. It is deleted with its message and with its
   account. A sweep at start-up (in the sync worker, after launch, never delaying it; "used" is the file's
   modification time, which every download or open sets to now, since access times are unreliable) removes anything not used in 7 days and then the oldest until 2 GB
   remain. It is the only copy of nothing, so it is safe to lose. It has the protection at rest stored
   mail has, which is the operating system's.
9. A location that is gone or stale gets a definite answer, not a retry: *This message is no longer on
   the server.* Offline is its own answer, with Try again. Both name the file.

### Opening and saving

10. **The page never sees a path and never names one.** It asks main with `(message key, part id)`; main
    validates them (an integer; `^\d+(\.\d+)*$`), asks the backend over a line of its own to make the
    copy exist (downloading it if needed), finds the one file in that directory, and refuses
    anything else. A compromised page can only reach files already in the cache.
11. **Preview** is Quick Look (`previewFile`, macOS). It runs nothing, so it is offered for every file.
12. **Open** hands the file to the default app, and only for types that do not run. `isRunnableFile`, one
    pure function in core, has the list of extensions that execute or install on any supported platform
    (`app`, `command`, `sh`, `exe`, `msi`, `jar`, `js`, `dmg`, `pkg`, `scpt`, `lnk`, `webloc`, and the rest,
    with tests). It also has what is not a program but acts like one when opened: pages that run
    scripts in a browser with a local file's access (`html`, `svg`), system profiles (`mobileconfig`),
    disk images (`iso`), and Office files that carry macros (`docm`, `xlsm`). The last extension decides, trailing dots and spaces are ignored, and a name with no
    extension is not runnable: cached files are mode 0600, so they have no execute bit. Main checks it again, since main is the one that opens. A runnable file has **Save…** and
    Preview, with one line: *This kind of file can run programs, so Matters doesn't open it.*
13. **Saving** goes through main's save dialog, then a download if needed, then main copies to the chosen
    place (a clone where possible). Save all (2 files or more) asks for a folder and adds ` 2`, ` 3` to
    names already there, and never overwrites without the dialog having asked.
14. **Everything that leaves the cache is marked as from the internet**: `com.apple.quarantine` on macOS,
    so Gatekeeper still judges it. A failure to set it is logged and does not stop a save, but does stop
    an open.

### What the person sees

15. A strip of chips under the letter, in the composer's language (ADR 0041, rule 20), so a file looks the
    same on the way in and on the way out. A chip: a small type tag (`PDF`, `XLS`, `ZIP`), the name with
    its **middle** truncated so the extension stays visible, the size, and a save button on hover or
    focus. More than five files fold behind *12 more*. `Save all` sits at the end of the strip.
16. A press opens; `Space` on a focused chip previews; `⌘S` on a focused chip saves. Chips are buttons in
    the tab order and name their state to screen readers.
17. One ring tells the story, the same as a send (ADR 0041, rule 22):

    | Moment | The chip | Line or label |
    |---|---|---|
    | Not here yet | type tag | size |
    | Downloading | ring fills with the true bytes | 14 of 34 MB |
    | Here | type tag | size; a press is instant |
    | Offline or failed | type tag in `late` | Couldn't download · **Try again** |
    | Gone from the server | quiet | No longer on the server |
    | Structure not known yet | the old badge, no actions | Attachment |

    Under 1 MiB the ring is not drawn: it would flash. With reduced motion the ring steps and the label
    gives the number.

## Consequences

- A received file is one press away, offline once it has been opened, and the list costs no network.
- Sync gets slightly larger metadata fetches. `BODYSTRUCTURE` is small next to the sources it already
  downloads for new mail.
- There is a second directory of user files in the app's data. It is bounded and can always be rebuilt,
  ADR 0041 also asked for a line in "the privacy notes"; no such document exists in the repository,
  so none was invented. When one is written it must say that received files are cached on disk for up
  to 7 days.
- Preview is macOS only. Elsewhere Open and Save remain. Windows and Linux need their own "from the
  internet" marks before they ship, and that is to be decided with those platforms.
- Inline images too large to embed (`MAX_EMBEDDED_BYTES`) remain broken images. Decided with `cid:`
  images, as ADR 0041 said.
- Forwarding (ADR 0045) reuses this download.
