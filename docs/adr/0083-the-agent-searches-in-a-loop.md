# 0083. The agent searches in a loop

- Status: Accepted
- Date: 2026-11-09
- Amends: [0051](0051-agents-on-the-users-own-plans.md) (rule 3, no tools), [0080](0080-the-agent-follows-the-trail.md) (the plan and follow turns, when the loop is on)
- Builds on: [0081](0081-finding-what-the-question-means.md), [0082](0082-what-the-plan-asks-for-is-not-put-behind.md)

## Context

The trail of 0080 is fixed by code:

- a plan turn writes queries without seeing mail;
- one round runs them;
- a follow turn chooses among 60 summaries of 300 characters, for at most three rounds;
- only the answer turn reads mail.

On the owner's mailbox the measurements of 0081 and 0082 kept pointing at the same narrow place. The
mail is found, but it is lost when one candidate is chosen among many. All 18 lost targets of the
dev questions matched a query some plan wrote. Making the ranking, the planner model, the query
selection, the map or the index smarter moved the top 20 by less than the spread of the samples.

An example question was "my employment history from my mail". The answer was built from one thread.
Asked the same question directly, a chat assistant with mail tools did much better. It searched
again after what it read, opened whole threads, and stopped when it had the history.

## Decision

1. **A loop with tools.** When the setting `talkLoop` is on and the runtime can run tools, one turn
   replaces the plan and follow turns. The model searches, reads and searches again, and then names
   the threads that answer. The answer turn of 0080 stays as it is: the same threads, quotes checked
   by code, and the same ledger.
2. **Two tools, read-only, ours.** The backend opens an MCP server over HTTP on `127.0.0.1` for the
   one question, with a bearer token made for it. It offers two tools:
   - `search_mail(query)` runs the query language through the candidate pipeline of 0081 and 0082,
     and returns the best 20 as numbered summaries;
   - `open_thread(number)` returns the text of a thread it listed, capped in length.

   Only consented accounts are searched. A thread the person's rules cover is never listed or read.
   There is a budget of tool calls and of threads read. Past it, every call answers that the budget
   is spent, and the model must give its result.
3. **0051 rule 3 becomes "only our tools".** The turn still has an empty working directory and
   `--setting-sources ""`, and it adds:
   - `--tools ""`, so no tool of the runtime's own;
   - `--strict-mcp-config` with one server, `--mcp-config` pointing only at ours;
   - `--allowedTools` listing only our tools.

   The adapter refuses the turn when `system/init` reports any tool other than `StructuredOutput` and
   ours, or any server other than ours connected. Mail cannot make the agent send, write, delete or
   reach the network. It can still make it read more of the person's mail, or skew an answer, as
   before.
4. **The steps are true.** The person sees each step as it happens:
   - "searched: <query> → n threads" and "read: <subject, sender, date>" are written by the tool
     server when the call runs, so they are facts;
   - the lines the model writes between its steps ("found the offer, now looking for the end of the
     contract") are shown as the agent's notes, apart from the facts.
5. **Model and budget.** The loop runs on the `write` model (Sonnet by default). It has a budget of
   30 tool calls, 20 threads read and 150 s, and the answer turn of 0080 follows it.

## Consequences

- Whole threads reach the model while it searches, not only summaries, and more of them than the
  20 the answer turn reads. The ledger counts what the tools return, per account.
- A question takes longer: tens of seconds instead of about 20. The person sees every step meanwhile.
- The measure changes. The top 20 of the first round no longer describes the system, so the loop is
  judged by what its answers use.
- The old trail stays the default until the loop has been measured on the owner's mail.
- The token never goes in the command line, which every process on the machine can read. The
  server's config is a 0600 file in the turn's own temporary directory.
- A loop that runs out of time, or ends without a result, still leaves something to answer from:
  the answer turn reads the threads it opened. Only Stop ends the question. The question's cap is
  the loop's limit plus 90 s, so the answer turn always has its time.
- Known and accepted:
  - Each step sends all earlier tool results to the model again, so the tokens of a question grow
    roughly with the square of its steps. The budget of 30 calls bounds this.
  - The ledger counts a listed thread and an opened thread as separate sends.
  - The shape of `system/init` was checked against Claude Code 2.1.318 on 2026-11-09. If a later
    CLI reports the server or the tools differently, the turn fails closed.
