# 0077. Showing what was found

- Status: Accepted
- Date: 2026-11-08
- Amended by: [0094](0094-a-message-opens-as-sent.md) (a message with HTML opens as Original and has no stops)

## Context

ADR 0076 marks the typed words in the rows of the search panel. Once the person leaves the panel
the marks are gone: the list of results and the thread opened from it look like any other, and the
person has to find the word again with their eyes, in a letter that may be long, partly folded and
full of quoted replies. The words that were asked for should stay visible where the result is
shown, and there should be a way to walk through them.

## Decision

1. **Free words.** The words to show are the query's free words: plain words and quoted phrases
   that are not negated, not the value of a field and not an operator. `from:anna`, `has:attachment`,
   `label:work`, `OR`, `-stary`, `NOT stary`, `-(stary nowy)` and the brackets themselves give none.
   A quoted phrase is one free word in the query and is marked word by word. `queryHitWords` (next
   to `freeWords` in `liveSearch.ts`) reads them from the parsed query, folds them and puts the
   longest first, as `hitWords` does. A query without free words marks nothing, and nothing is
   computed for it.
2. **Where marks show.** While the list shows a search with free words:
   - in the list rows, the subject and the snippet;
   - in the reader of a thread, the thread's title, the snippets of folded letters, the words of the
     open letter in its plain-text view (Text, or any letter without a designed layout), and the
     names of the attached files (matching inside a word, as in ADR 0074).
   Marks are `mark.hit`, with the colours of ADR 0076. They follow the query: change the words and
   the marks change; clear the search and they are gone.
3. **How they are made.** Segments come from `hits.ts` and are rendered as text nodes and `mark`
   elements, never through `innerHTML` of mail content, so links, quote folding and signature
   detection work as before. A word does not match across the edge of a link. The segments of a
   list row are cut once per message and query (`rowHits.ts`, a small bounded cache) and not at all
   without words, so scrolling costs what it did.
4. **What is not marked.** A message shown as its sender designed it (the Original view, in the
   sandboxed frame) is not touched: its markup is not ours to change. Quoted replies and long
   signatures are marked when the person unfolds them but are not stops of the walk.
5. **Walking through the matches.** When the open thread has stops, the thread's toolbar shows
   `N matches` (`2 of N` after the first step) with two buttons, "Previous match" and "Next match"
   (↑ ↓). ⌘G goes to the next, ⇧⌘G to the previous (Ctrl instead of ⌘ outside macOS) while the
   reader shows matches. The first step goes to the first match (or, backwards, the last); both
   directions wrap. A stop is a mark in the words of a letter that are on screen before anything is
   unfolded; letters that are folded or collapsed count, and stepping to one unfolds its run and
   opens it. The current match has a 2 px outline in the ink of the marks and is scrolled to the
   middle of the view. The walk starts again when another thread is opened or the words change.
   The order, wrapping and counting are pure (`matchNav.ts`).
6. The thread is marked whenever the query has free words, whether it was opened from the list or
   from the panel; it is not remembered per thread.

## Consequences

- A result explains itself in the list and in the reader, with no new setting and no mode.
- Counting a letter's stops means cutting its text once per thread and query; threads with very
  long bodies pay that once on opening, and only while a search with free words is shown.
- Messages sent as designed mail show no marks in their frame. Switching such a message to Text
  marks it, but its marks are not counted as stops.
- The count and the marks can differ when a word is split by a link boundary; the reader's marks
  are the truth and the count follows the same cut.
