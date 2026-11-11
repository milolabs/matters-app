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
   │ adapter-autoconfig  ServerDiscoveryPort (ISPDB, DNS SRV) │
   │ adapter-claude-code AgentRuntimePort    (the user's CLI) │
   │ later: adapter-gmail-api, adapter-msgraph, adapter-jmap, │
   │        more runtimes behind AgentRuntimePort             │
   └──────────────────────────────────────────────────────────┘
```

The **composition root** (`apps/desktop/src/backend/main.ts`) is the only place
that chooses adapters and wires them into use cases.

## Repository layout

```
apps/
  desktop/            Electron app
    src/main/         thin: windows, tray, menus, process supervision
    src/backend/      utilityProcess: router (reads) + sync worker (writes, sync)
    src/renderer/     SolidJS UI
                      agent.ts (store), matters.tsx (the Matters view), plansLine.tsx (status of
                      the plans), agentLayer.tsx (the agent colour, dashed frame and ring),
                      agentSection.tsx and agentSetup.tsx (Settings and first run); ADR 0051, 0052
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
| main | windows, tray, menus, updater | SQLite, sync, parsing |
| backend router (`utilityProcess`, main thread) | read-only SQLite, request routing, supervising the sync worker | writes, IMAP/SMTP, parsing |
| sync worker (thread of the backend) | writer SQLite, IMAP/SMTP, MIME parsing, indexing, account changes | serving the UI |
| renderer | SolidJS UI, in-memory thread graph | blocking calls |

The renderer talks to the backend over a direct `MessagePort`, not through main
([ADR 0005](adr/0005-electron-runtime.md)). Inside the backend, reads and
writes run on separate threads so a sync never delays a request
([ADR 0019](adr/0019-backend-router-and-sync-worker.md)).

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
