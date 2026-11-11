# 0090. A file with no text goes to the answer whole

- Status: Accepted
- Date: 2026-11-09
- Amends: [0087](0087-the-agent-reads-attached-files.md) (rules 3, 5 and 9)
- Builds on: [0043](0043-received-attachments.md) (the cache), [0084](0084-the-answer-reads-every-thread-found.md) (the thread's share)

## Context

0087 reads a file's text layer and nothing else. On its first real question it found the right
mail and the right contract, `20190228_b2b contract_MS.pdf`, and still could not say what was in
it:

- Word had exported the body of the contract as 737 one-bit pictures, one per line of text. The
  text layer held only the header and footer: "Confidential" and "Page 2 from 6" on each page.
- The extractor called that `ok`. The step said "read file (6 pages)", and the model believed it
  had read a contract that was empty.

A sample of 249 PDFs on the owner's Mac, read with the 0087 extractor on 2026-11-09:

| State | Files |
|---|---|
| `ok` | 199 |
| `no_text`, no text layer at all | 40 |
| `no_text` under rule 1 below, header and footer only | 1 |
| `too_big`, `failed` | 9 |

So about one PDF in six has no text to read. These are scans, signed offer letters, invoices and
contracts: the files whose substance is the reason to open them.

The model can read such a file itself. Checked on 2026-11-09 with `claude` 2.1.318, using the
flags our runtime passes (`--tools ""`, no settings, no session):

- the user message can be sent as `--input-format stream-json` with a `document` block that holds
  the PDF's bytes;
- the model reads a PDF that has no text layer from its page images. A test page drawn as a
  one-bit picture, with 0 characters of text, was answered word for word.

Sending every file whole is simpler still, but it gives up four things the text gives:

- **Checked quotes.** 0087, rule 9 checks a quote from a file against the file's text. What the
  model saw on a picture has nothing to check against.
- **The plan's limits.** A page sent whole costs the model its image and its text, a few times the
  tokens of its text alone. The text is kept and costs nothing on a second read; the bytes would
  be sent again with each question.
- **Search.** Words inside files can only be indexed (0087, stage 2) from text on the Mac.
- **Other runtimes and fences.** Codex and local models do not take a `document` block. A
  document block cannot be fenced and defanged the way text is (0087, rule 10).

So the text stays first, and the whole file is the fallback for a file that has none.

## Decision

1. **Headers and footers alone are no text.** A PDF is `no_text` when, with the lines that repeat
   on its pages left out, it has fewer than 16 letters and digits per page. A line repeats when,
   with its digits made alike, it is once on each page it is on, and on at least two pages and on
   half of those read. Rows that repeat within one page, as in a table, stay text. A one-page file
   has nothing to repeat, so only its length counts. The kept text of an `ok` file is not changed.
   Migration 44 deletes the PDF rows of `attachment_text` that are `ok`, so they are read again
   under this rule. They are only a copy (0087, rule 6).
2. **The answer gets the file whole.** When the loop reads a file that is `no_text`, and the
   runtime is Claude Code, the thread carries that file to the answer turn, inside its share
   (0084). The answer turn sends it as a block next to the text: a PDF as a `document`, a JPEG,
   PNG, GIF or WebP as an `image`. The loop itself never gets the bytes; it is told "no text; its
   pages go to the answer", so it can choose the thread knowing that.
3. **Only in the answer turn.** The answer turn has no tools, so nothing in the file can make the
   model act. The loop, which has tools, sees only the step.
4. **Budget per question:**
   - at most 3 whole files;
   - at most 20 pages in all. A PDF's pages are those its read counted (0087, rule 3), so no
     second parser looks at the file; an image is one page. A page count we do not have means the
     file is not sent;
   - an image of at most 5 MB, which the provider takes;
   - at most 10 MB of bytes in all, which keeps the request well under the provider's limit once
     encoded.

   A file over the budget stays `no_text`, and its step says why it was not sent.
5. **Quotes from a whole file are marked, not checked.** A quote the answer takes from a file sent
   whole is shown as read from the page by the model, not as checked against the file. Nothing the
   model wrote is kept as the file's text.
6. **Steps are true.** The step says what happened: "`<name>`: no text, 6 pages go to the answer",
   or "no text, not sent: over 20 pages for this question".
7. **Other runtimes are unchanged.** With Codex, or any runtime that cannot take the blocks, a
   file with no text answers as 0087, rule 5 says.
8. **Nothing new is kept.** The bytes come from the 0043 cache under its rules, and the request is
   made like any other turn. No new table, no new storage part.
9. **The transport changes only when a file goes.** A turn with no whole file sends its text on
   standard input as now. A turn with one is sent as a single `stream-json` user message: the
   blocks, then the same text.

## Consequences

- The agent can answer from a scan, a signed letter or a contract whose text is pictures, with
  Claude Code. Rule 1 alone already stops it from believing it read an empty file.
- The answer turn of such a question costs more of the plan: a few thousand tokens a page, within
  the budget of rule 4. Questions with no such file cost what they did.
- More of a file's content leaves the Mac than its text: its pages as pictures, signatures and
  stamps included. The settings text already says that files go to the model; the privacy notes
  of 0043 and 0087 must say that a file with no text goes whole.
- Quotes from these files are weaker than quotes from text, and the answer shows that.
- Search still cannot find words in a file with no text. Keeping the model's reading as the file's
  text would fix that, and needs its own decision on how far such text can be trusted.
- To watch:
  - whether the threshold of rule 1 marks real short files as no text (the sample had none);
  - how often rule 4 stops a file;
  - whether the CLI keeps taking `document` blocks in `stream-json` input. A test in the adapter
    pins the shape of the message, and the step says so when a turn with blocks fails.
