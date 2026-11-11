# 0087. The agent reads attached files

- Status: Accepted
- Date: 2026-11-09
- Amends: [0083](0083-the-agent-searches-in-a-loop.md) (the loop's tools and budget)
- Amended by: [0090](0090-a-file-with-no-text-goes-to-the-answer-whole.md) (rule 5: headers and footers alone are no text, and a file with no text goes to the answer whole)
- Builds on: [0043](0043-received-attachments.md) (download on demand, the cache), [0074](0074-finding-files-by-name.md) (files found by name), [0089](0089-storage-in-settings.md) (storage in Settings)

## Context

The loop found the right mail for "what terms did I have at <employer>". The answer could only say
the terms were in the attached contract, a PDF the model saw by name and could not open. Mail often
carries the substance in a file: contracts, offers, invoices, statements, certificates.

What we have:

- the list of every attachment (`message_attachments`: name, type, size, part), but no bytes. They
  stay on the server until someone asks (0043);
- names searchable by trigram (0074), and shown to the loop in `search_mail` results;
- a download path, a cache bounded to 7 days and 2 GB, and a file worker thread off the sync
  worker (0041, 0043).

On the owner's mailbox (197k messages, snapshot of 2026-11-09):

| Kind | Files | Size |
|---|---|---|
| PDF | 5 634 | 3.8 GB |
| PDF up to 2 MB | 5 223 | 1.66 GB |
| Word (`doc`, `docx`) | 232 | 50 MB |
| Signatures, images, calendar invites, the rest | about 7 000 | not worth reading |

The missed-targets analysis of 0082 found no lost target whose words were only in a file. So there
is no measured need, yet, to *search* inside files. There is a seen need to *read* one the agent has
already found.

## Decision

### Stage 1: read a file when the agent asks (this ADR)

1. **A third tool, `read_file(thread, file)`.** `thread` is a number `search_mail` listed, and
   `file` is the position of a file in that thread, as the listing shows it. The same rules hold as
   for `open_thread`:
   - only listed threads, only consented accounts;
   - never a thread the person's rules cover;
   - never an inline part.
2. **Bytes through 0043.** The tool asks the sync worker for the part exactly as a chip press does,
   through the same cache and the same limit of two downloads per account, so a file read once by
   the agent opens at once for the person, and the reverse.
3. **Text, in the file worker.** Extraction runs on the file worker thread, never on the main
   process or a sync batch:
   - **PDF:** its text layer only, through pdf.js (`pdfjs-dist`, Apache-2.0). Nothing is rendered,
     no script or form in the file runs, and pages are read in order until the cap.
   - **DOCX:** the paragraphs of `word/document.xml`. The ZIP is read with caps on the entry count
     and on the inflated size, against archive bombs.
   - **Text types** (`text/plain`, `text/csv`, `text/calendar`): as they are. `text/html` goes
     through the same `htmlToText` as mail.
   - **Anything else** answers what it is, by name, type and size, and that its text is not read.
4. **Limits:**
   - a file over 10 MB is not downloaded for the agent;
   - extraction stops at 200 pages or 20 s;
   - the model gets at most 20 000 characters, with a line saying how much was left out.
5. **No text is an answer.** A PDF with no text layer (a scan, a photo of a signed page) answers
   "this file has no text; it is probably a scan". The model then says so, rather than guessing.
   OCR is out of scope here.
6. **The text is kept, the file is not.** Extracted text goes in `attachment_text (message_key,
   part_id, text, pages, state, extracted_ms)`, deleted with its message. The bytes stay a cache
   under 0043's rules. A second read of the same file costs no download and no extraction.
   `state` is one of `ok`, `no_text`, `unsupported`, `too_big` or `failed`. A failure is not
   retried within the same question.
7. **Budget.** A file read counts toward the loop's 30 calls, plus its own limit of 5 files per
   question. The size of one read is bounded as in 4, and the time of the question as in 0083.
8. **Steps are true.** The tool server writes the step when the call runs: "read file:
   `20190228_b2b contract_MS.pdf` (6 pages)", or the reason it was not read. As in 0083, these are
   facts; the model's lines stay notes.
9. **The answer turn reads the files too.** For the threads the loop chose, the answer turn gets the
   extracted text of the files the loop read, within the thread's share (0084). Quotes from a file
   are checked against its extracted text, as quotes from mail are checked against the message.
10. **Mail text is data, and so is a file.** The extracted text is fenced and defanged the same way
    `open_thread` text is, so a file cannot forge our headers or fences.
11. **Storage shows it** ([0089](0089-storage-in-settings.md)):
    - `attachment_text` is its own part of the bar, "Text of files", with the detail "What agents
      read from attachments", and its own column in `storage_samples`;
    - the overview, which costs little, also says how many files were read;
    - the "Files" part counts the downloads the agent made, since they share the cache of 0043, and
      its detail says so.

    The text can be cleared there: one action, confirmed first, that empties `attachment_text`. It
    is only ever a copy of what is on the server, so it is safe to lose. The agent extracts it
    again when it needs it.

### Stage 2: search inside files (not decided here)

Only once stage 1 is used and measured. The sketch:

- a contentless FTS over `attachment_text`, which `search_mail` joins like the body;
- filled from stage 1, and by an idle-time background job:
  - people's mail first, then newest first;
  - PDF and DOCX up to 2 MB, about 1.7 GB for the owner;
  - a daily download cap well below the provider's IMAP limits;
  - no bytes kept after extraction.

It needs its own ADR, with the eval run before and after it, as for every change to search.

## Consequences

- The agent can answer from a contract, an invoice or a statement it found, not only from the mail
  around it.
- The text of a file goes to the model, like the text of mail does in the loop. The owner agreed to
  that for the loop (0083). The settings page must say that files are included.
- A question that reads files takes longer: a download of up to 10 MB and its extraction. The person
  sees each step meanwhile.
- `pdfjs-dist` is a large dependency. It runs only in the file worker, so it never adds to the
  window's start-up.
- Extracted text is new data at rest. It has the protection stored mail has, which is the
  operating system's, and the privacy notes asked for in 0043 must mention it too.
- Known and accepted:
  - Scans read as no text, until OCR is decided separately.
  - Files inside a ZIP, and `.doc` (the binary Word format), are not read.
  - Search cannot find words that occur only inside a file. The agent reaches a file by its name
    or by the mail around it. Stage 2 is for that, if it proves to be needed.
