# 0141. The agent runs on the person's own API key

- Status: Accepted
- Date: 2026-11-16
- Amends: [0051](0051-agents-on-the-users-own-plans.md) (rule 4: paid use by the turn is a
  runtime the person adds and chooses; rule 7: the gates of a runtime billed to a key),
  [0119](0119-a-runtime-on-this-machine.md) (rule 7: a runtime with no plan may still cost
  money), [0121](0121-a-runtime-for-each-kind-of-work.md) (rule 9: reading in the background on a
  billed runtime waits for the person), [0131](0131-the-person-sets-the-background-limit.md)
  (the share of the week does not bound a key)
- Builds on: [0018](0018-accounts-credentials-background-sync.md) (the vault),
  [0083](0083-the-agent-searches-in-a-loop.md), [0090](0090-a-file-with-no-text-goes-to-the-answer-whole.md),
  [0118](0118-effort-is-set-per-kind-of-work.md), [0120](0120-codex-is-a-runtime.md),
  [0138](0138-erasing-what-matters-keeps.md) (what erasing lists)

## Context

The agent runs on Claude Code or Codex on the person's plan, or on Ollama on the machine. A person
with neither plan, or one who wants a model their plan does not offer, has an API key from the
provider and no way to use it. ADR 0051 already says paid use by the turn is only ever a runtime
the person added and chose; until now there was none.

An API is not a plan. There are no windows to read and no share of a week: every turn is billed
to the key, by the tokens it used, at a price that changes. The provider's own list of models says
what each model can do. Anthropic's list does (`GET /v1/models` names, per model, structured
outputs, the levels of effort, images, PDFs, its line and whether it is active). OpenAI's does not:
its list gives an id, a date and an owner, and nothing about schemas, tools or effort (read on
2026-11-16 in its API reference).

## Decision

1. **A plan stays the first choice; a key is an option beside it, never a fallback.** ADR 0119,
   rule 3 stands: only the runtime of a kind runs it. Nothing moves to a key by itself: not when a
   plan's limit is reached, not when Claude Code is missing. The runtimes are listed with the plans
   first, then the one on this machine, then the keys.
2. **One runtime: "Anthropic API".** It is its own entry in the list of runtimes, with consent per
   account, its own models, and effort per kind of work (ADR 0121), as any runtime. A second,
   "OpenAI API", is not built in this step; see *Not tried*. The adapter is written so the next
   provider is one more adapter beside it: the port, the vault, the service, the window and the
   tests take any runtime that says it is billed.
3. **Direct HTTPS with Node's `https`, no SDK.** The Messages API at `https://api.anthropic.com`,
   API version `2026-10-21`, the key in `x-api-key`. The host is fixed in code; a test may point
   the adapter at `127.0.0.1` and nowhere else. Not `fetch`: the one in the app's backend process
   (Node 24.22 with undici 7.30 in Electron 45) gives up when no response headers come within
   300 s, and the Messages API sends its headers only once the answer is written, which can take
   longer. With `https` the limits of rule 9 are the only ones.
4. **The key.** The person pastes it into a password field of the runtime's card, at first run or
   in Settings. It is kept in the same encrypted vault as the mail passwords (ADR 0018), as an
   entry of its own by runtime, encrypted through the keychain in main, and read by the adapter in
   the sync worker for each request over the same channel. It is never in the database, a settings
   file, a log, a trace, an error, the agent's log or an answer to a window: after it is saved, a
   window learns only that a key is kept (its state) and the time it was saved. Nothing of the key
   is shown, as nothing of a password is. The card offers Replace and Remove. Removing the key
   stops the turns on the runtime, those of a talk that chose it among them whatever kind of work
   is on it, and replacing the key does the same; it takes back every account's consent to the
   runtime (with a line in the ledger),
   and turns its reading in the background off: a key added later is agreed to again. The kinds of
   work on it stay there and wait. Erasing everything (ADR 0138) removes the vault, keys with it;
   the review names the keys beside the accounts. A variable such as `ANTHROPIC_API_KEY` in the
   app's environment is never read by this runtime, and is still removed from the Claude Code and
   Codex children as before.
5. **States, each with one sentence of what to do.** No key ("Paste an API key from the Anthropic
   Console to use it"); a key not tested yet; a key the provider refuses, by the class of its
   reason: a wrong key, no credit, no permission, no access to the model, or rate limited for now;
   ready. Ready only after the same test every runtime passes (ADR 0051, rule 5). The test is for
   the key: a key is kept in the vault with a random id made when it is saved (never made from its
   text), the stored test names the id of the key it ran on, and it holds only for that key, not
   by time, which two saves in one millisecond or a clock set back would get wrong. So a replaced
   key, or the same text saved again, is tested again; a test record that names no key (one from
   before the id, or a key kept before it) holds for none; and a test that was running on the old
   key when the new one was saved is not kept, nor shown for the new key, whenever it ends: during
   the turn or while its record is written. The same holds for a look at the runtime that began on
   the key before (it is looked at again), and for a refusal of a turn the new key stopped. The id
   is not told to a window; the database keeps it with the test record. A refusal during a turn sets the state too, a verdict turn of a prompt
   among them. The sentences are ours; the provider's words never reach the person.
   All of this is one rule: every look, test and turn on a runtime takes a ticket of the key when
   it begins, and what it learned (the state shown, the stored test, a refusal or a sign-out, the
   windows it saw, its answer) is kept only while that ticket is still the runtime's key; a new
   key also stops what runs on the one before. A turn the person asks for takes its ticket before
   its gates, which are decided for that key alone and not from what was found on a key before,
   and it is sent only while that ticket holds, which no ticket does while the vault is written.
6. **Money is said plainly.** The card and the consent question each say in one sentence that
   every turn is billed by Anthropic to the person's key. The runtime has no plan, so no windows
   or shares show (ADR 0119, rule 7). What bounds the cost is what the person does:
   - What the person asks for (`P0`) runs. A prompt's first `↵` reads at most its first batch and
     asks before the rest, as on a plan (ADR 0116, rule 4); only a runtime with no plan and no
     bill reads every match at once.
   - **Background work runs on a billed runtime only once the person turns it on**, with the
     switch `Read in the background` on the runtime's card in Settings. It is off when a key is
     saved, a replaced key or the same one saved again too (a saved key is a new key, agreed to
     again), and off when the key is removed. It is turned off before a new key is kept: if
     that fails, the new key is not kept. Saving the key, removing it and the switch run one at
     a time per runtime, in the order they were asked for, so a press of the switch during a
     save runs once the save has ended, for the new key. Off, nothing in the background is sent: views with a
     prompt do not read new mail, no talk is named by itself, a key not checked yet is not tested
     by itself (not when an account agrees to it, nor when its model changes), and the reading
     says why (`Waits: reading in the background on Anthropic API is off`). The test is a billed
     turn: it runs when the person presses Check on the card, or with the first thing they ask
     for on the runtime; until then the card says `Key saved · not checked yet`, with Check.
     Work no press of the person's started (a pass of the reading, the test it runs by itself,
     remembering what the person typed, the name of a talk) takes the ticket of rule 5 before it
     reads the switch, and is sent only while that ticket holds and the switch was not turned off
     since, checked with nothing awaited before the request: a key replaced or a switch turned off
     while it waited sends nothing. What any turn found (a rule, an instruction, a talk entry,
     prepared work, a verdict, a talk's name, help with a reply, a theme) is stored or handed back
     only while its ticket holds as the write begins, after every wait; the ledger counts the
     turn whether or not.
   - On, a pass reads as much as on a plan (a batch at a time), not a whole view at once as a
     runtime on this machine does.
   - The share of the week of ADR 0131 does not bound a key: a key has no week, and a percent of
     nothing is not a bound. The background limit is not shown for it.

   Token counts the API reports are returned with each turn, as for any runtime; no screen shows
   them, and there is no cost estimate and no price table: prices change, and we do not ship them.
7. **Models come from the provider's list.** The adapter lists the key's models (all pages, at
   most four of a thousand) and offers the active ones whose list entry says they take structured
   outputs. Each model's levels of effort, images and PDFs are what its entry says (ADR 0118; ADR
   0119, rule 9). Every model of the list takes tools of the request's own; the list has no
   capability for that. The starting model of each kind, by the `line` the list gives: writing,
   questions and themes on the newest Opus, else the newest Sonnet; understanding mail and talk
   titles, which are many small turns, on the newest Haiku, else Sonnet, else Opus; else the newest
   of all. The newest is by `created_at`. This follows the provider's own guidance: its current
   Opus as the default, its current Haiku for many cheap turns. The list is read again before a
   turn when the last read is older than a minute.
8. **Turns and tools.** A turn sends our fixed text as the system prompt and the mail as the
   person's message, as data, with the answer's schema as `output_config.format` (`json_schema`)
   and the effort as `output_config.effort` when the model lists that level; `thinking` is not
   sent, so each model runs as it does by default. Structured outputs do not take bounds of
   numbers, strings and arrays or patterns, so those are left out of what is sent and every object
   is closed; the answer is then checked against the whole schema and the rules of the turn, as for
   any runtime. A turn whose answer was cut short (`max_tokens`), or that the provider would not
   take for its size (`413`), is too long, and the person is told to ask about less; one the model
   declined (`refusal`) or that does not parse is not used. The search loop of ADR 0083 runs with
   our tools only, as on Ollama: rounds with the tools and no schema, the model's own turns given
   back unchanged with their thinking, every result of a round in one message as data; then one
   last request answers in the schema with `tool_choice` `none`. Images and PDFs go whole (ADR
   0090) to a model whose entry takes them. The prompts, the guards and the checks of the answer
   are the ones every runtime uses; nothing new lets mail reach instructions.
9. **Network.** Requests go only to the fixed host, with the key in its header, no redirect
   followed. Limits: 15 s for each look at the list, 600 s for a turn with its retries (900 s at
   most for a turn with tools), 8 MiB of answer, 64 KiB of an error. A request is tried again only
   when nothing was done with it: a status of 408, 429, 500, 502, 503, 504 or 529, at most twice,
   waiting 1 s then 2 s, or what `retry-after` asks, up to 30 s. A turn whose connection broke is
   not sent again, since it may have been taken and billed; a look at the list is. Stop ends a turn
   and any wait at once. Mail goes to Anthropic, and the consent question says so.
10. **Where it lives.** `packages/adapter-anthropic-api` implements the runtime port and passes the
    shared runtime contract of `packages/testkit` (added with it). The pure rules (the gate of a
    billed runtime, the shape of a key, the setting) are in core. The key's place in the vault is
    `adapter-secrets`'s; main serves it on the backend's credential channel.

### Not tried, and why

- **The OpenAI API.** Its list of models names no capability, so rule 7 could not be kept: which
  models answer in a schema, take tools or take which effort would come from a table of names in
  our code, which ages as models change, the thing this decision avoids. Built without it, the
  runtime would offer models that fail the test or refuse an effort. It is the next adapter, once
  that is settled (a list it does have, or an honest table with a date).
- **A budget in tokens or money for the background.** It would bound the cost better than a
  switch, but needs a number the person sets and a price we do not ship. The switch is the
  smallest honest bound; this is for the owner to decide.

### Not in this decision

- A custom base URL, a proxy, or an "OpenAI-compatible" endpoint: the host is fixed in code and is
  not a setting.
- Other providers, Amazon Bedrock, Google Cloud, Microsoft Foundry.
- Streaming, prompt caching, batches, the provider's server tools, refusal fallbacks to another
  model.
- Showing tokens or cost.

## Consequences

- A person with an API key and no plan can use the agent, and choose any model the key may use.
- Every turn costs money. Out of the box a key runs only what the person asks for; the views with a
  prompt do not keep up with new mail on it until the person turns that on, and say so.
- With the background on, the cost follows the mail that comes in. Nothing in the app stops a
  large mailbox from costing more than the person meant; the console of the provider is where a
  limit on the key is set.
- A question with the search loop costs one more request than its rounds: the answer is asked
  for apart from the search.
- Mail goes to a third company for those who choose this runtime, under the person's own account
  with it.
- The key sits in the vault with the passwords: the keychain protects both, and erasing removes
  both.
- Not verified: a turn against the real API with a real key. The tests run against a stand-in on
  this machine, written from the provider's documentation (the claude-api reference of
  2026-11-03 and the Models API reference read on 2026-11-16). That `output_config.format` and
  `tool_choice` `none` together with tools in the history behave as written has to be seen on the
  real service before a release.
