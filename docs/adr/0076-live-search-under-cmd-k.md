# 0076. Live search under ⌘K

- Status: Accepted
- Date: 2026-11-08

## Context

The query bar's panel (ADR 0026, 0028, 0030) only suggested syntax: fields, values, people to put
after `from:`, earlier searches. To find a thread the person had to type, press ↵ and read the list.
The mail is searched on every keystroke already (ADR 0025), and files can be found by name
(ADR 0074), so the panel can answer while the person types. It also has to be reachable from
anywhere: `/` works only where no text field has the keys.

## Decision

1. **⌘K** (Ctrl K elsewhere than macOS) puts the cursor in the query bar, selects its text and
   opens the panel, from anywhere in the main window; not while the composer or the question about
   deleting for good is open. `/` still does the same where it did. The key at the right end of the
   bar says `⌘K` (`Ctrl K`) while the bar is idle and `esc` while it has the cursor.
2. **Live results** appear above the existing groups when the query has free words: a plain word or
   a phrase that is not negated and not the value of a field, with one word of two characters or
   more. A field being typed (`from:an`) or an empty bar shows today's panel unchanged. The groups,
   in this order, with these limits:
   - **Threads**, up to 4: `search` with the whole query text (so filters count), one row per
     thread, newest first. A row has the sender, the subject and the snippet with the matched
     words marked, the date, the account's dot when there is more than one account, and a paper
     clip for attachments. Choosing it shows the thread in the list (or in the reader, when the
     list does not hold it yet) and gives the list the keys.
   - **People**, up to 2: people whose name or address starts with the words (`suggestPeople`),
     then the senders of the matched threads; never the reader's own addresses. Choosing one writes
     `from:<address>` (`senderToken`): the words that only found the person give way to it, other
     words stay. The panel stays open.
   - **Files**, up to 3: `searchFiles` with the words. Choosing one shows the thread that holds
     the file.
   - **Ask the agent: „text”**, last of the live rows, only when the agent is available (the same
     rule as ⌘J). Choosing it, or ⌘↵ anywhere in the bar, sends the typed text to the agent across
     all mail, as ⌘J does, and closes the panel. Without the agent neither the row nor the key nor
     the hint exists.
   Words that match no thread show one quiet line, "No thread matches", and the ask row. The
   suggestion of people for the word being typed gives way to the live People group.
3. **Marking.** `hits.ts` splits a text into segments by the typed words. It folds both sides as
   the search does (`foldText`: no diacritics, no case, `ł` as `l`), matches where a word of the
   text starts with the typed word (file names also inside a word from three characters, as
   ADR 0074 matches them), places longer words first so that a place is taken once, and never
   builds a pattern from what was typed. It is pure, so lists and the reader can use it later.
   Marked text is `<mark class="hit">`, coloured by `--hit` and `--hit-ink`: an amber wash in both
   themes, not the agent's violet.
4. **Coalescing.** One live request is in flight at a time. An ask made meanwhile replaces any ask
   waiting behind it, and the answer in flight is dropped as stale; when it lands, only the latest
   text goes out. So a burst of keys costs one request in flight and one behind it, never one per
   key, and the panel never shows the answer to an earlier text as the answer to this one. The
   previous answer stays on screen until the new one is in, so rows do not flicker; "No thread
   matches" is said only about the answer to the text now typed. A request is made only while the
   panel is open and the words call for it. Each live request is three reads (`search` with a
   window of 24 messages, `suggestPeople`, `searchFiles`) in parallel; a read that fails is an empty
   one. They use the existing read paths and so the budgets of ADR 0012.
5. **Pills** in a row at the top of the panel, shown with live results: From…, Account… (with more
   than one account), Has attachment, Unread, Any time. A pill is a token editor over the query text
   (`queryEdits`): it is on when its token is a top-level term, and a click takes the token out or
   puts it in. Has attachment and Unread write `has:attachment` and `is:unread`; From…, Account… and
   Any time write the field (`from:`, `account:`, `after:`) and let the completion the bar already
   has ask for the value; on, they remove the field whatever its value. The row in `.qfields` stays.
6. **Keys.** ↑↓ move through all rows. ↵ on a chosen live row opens it; ↵ with no row chosen goes to
   the results, as before. Tab accepts the chosen or first suggestion of syntax, or a person; with
   only live rows it moves on to the pills, which Tab walks and Escape leaves for the bar. ⌘↵ asks the
   agent. Esc closes. The footer reads "↑↓ move · ↵ open · ⌘↵ ask the agent · esc close" with live
   results (without the ask hint when the agent is not available), and is the old footer otherwise.
7. **Screen readers.** Rows are options of the existing listbox, in groups with labels; a polite
   status says how many live results there are, or that no thread matches.
8. **Look.** Sizes 11, 12 and 13 px in the panel, spacing 4, 8, 12 and 16, radius 12 for the panel and
   8 for rows and pills, the theme's tokens plus `--hit` and `--hit-ink` (ADR 0073).

## Consequences

- The panel costs three backend reads per pause in typing while it is open. The smoke test types
  words with the panel open and holds the keystroke-to-rows-painted median to the search budget; on
  this machine it measures about 8 to 10 ms against about 9 ms for the list itself.
- The list runs the same search as the Threads group, so the first window is read twice; the
  alternative, reading the list's rows, would tie the panel to a list that is still loading.
- Files are searched in all accounts, whatever `account:` says.
- A thread chosen before the list has loaded is opened in the reader at once, and selected in the
  list when the list arrives and holds it (within three seconds).
