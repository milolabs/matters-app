# Matters

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/milolabs/matters-app/badge)](https://scorecard.dev/viewer/?uri=github.com/milolabs/matters-app)

Matters is an open-source desktop mail client that keeps your mail on your
computer and shows you what is still on you: what you promised, who waits for
an answer, what has a date.

It is early. There is no download yet; today you build it from source, and it
is developed and tested on macOS.

## What it does

- **Local first.** Mail is synced over IMAP into a SQLite database on your
  computer. The window reads only local data, so lists, search and threads do
  not wait for the network.
- **Fast by design.** Speed has budgets that are measured on mailboxes of
  8,000, 100,000 and 500,000 messages
  ([ADR 0012](docs/adr/0012-performance-budgets.md)).
- **Views with a prompt.** Write in your own words what you want to find, such
  as `prompt:"mail that needs my reply or decision"`, and save it as a tab. An
  agent reads the mail the rest of the query finds, shows what fits with a
  reason beside each row, and reads new mail for the view as it comes
  ([ADR 0116](docs/adr/0116-a-prompt-is-a-filter.md),
  [ADR 0117](docs/adr/0117-matters-is-a-view-with-a-prompt.md)). The first
  time you turn AI on, a view named `Needs you` is added, and you can change or
  delete it like any other. You can also ask the agent about a thread or all
  your mail, and have it draft a reply for you to check and send. It runs on
  the Claude plan you already pay for, through Claude Code on your computer,
  or on a model on your computer with Ollama, where mail never leaves it;
  Matters has no server of its own
  ([ADR 0051](docs/adr/0051-agents-on-the-users-own-plans.md),
  [ADR 0119](docs/adr/0119-a-runtime-on-this-machine.md)). With a ChatGPT plan
  it runs through Codex, each turn with its own tools off
  ([ADR 0120](docs/adr/0120-codex-is-a-runtime.md)). You choose,
  per account, whether the agent may read it, and the app works without AI.
- **Careful with hostile mail.** Remote content, tracking and active HTML are
  handled by rules that are tested against a corpus of made-up hostile
  messages ([ADR 0047](docs/adr/0047-hostile-mail-corpus.md),
  [security standards](docs/security/standards.md)).

## What it does not do yet

- **Sign-in is by password only.** Gmail, iCloud, Yahoo and Fastmail work with
  an app password. Microsoft 365 and Outlook.com need browser sign-in (OAuth),
  which is not built yet, so they do not work.
- **The agent connects to Claude Code, Codex and Ollama only.** API keys are
  planned. Codex does not report the plan's limits, so reading in the background
  stops at the first refusal until you continue it. With Ollama, what the agent can do with attachments
  depends on the model: one that takes tools searches in a loop and reads the
  text of attached files, one that sees images gets images whole, and a scan
  in a PDF is not sent whole.
- **No download, no updates, no Windows or Linux build.** How the first release will be made is
  in [docs/release.md](docs/release.md).

## Build and run

You need [Bun](https://bun.sh) 1.4 and macOS.

```sh
bun install
bun run dev:desktop:demo   # the app on a made-up mailbox
bun run dev:desktop        # the app on your own accounts
```

Checks:

```sh
bun run typecheck
bun run lint
bun run test
bun run check:boundaries
bun run check:licenses
bun run smoke:desktop
```

## How it is built

A hexagonal monorepo: `packages/core` holds the domain and use cases and
knows nothing of IMAP, SQLite or Electron; adapters in `packages/adapter-*`
plug into its ports; `apps/desktop` is the Electron app with a Solid renderer.
[docs/architecture.md](docs/architecture.md) is the map, and every decision
has a record in [docs/adr](docs/adr/README.md).

## Contributing

Issues and pull requests are welcome. Contributors are asked to sign a
contributor license agreement that grants a license to the project and leaves
the copyright with them ([ADR 0002](docs/adr/0002-license-agpl-and-cla.md)).
The agreement is not set up yet; until it is, please open an issue before
starting on a larger change.

Please report security problems privately, not in a public issue:
[SECURITY.md](SECURITY.md) says how, and what the app is meant to withstand.

## License

[GNU Affero General Public License, version 3 only](LICENSE)
(`AGPL-3.0-only`). The name Matters and
its logo are not covered by the license.
