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
9. **The plan's windows are not known.** Codex reports none when it runs one turn this way.
   So background work runs one turn at a time and stops at the first refusal for a limit,
   until the person continues it; the time Codex names in the refusal is shown. Nothing about
   windows and shares shows for this runtime.
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
