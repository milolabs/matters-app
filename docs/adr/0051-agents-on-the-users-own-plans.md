# 0051. Agents run on the user's own plans

- Status: Accepted
- Date: 2026-11-05
- Amended by: [0083](0083-the-agent-searches-in-a-loop.md) (rule 3: a turn of the loop may call our read-only mail tools, and nothing else)
- Amended by: [0118](0118-effort-is-set-per-kind-of-work.md) (rule 6: effort beside the model)
- Amended by: [0119](0119-a-runtime-on-this-machine.md) (one runtime becomes a choice of runtimes,
  with consent and choices per runtime; a runtime may have no plan)
- Amended by: [0120](0120-codex-is-a-runtime.md) (a second runtime on a plan: Codex, on the
  person's ChatGPT plan, each turn closed; its windows read apart from turns)
- Amended by: [0121](0121-a-runtime-for-each-kind-of-work.md) (rule 7: windows, shares and limits per runtime)
- Amended by: [0131](0131-the-person-sets-the-background-limit.md) (rule 7: the share of the week is
  any whole percent the person sets, or no limit)

## Context

The product's layer on top of mail needs a model: finding what a person promised, who waits on them,
and preparing replies. People already pay for Claude or ChatGPT plans, so the owner wants Matters to
use those before any API key.

Measured on 2026-11-05 with one turn on a made-up sentence, on Claude Code 2.1.316 and codex-cli
0.163.0:

| | Claude Code (Pro) | Codex (Plus) |
|---|---|---|
| Whole turn | 2.4 s | 5.3 s |
| Input tokens for one sentence | about 1.4k | about 16.5k |
| Answer against a JSON schema | yes | yes |
| Plan windows | `rate_limit_event`, on each turn | `account/rateLimits/read`, at any time |

What the vendor documents, read on the same day:

- `claude -p` and third-party app usage draw from subscription limits when signed in with a plan.
- Anthropic does not let third-party developers offer claude.ai login, or route requests through plan
  credentials on behalf of users, and developers may not collect or store those credentials. An end
  user may sign in to the unmodified Claude Code binary with their own plan.
- `--bare` never reads the plan login and is announced as the future default for `-p`.
- Without `--bare`, `-p` loads the hooks, `CLAUDE.md` and MCP servers of the host and of the folder.
- Consumer plans may keep data for training when that setting is on.

Mail is hostile input (ADR 0047), and it holds other people's data.

## Decision

1. **One port.** `AgentRuntimePort` in core: `inspect()` says what a runtime is and what its limits
   are, `run()` takes instructions, untrusted text, a model and a JSON schema, and returns a value of
   unknown shape with the limits it saw. Each runtime is one adapter package.
2. **First runtime: the person's own `claude` binary.** `packages/adapter-claude-code`. It is found on
   the machine and never bundled, downloaded or modified. Sign-in is the CLI's own flow; the app shows
   the command and never opens, reads, stores or forwards a token. Codex, local models and other
   runtimes follow through the same port.
3. **Every turn is locked down.** An empty temporary working directory, `--tools ""`,
   `--setting-sources ""`, `--strict-mcp-config`, `--no-session-persistence`, its own
   `--system-prompt`, and `--json-schema`. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed
   from the child's environment.
4. **Plan or nothing.** A turn whose `system/init` reports an `apiKeySource` other than `none` is an
   error, not a fallback. If a future CLI stops using the plan login, the app says so. Paid API use is
   only ever a runtime the person added and chose. Background work stops while a runtime reports
   `isUsingOverage`.
5. **A test before any mail.** A runtime is usable after it answered a made-up message with no tools
   available, in the right shape. Until then it is `found`, not `ready`.
6. **Consent per account and runtime.** AI is off until the person turns it on. Turning it on names
   how many threads go to which runtime, and that the runtime's own privacy settings apply. No
   runtime receives mail that the person did not agree to send to it, and work never moves to another
   runtime by itself.
7. **Budget in percent of the plan's windows.** Tokens are not published per plan, and a percentage
   scales with the plan by itself. `mayRun` is a pure function of priority and the last known windows:

   | Priority | Work | Stops above session | Stops above week |
   |---|---|---|---|
   | `P0` | What the person asked for | plan limit | plan limit |
   | `P1` | Understanding new mail | 70% | 80% |
   | `P2` | Drafts before asking | 50% | 70% |
   | `P3` | Reading back in time | 25% | 50% |

   On top, background work (`P1` to `P3`) keeps to a share of the week, 10% by default, spread evenly
   over the week. Beyond that share, it may use what the week would otherwise lose: what is left
   above the whole plan at an even pace until the reset (left minus 100% times the part of the week
   still to come). Late in a quiet week that is most of what is left; the ceilings above still
   apply. These numbers are starting values, to be calibrated.
8. **What leaves the machine.** Plain text of the messages in the thread, clipped per message, with
   their dates and participants. No HTML, no attachments, no addresses of the person's other accounts.
   Each message is marked as data. Newsletters and automated mail are left out by a local filter. A
   ledger records what went to which runtime, for how many threads, and when; it holds no mail text.
9. **The model proposes; the code decides.** Output is validated against the schema and rejected if
   it does not match. A quote counts only if it occurs in the message it names, after normalising
   white space. Recipients come from the reply rules (ADR 0020, 0042), never from a model. There is
   no tool that sends, moves or deletes. Only the person sends.
10. **Never on the interaction path.** Runs happen in the sync worker as asynchronous child processes.
    Results are written there and read locally, so no interaction waits for a model (ADR 0012, 0019).

## Consequences

- Nothing has to be paid for beyond what people already have, and nothing is resold or intermediated.
- A CLI update can change what we depend on. The check in rule 4 turns that into a visible error.
- **Before a public release, ask Anthropic** whether showing and using plan limits in a third-party app
  needs approval. The Agent SDK documentation restricts offering plan limits without approval, and
  `claude -p` is described as that SDK from the command line. This is the owner's call to make with
  them, and it blocks a public release of this runtime, not its development.
- Codex's `readOnly` sandbox may still let its tools read files. Its adapter must prove in the rule 5
  test that tools are off before it can be `ready`.
- Limits are known for Claude only after a turn; the status shows when they were last seen.
- The 5-hour window may open on first use. Background work should not open a fresh window on its own;
  this needs checking against real use.
- The numbers in rule 7 are guesses until measured on real mail, on the owner's plan, with their
  agreement.

### Refinement, 2026-11-05: what the person sees is what the model gets

1. **Visible text.** For a message that has HTML, the text that goes to a model is what the reader's
   page would show (`visibleText` in the mime adapter), not the stored plain text: text hidden with
   `display:none`, `visibility:hidden`, `font-size:0`, a clipping box of zero size, the `hidden`
   attribute or the message's own style rules is left out. `htmlToText` is unchanged and still feeds
   search and the snippet. Mail stored before this keeps its stored text, so the service reads the
   stored HTML again for the prompt.
2. **Invisible characters.** Zero-width, bidirectional and tag characters are removed from what goes to
   a model, and ignored when a quote is matched.
3. **The ledger also records the person's choices.** Turning AI on writes a `consent` line for each
   account, with the number of threads the choice named; turning it off writes `revoke`.
4. **Nothing is started for a person who has not turned AI on.** The program is not asked who is signed
   in until AI is on or the person asks for its status.
