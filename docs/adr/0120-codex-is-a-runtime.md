# 0120. Codex is a runtime

- Status: Accepted
- Date: 2026-11-12
- Amends: [0051](0051-agents-on-the-users-own-plans.md) (a second runtime on a plan),
  [0090](0090-a-file-with-no-text-goes-to-the-answer-whole.md) (rule 7: what Codex takes whole)
- Builds on: [0083](0083-the-agent-searches-in-a-loop.md), [0118](0118-effort-is-set-per-kind-of-work.md),
  [0119](0119-a-runtime-on-this-machine.md)

## Context

ADR 0119 made runtimes a list the person chooses from. The agent runs on the person's own
plan (ADR 0051), and many people have a ChatGPT plan and its command line program, Codex, and
no Claude plan. Codex can run one turn without a terminal, take a JSON Schema for its answer,
and report what it does as events.

Codex is a coding agent. By default it can run commands, read and change files, search the
web, and use whatever tool servers and rules the person has set up for their code. Our turns
carry mail, which is text from strangers. A turn that reads mail must not be able to do any of
that.

## Decision

1. **A third runtime: the person's own Codex.** It is found the way Claude Code is, and runs on
   the plan the person is signed in with. The app never starts a sign-in and never asks for a
   credential: when Codex is not signed in, it says what to run in Terminal and looks again.
2. **Only a plan.** A Codex that is signed in with an API key is not used, as with Claude Code:
   a key bills by use, which is not what the person agreed to. The state says so.
3. **A turn is closed.** Each turn starts a fresh Codex that keeps nothing afterwards, reads
   none of the person's configuration, rules, instructions files, plugins or tool servers, and
   works in an empty directory made for the turn and removed after it. Every tool of its own
   that can be turned off is off: commands, changes to files, the web, and viewing files. The
   sandbox is read-only and nothing is approved. If Codex cannot be run so that a turn has no
   way to read the person's files or reach the network, this runtime does not ship.
   As built, a turn's request to the model carries no tool at all: flags alone left a patch
   tool and a code tool, which come from Codex's list of models, so each turn gives Codex its
   own entry for the model with those taken out. Codex is told to refuse any switch it does
   not know, so a renamed switch fails the turn and is not passed over. A turn in which Codex
   reports any tool of its own, or anything we do not know, is stopped at once.
4. **Mail is input, never instructions.** Our fixed text goes where Codex keeps instructions;
   mail goes as the turn's input, by standard input, never on the command line.
5. **The answer follows the schema** Codex is given, and is checked as every runtime's answer
   is.
6. **Tools are ours, for the turn.** The search loop of ADR 0083 runs with our tool server
   named to Codex for that turn only, with its token outside the command line, and only the
   tools the turn allows. So Codex can read the text of attached files (ADR 0087). In such a
   turn Codex adds three tools of its own that list and read what a tool server offers; they
   reach only our server, which answers that it has none, and we found no switch for them.
7. **Images go whole.** A file with no text that is an image goes to the answer turn as an
   image. A PDF with no text does not: Codex takes no PDF.
8. **Models and effort.** The models are those Codex lists for the plan; if it lists none, the
   ones the adapter names, which can lag behind. Effort uses the levels of ADR 0118 that Codex
   takes, by name.
9. **The plan's windows are read apart from a turn.** The command that runs one turn reports
   no windows, but Codex's own server for client apps does. So the adapter starts that server,
   asks it one thing, the account's limits, and stops it. No model runs and no thread is
   started; a read took 0.6 to 1 s as measured.
   - The shorter window Codex reports is the session and the longer the week, whatever their
     lengths, each with its share used and its reset time. The plan's name comes with them.
     From there the gates, shares and what Settings shows are those of any runtime with a plan
     (ADR 0051, rule 7).
   - The read happens when the runtime is checked and after a turn, at most once in 30
     seconds. It has 5 seconds; one that fails or is late leaves what was known, which ages as
     for any runtime.
   - The read is closed as far as the server allows: the same environment as a turn, every
     feature and setting of rule 3 off, state and logs in a folder of its own that is removed
     afterwards. The server has no switch to ignore the person's Codex settings, so their file
     is read and every key of rule 3 is set over it; a key in it that this Codex does not know
     fails the read, which then leaves what was known. Their rules are never consulted,
     because no thread starts. The adapter sends the handshake and that one request and
     nothing else. Anything the server asks of the adapter is refused, and the process is
     stopped when the answer is in.
   - An answer to a turn waits for the read that follows it, about a second and at most the 5;
     a turn that failed does not wait.
   - With the windows known, Codex runs as many turns at once as any runtime with a plan.
   - A refusal for a limit in the background still pauses the reading until the person
     continues it, with the time Codex names: the windows can be stale, and the plan decides.
   - Turns stay on the one-turn command, where rule 3 was proven. The server is never used to
     run one.
10. **What the person is told** is our words: text Codex writes never reaches the person, as
    for any runtime. The consent question says mail goes to OpenAI, under the person's plan.

## Consequences

- A person with a ChatGPT plan and no other can use the agent.
- Mail goes to a second company for those who choose this runtime. Consent is per account and
  runtime, so agreeing for one runtime never covers another.
- The safety of a turn rests on switches of a program we do not write. A new version of Codex
  can add a tool that is on by default; the adapter's tests pin the switches we set, and the
  test that marks a runtime ready cannot see a new tool. Each new version needs a look.
- Starting a fresh Codex for every turn costs time on each turn.
- A scan in a PDF is read on Claude Code and not on Codex.
