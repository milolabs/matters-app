# 0064. One prompt for a thread or all mail

- Status: Accepted
- Date: 2026-11-06
- Amends: 0051, 0063
- Amended by: [0069](0069-the-agent-has-its-own-column.md) (the agent has its own column: the prompt and plans move into it, it is on by default, resizable, and the question has no field of its own)

## Context

The agent can be asked for one thing in one place: a reply in the open thread (ADR 0063). A person
cannot ask what a thread means, or ask anything across their mail ("who has been waiting on me for
more than a week?"). The plans line was already placed where a prompt was meant to stand, so the
window has room for one.

Two earlier design boards drew this as a chat beside the thread and a chat across all mail. They
predate the Electron app, and three things in them no longer hold:

- They show the model calling tools such as a mail search. ADR 0051 turns every tool off.
- They send mail from the chat pane with `⌘↵`, the key that sends a draft from outside a text field
  today (ADR 0063, rule 7). The same key would send to the agent or send mail depending only on where
  the focus is.
- They use a black button for the agent. Black is the only button that sends mail (ADR 0052, rule 10).

Since the runtime has no tools and no session of its own, the app must choose what the model reads,
and must send the talk again with every turn.

## Decision

1. **One prompt, one pane, two scopes.** While AI is on, a prompt stands above the plans line in every
   view, under the reader. A chip in it says what the agent looks at: the open thread, or `All mail`.
   A pane beside the reader holds the talk. It opens with the first message and can be hidden. While
   AI is off, none of this shows.
2. **A talk per thread, and one for all mail.** Opening a thread shows that thread's talk. `⌘J` moves to
   `All mail` and `esc` comes back. Pressing a thread in an answer opens it and its talk: in the list
   it is in, or else in All mail narrowed to its subject. Talks are never merged, so mail read for one
   thread does not travel into a turn about another. With no thread open, All mail is the scope.
3. **The talk stays on this machine.** It is kept in the local store and goes with the rest of the
   agent's data when the person removes that. It is only what the person typed, what the code accepted
   from the model, and which threads each answer cited. It survives a new message in the thread.
4. **Keys.** In the prompt `↵` goes to the agent and `⇧↵` starts a new line. `⌘↵` keeps its one meaning:
   it sends mail, only outside text fields and only while Send is on screen. `g` moves to the prompt.
   `⌘J` (`Ctrl+J` elsewhere) goes to All mail from anywhere, the prompt included; plain `j` stays the
   list's.
   The prompt's button is round and in the agent colour.
5. **What the agent writes stays in the thread.** A draft or a question appears under the letters in the
   frames that exist, with the only Send. The talk says that it is ready and links to it. An answer in
   the pane has no Send and no Edit, and an answer in `All mail` makes no draft in this decision.
6. **In a thread: one turn.** A message is one `P0` turn with the thread and that thread's talk, by the
   gates of ADR 0063, on the model for writing, since the turn may write. The answer is one of: text,
   a draft, a question, or a closing. A closing needs the person's words as before (ADR 0054) and leaves
   Matters with the same line and Undo. Words that led to one of the last three may also hold from now
   on, so they get the background turn of ADR 0054, rule 7; words that only ask a question do not. A new
   last message makes draft and question disappear (ADR 0063, rule 3); the talk says so.
7. **In all mail: a search, then a reading.** There are no tools, so the search comes first:
   1. **Search turn.** The model gets only the person's own words from this talk: no mail, no answers,
      since answers come from mail. It returns a query in the language of ADR 0025 and, optionally, a
      state and an age from the readings. The code parses it, and a query that does not parse ends here.
   2. **Search.** It runs on this machine, in the sync worker, over the search index (ADR 0025) of
      accounts with consent, whatever the query says; the reader connection belongs to the router, so
      the worker uses its own. Only visible threads are kept (nothing in Trash or Spam). A state takes
      the list of Matters, so what was closed or set aside stays out; with a query as well, the
      threads must be in both. An age compares the last message of the thread. Newsletters and
      automated mail stay out by the filter of ADR 0051, which also leaves out what the person's
      rules cover. At most 20 threads are kept, newest first, from the first 200 the search finds;
      both are starting values.
   3. **Answer turn.** The model gets those threads, clipped and marked as data as in ADR 0051, rule 8,
      and the talk. It returns one line and the threads it cites, each with a note and quotes. It
      writes no draft and closes nothing. What goes is at most 120,000 characters of threads, a
      starting value; past it the oldest threads are dropped and not counted as sent. The newest is
      always kept.

   Mail never chooses what is read next, because the search is fixed before any mail is seen. When
   nothing is found there is no second turn, and the person can open the search in the query bar.
8. **Models.** The search turn uses the model for understanding mail. The answer turn uses the model for
   questions about mail, which the settings already offer. The plans line shows the model of the scope.
   Both turns are `P0`, and both wait for the same gate before the first one starts.
9. **Consent reaches past the window.** Consent stays per account and runtime, and now covers a search
   over all of that account's stored mail when the person asks, as a thread outside the window already
   can be asked about (ADR 0063). The window still limits what is read in the background. This amends
   ADR 0051, rule 6.
10. **Every answer says what left.** The foot of an answer names the runtime and how many threads went
    to it. A ledger line records the same, with no question and no mail text.
11. **The model proposes; the code decides.** An answer is validated against its schema. Any cited thread
    must be one the code sent for this turn, and a quote must occur in the message it names (ADR 0051,
    rule 9). A rejected answer shows nothing of it and offers to try again, which is one more turn the
    person chooses. Words of the talk go as untrusted text, never into the fixed instructions. There is
    still no tool that sends, moves or deletes.
12. **Steps are the app's own.** The pane may show `Searched this Mac` and `reading 4 threads`. These are
    what the code does, with a Stop button, and never tool calls of a model. The worker tells the
    window once, after the search, the query and how many threads go on, and nothing from the mail.
    Stop works at either turn, and a stopped turn keeps nothing.
13. **Never on the interaction path.** Turns run in the sync worker, and the talk is read locally
    (ADR 0051, rule 10). Typing in the prompt, moving between talks and showing an answer wait for no
    model.
14. **The reading column keeps its room.** While the pane is open in a window too narrow for both, the
    list narrows, down to 300 px. The width the person chose comes back when the pane closes. Below
    1060 px there is no room for both, so the pane lies over the reader until it is hidden.

## Consequences

- A person can ask about a thread for one turn and about their mail for two, and sees what each sent.
- The search turn cannot be steered by mail. The cost is that one question makes one search: to look
  further, the person asks again.
- An answer can only be as good as the query. Showing the query in the pane makes a poor one visible,
  and the person can take it to the query bar.
- A person can search mail older than the window they named when turning AI on. This is the one widening
  of what can leave the machine, and it only happens on their ask. It needs review before release.
- The pane shows only the query. A state or an age that the model asked for narrows the search too and
  is not shown, so a poor answer may come from them, not from the query.
- The agent's question keeps its own field in Matters for now, so it and the prompt both take words
  about a thread. Merging them is a later decision.
- Drafts for many threads from one instruction, `@` mentions, `/` commands and a context panel are left
  out. Many drafts means many turns, and its count must show before it starts.
- `Write with the agent` under the letters is replaced by the prompt. The header button and `g` stay.
