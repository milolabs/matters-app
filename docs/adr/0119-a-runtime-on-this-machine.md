# 0119. A runtime on this machine

- Status: Accepted
- Date: 2026-11-12
- Amends: [0051](0051-agents-on-the-users-own-plans.md) (one runtime becomes a choice of
  runtimes; a runtime without a plan), [0118](0118-effort-is-set-per-kind-of-work.md) (rule 4:
  levels can differ by model)
- Builds on: [0083](0083-the-agent-searches-in-a-loop.md), [0116](0116-a-prompt-is-a-filter.md)
- Amended by: [0121](0121-a-runtime-for-each-kind-of-work.md) (rules 2 and 3: a runtime is chosen per kind of work)

## Context

The agent runs on one runtime: the person's own Claude Code, on their plan (ADR 0051). The port
was written for more than one, and settings and consent already name a runtime, but the app
builds exactly one and every screen assumes it.

A person who has no such plan, or who does not want mail to leave their machine at all, has no
agent. Ollama runs models on the machine and serves them over HTTP on the loopback address. It
takes a JSON Schema for the answer, which is what our turns need, and it lists the models that
are installed.

Running on a subscription stays the first choice (it is what the scheduling is built around). A
model on the machine is an option beside it, never something the app falls back to by itself.

## Decision

1. **A second runtime: Ollama on this machine.** A new adapter talks to the Ollama server at
   `127.0.0.1:11434` and nowhere else. The address is not a setting in this step.
2. **Runtimes are a list, and one is chosen.** First run and Settings show every runtime the
   app knows, each with its state, and the person picks one. Consent is per account and
   runtime, as it already is stored: agreeing for one does not agree for another.
3. **Never a fallback.** Only the chosen runtime runs anything. If it cannot be used, the agent
   says why and waits; nothing moves to another runtime by itself.
4. **Models and effort are kept per runtime.** Each runtime has its own choice of model and
   effort for each kind of work, so changing the runtime and changing back loses nothing. A
   runtime with no fixed model names starts every kind of work on one installed model, and the
   person can change each.
5. **Only models that run here.** Ollama also lists models that it forwards to a host
   elsewhere. Those are not offered: with this runtime mail stays on the machine, and the
   consent question says so.
6. **Its states.** Not running; running with no model installed; installed but not yet tested;
   ready. Each says what to do in one sentence (start Ollama; pull a model). It is ready only
   after the same test every runtime passes (ADR 0051, rule 5).
7. **No plan.** A runtime may say it has no plan. Then nothing about windows, shares and limits
   applies or shows: the gates for the plan always pass, and what bounds background work is
   that one turn runs at a time. `Pause reading` and Stop work as before.
8. **Answers.** A turn sends the schema as the answer's format and is checked exactly as any
   runtime's answer is: against the schema and the rules of the turn. The context a turn needs
   is asked for explicitly, within what the model allows; a turn that would not fit is refused
   with a reason, never cut short without saying.
9. **Effort follows the model.** The levels come from what each model says it takes, so the
   control beside a kind of work shows the levels of the model chosen for it, and none for a
   model that has none.
10. **Attachments, where the model can.** A model that takes tools runs the search loop of
    ADR 0083 with our own tools, so it can read the text of attached files (ADR 0087). A model
    that sees images gets image files whole (ADR 0090). Whether a model can do either is said
    per model, and the screens follow the model chosen: a model with neither plans its
    searches in turns without tools and reads no attachment, as any such runtime does.
11. **Not in this step.** A server on another host. Installing or pulling models from the app.
    Turning the pages of a file with no text into images for a model that sees only images.

## Consequences

- A person can use the agent with no account anywhere, and with mail that never leaves the
  machine.
- Quality depends on the model the person installed. A small model can fail the test, give
  verdicts that do not hold up, or be slow; the app does not judge which models are good
  enough beyond the test.
- Reading is slower and runs one turn at a time. A view with a prompt over many threads takes
  much longer than on a plan, and uses the machine while it does.
- The screens that showed one runtime now show a choice, and settings hold choices per
  runtime. Stored settings from before read as choices for the runtime that was chosen.
- With a model that takes no tools, a prompt's search is the plan turn of ADR 0080, which
  finds less than the loop does, and attached files are not read.
