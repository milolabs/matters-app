# Architecture

Matters is an open-source (AGPL-3.0), local-first, ultra-fast desktop mail
client. This page is the map; the reasons behind each choice live in
[`docs/adr/`](adr/).

## Principles

1. **Nothing slow sits between a keystroke and the screen.** The UI reads only
   local data; the network is never on the interaction path
   ([ADR 0012](adr/0012-performance-budgets.md)).
2. **The core knows nothing about the outside world.** Domain rules and use
   cases depend on ports (interfaces), never on IMAP, SQLite, Electron or Node
   ([ADR 0004](adr/0004-hexagonal-architecture.md)).
3. **A new integration is a new adapter, not a change to the core.** Gmail API,
   Microsoft Graph, JMAP or an LLM agent plug into existing ports.
4. **Every dependency respects the license.** See
   [ADR 0013](adr/0013-dependency-license-policy.md).

## Hexagon

```
                 driving side (primary adapters)
   ┌──────────────────────────────────────────────────────────┐
   │ apps/desktop renderer (SolidJS)  ── contracts over MessagePort
   │ apps/cli (later: headless sync, bench, scripted tests)   │
   └───────────────────────────┬──────────────────────────────┘
                               │ calls use cases
                ┌──────────────▼───────────────┐
                │ packages/core                │
                │  domain/     entities, rules │  pure TypeScript,
                │  usecases/   SyncAccount,    │  no I/O, no node:*,
                │              OpenThread,     │  no adapter imports
                │              Search, Archive,│
                │              SendDraft …     │
                │  ports/      interfaces ─────┼──┐
                └──────────────────────────────┘  │ implemented by
   ┌──────────────────────────────────────────────▼───────────┐
   │ driven side (secondary adapters)                         │
   │ adapter-imap        MailSyncPort,       (imapflow)       │
   │                     MailFlagsPort,                       │
   │                     MailMovePort                         │
   │ adapter-smtp        MailSubmitPort      (nodemailer)     │
   │ adapter-sqlite      MessageStorePort, SearchIndexPort,   │
   │                     MessageBodyPort, OutboxPort,         │
   │                     FlagOutboxPort, MoveOutboxPort,      │
   │                     CursorPort (node:sqlite)             │
   │ adapter-mime        MimeParserPort      (postal-mime)    │
   │ adapter-compose     ComposeRendererPort (markdown-it …)  │
   │ adapter-secrets     CredentialPort      (safeStorage)    │
   │ adapter-oauth       BrowserSignInPort,  (node:http,      │
   │                     TokenRenewalPort    fetch; main)     │
   │ adapter-autoconfig  ServerDiscoveryPort (ISPDB, DNS SRV, │
   │                     MX/TXT/CNAME signs of who runs mail) │
   │ adapter-claude-code AgentRuntimePort    (the user's CLI) │
   │ adapter-codex       AgentRuntimePort    (the user's      │
   │                     `codex`, each turn closed)           │
   │ adapter-ollama      AgentRuntimePort    (Ollama on       │
   │                     127.0.0.1, Node's fetch)             │
   │ adapter-graph       MailConnectorPort,  (fetch; Microsoft│
   │                     MailSubmitPort      Graph, ADR 0136) │
   │ later: adapter-gmail-api, adapter-jmap,                  │
   │        more runtimes behind AgentRuntimePort             │
   └──────────────────────────────────────────────────────────┘
```

The **composition root** (`apps/desktop/src/backend/main.ts`, and
`syncWorker.ts` for the sync worker) is the only place that chooses adapters and
wires them into use cases. Mail moves over IMAP and SMTP or over Microsoft Graph,
by the account's transport: the worker hands core one connector and one
submitter that pick the adapter by the target's `transport`
(`backend/transports.ts`, [ADR 0136](adr/0136-microsoft-mail-moves-over-microsoft-graph.md),
rule 4); core never learns that Graph exists. The sync worker builds every
agent runtime the app knows; the agent service runs only the one the person chose
in Settings, and never another in its place
([ADR 0119](adr/0119-a-runtime-on-this-machine.md)).

## Repository layout

```
apps/
  desktop/            Electron app
    src/main/         thin: windows, tray, menus, process supervision
    src/backend/      utilityProcess: router (reads) + sync worker (writes, sync)
    src/renderer/     SolidJS UI
                      agent.ts (store), threadAgent.tsx (the agent in a thread), promptLine.tsx
                      (a view with a prompt), plansLine.tsx (status of the plans), agentLayer.tsx
                      (the agent colour, dashed frame and ring), agentSection.tsx and
                      agentSetup.tsx (Settings and first run); ADR 0051, 0116, 0117, 0119
packages/
  core/               domain + use cases + ports
  contracts/          IPC schema shared by renderer and backend
  adapter-*/          one package per adapter
  testkit/            in-memory fakes of every port + contract test suites
bench/                fixtures (8k / 100k / 500k messages) and budgets
docs/
  architecture.md     this file
  adr/                architecture decision records
```

## Processes

| Process | Runs | Never runs |
|---|---|---|
| main | windows, tray, menus, updater, the credential vault, browser sign-in and token renewal ([ADR 0133](adr/0133-microsoft-mail-signs-in-through-the-browser.md)) | SQLite, sync, parsing |
| backend router (`utilityProcess`, main thread) | read-only SQLite, request routing, supervising the sync worker | writes, IMAP/SMTP, parsing |
| sync worker (thread of the backend) | writer SQLite, IMAP/SMTP and Microsoft Graph, MIME parsing, indexing, account changes | serving the UI |
| renderer | SolidJS UI, in-memory thread graph | blocking calls |

The renderer talks to the backend over a direct `MessagePort`, not through main
([ADR 0005](adr/0005-electron-runtime.md)). Inside the backend, reads and
writes run on separate threads so a sync never delays a request
([ADR 0019](adr/0019-backend-router-and-sync-worker.md)).

Secrets stay in main. The backend reads credentials over a port of its own from
the vault main serves, which renews a browser sign-in's access token before it
ends and never hands out its refresh token. A page that asks main for a browser
sign-in (setup, Settings › Accounts) gets back a handle and the address that
signed in; the handle goes to the backend with `addAccount` or `signInAgain`, and
the backend moves what it holds to the account once both servers took the token
([ADR 0133](adr/0133-microsoft-mail-signs-in-through-the-browser.md)).

A Microsoft mailbox found or chosen in setup is added over Graph with the second
provider entry, `microsoftGraph`, and stores no servers. The two Graph adapters
and the worker's reader of the vault share one book of refused tokens: Graph's
first `401` for a token marks it and fails the request as a retryable failure;
the next read of that account's credential asks the vault to renew now
(`CredentialPort.get(id, { renew: true })`, carried over the credential RPC and
joined with a renewal already running), and a `401` for the renewed token is
`signInAgain` ([ADR 0136](adr/0136-microsoft-mail-moves-over-microsoft-graph.md),
rule 11). Window tests of a dev build may point Graph at a stand-in on the
loopback address (`MATTERS_TEST_GRAPH_BASE`) and answer DNS from a table
(`MATTERS_TEST_DNS`); main passes neither to a packaged app.

## Data flow

```
IMAP ──(cursor: UIDVALIDITY / UID / MODSEQ)──▶ backend
                                               ├─ parse MIME
                                               ├─ precompute: sanitized HTML, snippet, thread, FTS text
                                               ├─ SQLite: metadata │ FTS5 │ zstd thread blocks │ outbox
                                               └─ change_seq++ ──MessagePort──▶ renderer graph
user action ─▶ renderer graph (instant) ─▶ outbox op ─▶ IMAP/SMTP in the background
```

## The product's own layer on top of mail

Matters defines its own concepts above plain mail: `Case`, `Obligation`,
`Commitment`, `Proposal`, `Draft`, `Approval` (bound to an exact draft) and
`SendOperation` (never retried blindly). They live in `packages/core/domain`;
mail entities (`Message`, `MailThread`, `Participant`, `Attachment`) are
extended with labels, provider ids and sync state.
