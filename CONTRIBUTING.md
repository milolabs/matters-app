# Contributing to Matters

Thank you for looking. Issues and pull requests are welcome. This page says how to set up, what
the checks are and how a change reaches `main`.

## Before you start

- **Open an issue before a larger change.** Contributors are asked to sign a contributor license
  agreement that grants a license to the project and leaves the copyright with them
  ([ADR 0002](docs/adr/0002-license-agpl-and-cla.md)). The agreement is not set up yet, so a larger
  change cannot be merged today; an issue lets us agree on it first.
- **Report security problems privately**, not in an issue or a pull request.
  [SECURITY.md](SECURITY.md) says how.
- **Write in English**: code, comments, commit messages, issues and documents.

## Set up

You need [Bun](https://bun.sh) 1.4 and macOS.

```sh
git clone https://github.com/milolabs/matters-app.git
cd matters-app
bun install
bun run dev:desktop:demo   # the app on a made-up mailbox
```

`bun run dev:desktop` starts the app on your own accounts.

## The checks

CI runs these on every pull request. Run them before you push:

```sh
bun run typecheck          # types
bun run lint               # Biome
bun run test               # unit tests and the hostile-mail corpus
bun run check:boundaries   # the rules of the architecture
bun run check:licenses     # licenses of dependencies
bun run smoke:desktop      # builds the app and starts it
```

## Where a change goes

[docs/architecture.md](docs/architecture.md) is the map. The short form:

- `packages/core` holds the domain and the use cases. It depends on ports, never on IMAP, SQLite,
  Electron or Node. `bun run check:boundaries` holds it to that.
- A new integration is a new adapter in `packages/adapter-*`, not a change to the core.
- `apps/desktop` is the Electron app with a Solid renderer.

## Decisions are written down

Every decision has a record in [docs/adr](docs/adr/README.md). A change that makes or changes a
decision adds a new record: copy [`template.md`](docs/adr/template.md), take the next number and
add a row to the table in the index. An accepted record is not rewritten; a new one supersedes it.

## Dependencies

Every dependency must pass the license policy
([ADR 0013](docs/adr/0013-dependency-license-policy.md)); `bun run check:licenses` checks it. Say
in the pull request why a new dependency is needed.

## Pull requests

Every change reaches `main` through a pull request
([ADR 0126](docs/adr/0126-changes-reach-main-by-pull-request.md)):

1. Branch from `main` and keep the change to one thing.
2. Add or change tests with the code. A fix for a message that broke something adds that message
   to the hostile-mail corpus ([ADR 0047](docs/adr/0047-hostile-mail-corpus.md)).
3. Open the pull request and say what changes and why.
4. CI must be green on a branch that is up to date with `main`, and an automatic reviewer reads
   the change first. Answer what it asks like any review: fix it, or say in the thread why not.

## License

Matters is licensed under [AGPL-3.0-only](LICENSE). The name Matters and its logo are not covered
by the license.
