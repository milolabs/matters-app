# 0144. Print a thread, or save it as a PDF

- Status: Accepted
- Date: 2026-11-16
- Amends: [0024](0024-rendering-mail-html.md) (rule 3: the sanitizer also rewrites what a
  message's style sheets ask about the medium; the reader's frame has a second place, the print
  view)
- Amended by: [0145](0145-save-a-message-as-a-file-and-back-up-what-matters-keeps.md) (rule 1: Save as .eml… joins the File menu and the More
  menu on the same terms; "Not in this decision: export as .eml" is decided there)
- Builds on: [0012](0012-performance-budgets.md), [0036](0036-settings-window.md),
  [0037](0037-remembering-image-choices.md), [0043](0043-received-attachments.md),
  [0047](0047-hostile-mail-corpus.md), [0056](0056-acting-on-rows-of-the-list.md),
  [0078](0078-the-sender-leads.md),
  [0079](0079-a-sender-that-failed-and-matters-leads-with-the-sender.md),
  [0085](0085-mail-in-the-dark-theme.md), [0097](0097-the-reader-has-one-frame.md),
  [0099](0099-each-letter-names-its-sender.md),
  [0134](0134-appearance-a-mode-and-themes-that-are-data.md)

## Context

Read from the code on 2026-11-16:

- Nothing in Matters printed. The app menu had the File role's one item, Close Window. ⌘P did
  nothing.
- The reader shows each letter of a thread with its own header (ADR 0099). A letter with HTML is
  a frame of `mail.html` or `mail-images.html`, sandboxed without `allow-scripts`, filled by the
  page with `sanitizeMail` output and fitted to its content (ADR 0024, 0097). A plain letter is
  text, with quotes and long signatures folded until asked for. Letters the reader starts folded
  (read, older) are one line, and a long run of them is one row.
- The thread's tools sit above the subject: Reply, Reply all, Forward, Archive, Delete and a More
  menu with Mark as spam and Move to…. There is no menu per letter. With several rows chosen the
  reader is the pile of ADR 0056, with its own actions.
- `sanitizeMail` (DOMPurify) keeps `<style>` and its text as sent. A `@media print` block and
  `@page` pass untouched; on screen they do nothing. DOMPurify does not allow the `media`
  attribute, so a `<style media="print">` lost it and applied on screen too: the corpus run showed
  a print-only sheet's text in the reader.
- Measured in Electron 45 with a sandboxed same-origin frame, its screen text
  against the text of `printToPDF`: on paper `print` matches and `screen` does not, `(update)` is
  `none` instead of `fast`, and `(min-resolution: 2dppx)` no longer matches on a Retina screen.
  Hover, pointer, colour, colour gamut, `prefers-color-scheme` (from the frame's `color-scheme`,
  ADR 0085), width and orientation answered as on screen. Emulating the screen media type through
  the debugger protocol fixed the type and `update`, not the resolution.
- Measured too: a frame taller than a page is sliced across pages when printed (a 300-row frame
  printed on 12 A4 pages with every row), so a frame per letter prints a long letter whole.
- `printToPDF` writes `/Title` (the page's title), `/Creator (Chromium)`, `/Producer (Skia/PDF
  m156)`, `/CreationDate` and `/ModDate`, and no `/Author`. Electron has no option for the others.
- Received files are saved through `dialog.showSaveDialog` with the Downloads folder as the
  default (ADR 0043), and their names through `safeFileName`.

## Decision

1. **Two actions on the thread open in the reader: Print… and Save as PDF….** On macOS they are
   in the app menu's File menu, under Close Window: Save as PDF…, a separator, then Print… with ⌘P,
   where a Mac app has them. They are also the last two items of the reader's More menu, with the
   app's own icons and the key shown, as Mark as spam and Move to… are; no new button is added to
   the reader. There is no menu per letter, so no letter is printed alone. The page tells main
   whether one thread is open and no rows are chosen, and the menu's items are on only then. They
   act on the mail window only: from the settings window they do nothing.

2. **What is printed: the whole thread, every letter, in order**, whatever the reader has folded.
   Each letter starts with its header as text: From and To with names and addresses, Cc when
   there is one, the date in full, the subject, and the reader's word on the sender ("Not verified ·
   domain", "Verified · domain", ADR 0078, 0079). Then its body as the reader shows it:
   - with HTML, the original (or the Text view when the reader shows that for it);
   - plain, the words and a short signature, and in place of each quote and each long signature a
     line that names it ("Quoted text · 4 lines, not printed", "Signature, not printed"), as the
     reader folds them by default;
   - the files are listed by name and size (`Invoice.pdf · 120 KB`), never printed.
   Above the letters, the subject. Always light: black on white, the light view of each message
   (`mailView` with the app in light), whatever the app's mode and theme (ADR 0134). No app
   chrome and no avatars. The reader's type (the subject at 22 px in the serif, the sender at 15,
   the rest at 12, plain text at 15 in the serif). The page is laid out at the width of the paper
   less 0.6 inch on each side (A4, or Letter where it is the usual paper, by the system's region).
   A PDF has those margins and no header or footer; for a print, the margins, header and footer
   are the system dialog's.

3. **Hostile mail stays hostile on paper.**
   - The print view uses the reader's own pieces: the same `sanitizeMail`, the same pages
     (`mail.html`, or `mail-images.html` where the reader shows images), the same sandbox without
     `allow-scripts`, the same fitting. Its own text (headers, plain bodies, file names) is put in
     as text: the page builds its elements itself and sets each name, address, subject, file name
     and line with `textContent`, so a subject or a name with markup prints that markup as
     characters, and nothing of the thread is ever parsed as the page's markup.
   - Images are printed only where the reader shows them: allowed by a rule (ADR 0037) or by Show
     images while the letter is open. Elsewhere the frame is `mail.html`, which loads nothing, and
     the letter carries the reader's sentence for that state ("Images are off, so the sender can't
     tell you've read this."). Making the print view causes no request the reader did not make.
   - **Paper says what the screen said.** The sanitizer rewrites what a message's style sheets ask
     about the medium, as text, so that the answer is the screen's wherever the message is drawn:
     the media type `print` never matches and `screen` always does (a `@media print` block is
     dropped, a `@media screen` block applies on paper too, `not` keeps its meaning); a
     `<style media>` whose list only paper matches is emptied; a feature of the output device
     (`update`, `resolution`, `device-pixel-ratio`, `color`, `color-index`, `monochrome`) is
     answered once by the screen the reader is on and written in as a constant; `@page` is
     dropped. Escapes and comments are read as the browser reads them (`@\6d edia pr\69nt`).
     Features of the frame's size stay, and the print view lays every frame out at the width it is
     printed at. On screen nothing changes. It is part of `sanitizeMail` (`mailMedia.ts`), not a
     second sanitizer.

4. **How.** Main makes a hidden window of a page of our own, `print.html`, only when asked: never
   at launch. It has the mail window's walls: the same session (so its frames are the reader's
   frames under the same policy and request rules), `lockDown` (no popup, no navigation, every
   permission refused, frames only to our own pages), a sandboxed preload of its own that exposes
   nothing, and the app's strict policy for the page itself. Main hands it the thread, which the
   page lays out and fills. The page takes none of what it is handed on trust, though the mail
   window's preload and main have checked it: it reads only a message from its own window and
   origin (the preload), reads the thread's shape and limits again with the same function
   (`readPrintDocument` in contracts), and is handed what the reader decided as data (images
   shown or not; paper is always the light view). Each letter's HTML is `sanitizeMail` output
   from the mail window, which must answer a style sheet's questions about the screen with the
   reader's own (rule 3; the hidden window is on no screen the reader looked at); the page treats
   it as untrusted all the same and sanitizes it again with the same `sanitizeMail` right before
   it fills the letter's frame, so a letter is sanitized twice, and the line about blocked images
   is printed when the letter sanitized there asks for images; once every frame is filled, its images have loaded or failed (five
   seconds at most) and the fonts are ready, the page says so. Then main calls
   `webContents.print()` (the system dialog) or `webContents.printToPDF()`. The window is destroyed
   afterwards in every case: done, cancelled, failed, or not ready within 30 seconds. One job at a
   time: an ask while one runs does nothing.

5. **Save as PDF…** asks where first, in the system's save dialog: in Downloads, as the attachment
   dialog does (ADR 0043), named from the subject and the day of the newest letter,
   `Lunch on Friday 2026-11-16.pdf` (`pdfFileName` in core: through `safeFileName`, so no
   separator, no control or format character, never a hidden name; cut to 200 bytes, never inside
   a character, keeping the day and `.pdf`; `Message` when nothing is left). A cancelled dialog
   makes no window. The file is written only where the person chose; replacing a file is the
   dialog's question. The PDF's only metadata of ours is its title, the thread's subject. Chromium
   adds `/Creator (Chromium)`, `/Producer (Skia/PDF …)` and the dates; nothing names the account,
   the person or the app. No tagged PDF and no outline are promised in this step.

6. **A failure says so** in one phrase on the line under the window where the composer's problems
   show: "The thread could not be printed." or "The PDF could not be saved." A cancel says nothing,
   and the line goes when another thread opens or the next print starts.

7. **Where it lives.** Core: `pdfFileName` (`packages/core/src/domain/fileName.ts`). Contracts:
   the print document's types. Renderer, pure: the rewrite of the media questions
   (`mailMedia.ts`, called from `sanitizeMail`), the letter and the page's nodes as
   data (`printDocument.ts`), the frame's fit, shared with the reader (`mailFit.ts`). Renderer: the
   thread made into a print document from the reader's own decisions (`printing.ts`), the menu
   items in `app.tsx`, the print page (`print.html`, `printPage.ts`, `print.css`). Preload:
   `printBridge.ts` (the mail window's), `print.ts` (the print view's). Main: the job, the paper
   and the stand-ins (`printer.ts`), the channels and the answer's shape (`printShapes.ts`; the thread's shape and its
   limits are `readPrintDocument` in contracts, read by the preload, main and the page), the window,
   the menu and the handlers in `index.ts`.

8. **Tests.** Unit: the file name, the media rewrite (types, `not`, lists, device features,
   escapes, comments, strings, nesting, `@page`, open blocks, a long sheet), the print document
   (headers as text, markup in a name or a subject printed as characters, files listed, quotes
   folded, light view, frames of the reader's pages without their markup), the job (print called
   once for the window it made, the window destroyed after done, cancel and every failure, a
   cancelled save makes no window, one job at a time), the shapes and the bridge. The corpus run
   (ADR 0047) saves every message as a PDF through the reader's More menu, with images off and
   with them allowed: making it may ask the canary for nothing the reader did not, run nothing and
   go nowhere; main's request spy must see what the canary sees; two cases check that the PDF says
   what the screen says, in both directions (`html-print-reveals-hidden-text`,
   `html-print-hides-shown-text`). Window tests on the demo mailbox: Save as PDF… through a dev
   build's stand-in for the dialog (`MATTERS_TEST_SAVE_DIR`), then the file's name, that it is a
   PDF, its size, that it has no Author, and its text read back with the app's own PDF reader;
   Print… through a stand-in that writes the call down instead of making it
   (`MATTERS_TEST_PRINT_LOG`): one call, for the hidden window, which is gone after; the File
   menu's items on with one thread and off with several rows chosen. A packaged app reads neither
   variable.

### Not tried, and why

- **Printing the reader's own frames** (`window.print()` in the mail window). It prints the app,
  its list and its chrome; hiding them with print styles would put the app's look and the
  person's theme in charge of the paper.
- **One document with every letter's HTML in it**, or each in a shadow root. A sender's CSS would
  reach the other letters and our headers, and in a shadow root its `html` and `body` rules stop
  matching: paper would differ from the screen in ways a hostile mail chooses.
- **Emulating the screen media type in the print view** (the debugger protocol). It fixes the type
  and `update` but not the resolution, it needs the debugger attached to a window that renders
  mail, and whether it holds for the system dialog could not be tested. The rewrite holds wherever
  the HTML is drawn.
- **Dropping every media query that is not about width.** It would change how messages look on
  screen.
- **Taking links out of the PDF.** Chromium writes a link annotation for each link. Removing the
  links would change which of the message's rules match (`a:link`), the kind of difference rule 3
  is there to prevent.

### Not in this decision

- Printing the list, or several chosen threads at once.
- Printing a letter alone, or the letters as folded on screen.
- Printing the attachments.
- Page setup of our own (paper, margins, header and footer beyond the system dialog's).
- A tagged or accessible PDF.
- Export as `.eml`, which a separate decision follows.
- Print… and Save as PDF… in a menu of the window on Windows and Linux, where there is no app menu;
  the More menu has both there.

## Consequences

- A thread can be printed or kept as a file, in the same words the reader shows, and a message
  cannot make paper say what the screen did not.
- A message's `@media print` and `@page` no longer exist anywhere, also not on screen, where they
  did nothing. A `<style media="print">` is emptied, so the reader no longer shows a print-only
  sheet on screen either; any other `media` attribute is still removed by DOMPurify, as before. A message that answered differently for a Retina screen and another screen is
  answered once, by the screen the reader was on when it was sanitized.
- Making the print view sanitizes each letter with HTML again in the mail window, and once more
  in the print view's own window, and loads every letter, also the folded ones; a long thread of
  designed mail takes a moment before the dialog shows (ADR 0012). Nothing is added to launch.
- Images the reader shows are loaded again by the print view, from the cache when they are
  there; images the reader does not show are not.
- The PDF keeps the message's links as links, and the reader's warning for a link that says one
  site and goes to another does not travel with the file.
- The print view sees the page's width, not the paper's: a paper other than A4 or Letter chosen in
  the print dialog gets the same layout, shrunk or with a wider margin.
- Not verified: the system's print dialog and paper (never driven, and nothing was sent to a
  printer of this machine), the print on Windows and Linux, the look of a printout of a long
  thread with many designed letters, and a reader on a non-Retina screen.
