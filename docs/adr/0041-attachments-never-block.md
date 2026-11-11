# 0041. Attaching and sending files never block anything

- Status: Accepted
- Date: 2026-11-04
- Refines: [0020](0020-sending-outbox-and-compose.md) (rules 6 and 7), [0012](0012-performance-budgets.md), [0019](0019-backend-router-and-sync-worker.md)
- Depends on: [0040](0040-attachments-and-carriers.md)

## Context

The send path was built for a few kilobytes of text, and each of these becomes a problem at 25 MB:

- `MessageComposerPort.compose` returns the whole message as a `Uint8Array`, and `setMime` writes it
  as a BLOB in `send_operations`, inside the exclusive write transaction every sync batch waits for.
  It would also pass through the WAL.
- `processOutbox` hands off one operation at a time. A one-line reply waits behind a slow upload.
- `keepSentCopy` runs inside the hand-off, so the same outbox also waits for the second upload to
  the Sent folder.
- `submit` calls a connection lost after the DATA command began `unknown`. A long upload loses its
  connection far more often than a short one, so most of these would become "Not sure it was sent"
  for something that cannot have been delivered, because the end-of-data marker was never written.
- Shutdown gives a hand-off 3 s (`STOP_WAIT_MS`) and then terminates the worker, which turns a
  normal quit during an upload into a false `unknown` at next start.
- Size is not sent on `MAIL FROM`, so a message the server would refuse is uploaded in full first.

Three things from the libraries shape the answer. Nodemailer's `MimeNode.createReadStream` builds a
message as a stream and reads attachments from a path. `SMTPConnection` passes `envelope.size` as
`SIZE=` and refuses locally above the size the server announced. ImapFlow's `append` takes only a
whole buffer, so a Sent copy costs the size of the message in memory for as long as it takes.

## Decision

### Attaching

1. **The chip appears in the same frame as the drop.** Name and size are already in the renderer's
   `File`. The renderer never reads a file's bytes and never learns its path.
2. **A file is captured once, into an immutable copy** in the app's data directory, named by the
   attachment's id. What goes out is what was attached, even if the original is edited, moved or
   deleted afterwards. APFS clones are used when source and data directory share a volume
   (`COPYFILE_FICLONE`, which costs almost nothing), and a stream copy otherwise. SHA-256 is computed
   during the capture and checked when the message is built.
3. **The backend accepts grants, never paths.** An API that takes a path would let a compromised
   renderer attach `~/.ssh/id_rsa`. Paths come only from main's open dialog, or from a trusted drop
   event read in the preload with `webUtils.getPathForFile` (which returns nothing for a file made
   by script). Main turns each into a one-use grant, and the renderer gets only the grant id, name
   and size. A pasted image has no path, so main writes it to a private temporary file and grants
   that, which leaves one way in for every file. The temporary file goes after the capture.
4. **File work has a thread of its own**: an attachment worker (`node:worker_threads`) next to the
   router and the sync worker. It starts on first use and exits after 30 s idle, so launch does not
   pay for it. It captures, hashes and builds messages, at most two jobs at a time. The router
   still never touches a file, and the sync worker's batches never wait for a hash.
5. **Progress is not data.** It is posted at most four times a second, is never written to SQLite
   and does not cause a change event. It sets one CSS variable on one dot, so no list renders again.
6. An attachment is `reading`, `ready` or `failed`, in a table of its own. A file over the
   account's limit is not captured at all: it stays on the draft as a chip, `notifyIfLarge` says why
   (ADR 0040), and no disk is spent on something that cannot be sent inline.

### Send is never disabled by a file still being read

7. Pressing Send while a file is `reading` is allowed. Consent covers the attachment's id, and the
   id names the copy being captured. The composer closes and the tray says what it waits for, with
   Undo. An operation is not claimed while one of its files is `reading`, does not count as overdue
   while it waits, and goes when the file is ready and the undo window has ended.
8. If such a file fails, the operation becomes `failed` with the file's name and the action **Open
   draft**. A message never goes out without a file the user attached. A `failed` chip in the
   composer blocks Send like any other `SendBlocker`.

### Building and holding the message

9. A message with attachments is **streamed to a spool file** by the attachment worker: written to a
   temporary name, synced, renamed, and only then recorded on the operation with its byte count.
   Every attempt sends those bytes, so ADR 0020 rule 6 still holds. A message with no attachments
   keeps its BLOB, and nothing changes for it. The ports hide the difference:

   ```ts
   interface MimeSource { readonly size: number; open(): AsyncIterable<Uint8Array>; }

   MailSubmitPort.submit(target, envelope, source: MimeSource, watch?: SubmitWatch)
   ```

10. **No write transaction contains file I/O**, and no file bytes pass through SQLite or the WAL.

### Sending

11. **Two lanes.** A message under 1 MiB encoded runs in the small lane, and anything larger in the
    large lane, one at a time per account. Each lane has its own claim and drain. A reply overtakes
    a 25 MB upload.
12. **The size goes on `MAIL FROM`** (`SIZE=`), so a server that will refuse it says so before any
    bytes are sent. That is a definite failure, and the only offer is **Open draft**, since Retry
    would fail the same way.
13. **The end of the data decides what a broken connection means.** This narrows ADR 0020 rule 7:
    - Lost before the last byte of our stream was handed over: the end-of-data marker was never
      written, so it was **not delivered**. The state is `failed`, and a retry is safe.
    - Lost after that, while waiting for the answer: `unknown`, reconciled as before.

    Just before the stream ends, a `dataEnded` mark is written on the operation, so a crash can be
    told apart too: a `running` operation without the mark at start-up was not delivered, and goes
    to `held`. With the mark it is `unknown`.
14. **Stop.** While the last byte has not been handed over, a large send can be stopped: the socket
    is closed and the operation becomes `cancelled`, for the same reason. Undo before the window
    ends and Stop during the upload are the same promise, and it ends only when the data ends.
    Both reopen the composer on that draft: the app has no list of drafts, so a message taken back
    would otherwise be out of reach, with its files still on disk.
15. **Quitting does not wait for an upload.** A transfer without the mark is aborted and held, so
    next start shows "Not sent yet — Send now / Discard" and no dialog stands in the way of quit.
    One with the mark gets the existing 3 s.
16. **A connection lost before the data ended is retried by itself**, with the same bytes, after 5 s,
    30 s and 2 min, while the app is open. SMTP cannot resume, so each try starts from the first
    byte. After the third the state is `failed`. A server's refusal is never retried by itself.
17. **The wait for the answer scales.** A server may scan a large message before it answers, so the
    wait after the data is 60 s plus 1 s per MB, rather than a flat 60 s.
18. **The Sent copy is not part of the send.** The state becomes `succeeded` as soon as the server
    accepts, and the dot says so. The APPEND follows on its own, one at a time, with the message in
    memory only for that step. A failure, or a message over `APPENDLIMIT`, is the existing warning.

### Cleaning up

19. Stored files and spools belong to their draft and operation. They go when the draft is sent or
    discarded and the Sent copy has finished, and with the account's data when it is removed. A
    sweep at start-up deletes files no row refers to. An `unknown` operation keeps its spool until
    the user settles it.

### What the user sees

20. **Adding.** `Attach` in the composer's footer, `⇧⌘A`, a drop, or a paste. Files are a strip of
    chips between the message and the footer, with a total. The strip grows to two rows and then
    scrolls inside itself, so the message never loses its room to the files.
21. **Dropping.** While files are dragged over the window, frames take no pointer events (an iframe
    would swallow the events), and only one class changes, so dragging does no layout. With a
    composer open the whole composer is the target. With none open, the window offers **New
    message** and, when a thread is open, **Reply**. Dragging text inside the editor is left alone.
22. **One dot tells the whole send**, in the place the tray's dot already has, in the language of
    ADR 0039 where a dot that drains is a countdown. It grows from 6 to 10 px, because a ring cannot
    be read any smaller:

    | Moment | The dot | The line |
    |---|---|---|
    | Waiting for a file | breathing ring | Waiting for report.pdf · **Undo** |
    | Undo window | drains over 10 s | Sending… · **Undo · 7 s** |
    | Building | breathing ring | Preparing… |
    | Uploading | a ring that fills with the true bytes | Sending… 14 of 34 MB · **Stop** |
    | Waiting for the answer | full ring, breathing | Waiting for the server… |
    | Delivered | solid, good | Sent |
    | Connection lost, will retry | hollow, late | Connection lost · trying again in 28 s · **Retry now** |
    | Failed | solid, late | Not sent · reason · **Retry** or **Open draft** |
    | Unknown | half, late | Not sure it was sent · **Send again** · **Mark as sent** |

    A message with no attachments shows what it shows today: the fill is too quick to see, so it is
    not drawn under 1 MiB. With reduced motion the ring's steps replace the sweep, and the line
    gives the number. Screen readers hear state changes, never percentages.
23. **Failure copy** names the file, says what happened and gives the one action that helps.

    | What happened | Where | What it says | Action |
    |---|---|---|---|
    | Original unreadable or gone | chip | Can't read this file | Try again · Remove |
    | Disk full during capture | chip | Not enough disk space | Try again · Remove |
    | Slow source (iCloud, network drive) | chip | Reading 40% | Send stays available |
    | Folder dropped | status line | Folders can't be attached. Zip it first. | Others continue |
    | Same file twice | status line | report.pdf is already attached. | None |
    | Empty file | chip | Empty, 0 bytes | Blocks nothing |
    | Original edited since it was attached | chip | Changed since you attached it | Use new version |
    | Message over the limit | strip | 34 MB to send, your server takes 25 MB. Remove a file. | Remove |
    | Stored copy missing at hand-off | tray | Not sent · report.pdf is missing | Open draft |
    | Server refuses a file type | tray | The server's reason, unedited | Open draft |

## Consequences

- The budgets of ADR 0012 hold while files move: a chip in one frame, `j`/`k` under 16 ms during
  capture and upload. A new smoke test attaches 100 MB and uploads to the test server, and fails on
  those budgets or when the backend heap grows more than 16 MB outside the Sent copy.
- `MailSubmitPort`, `OutboxPort` and `MessageComposerPort` change shape. Fakes and the contract tests
  change with them.
- There is a third thread to supervise, and a directory of user files in the app's data. They are
  there only as long as a draft or a send needs them, with the same protection at rest as stored
  mail, which is the operating system's. That needs saying in the privacy notes.
- Stored copies use real disk where clones are not possible, up to the account's limit per draft.
- Automatic retries use data again from the first byte. Three tries bound it.
- The reader still shows only that a message has an attachment. Seeing and saving received files is
  a separate piece of work.
- Inline images (a pasted image shown in the body) are not covered. A pasted image is an ordinary
  attachment until `cid:` images are decided, and `adapter-compose` keeps refusing embedded images.
