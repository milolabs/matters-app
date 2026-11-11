# 0004. Hexagonal architecture (ports and adapters)

- Status: Accepted
- Date: 2026-11-03

## Context

IMAP is only the first integration. Gmail API, Microsoft Graph, JMAP, LLM
drafting agents, other storage or search engines will follow. Each must plug in
without touching domain rules, and contributors must be able to add one without
understanding the whole app.

## Decision

**Core** (`packages/core`):

- `domain/`: entities and rules. Pure TypeScript.
- `usecases/`: application services (`SyncAccount`, `OpenThread`, `Search`,
  `ArchiveThread`, `SendDraft`, …).
- `ports/`: interfaces the core needs (driven ports) and offers (driving
  ports).

**Adapters** (`packages/adapter-*`) implement ports. Driving adapters (the
Electron renderer, a CLI) call use cases through `packages/contracts`.

Rules:

1. Dependencies point inward. `core` imports no adapter, no `node:*`, no
   Electron. Enforced by lint rules in CI.
2. **Capabilities, not provider checks.** A provider adapter declares what it
   can do (`threads`, `labels`, `push`, `serverSearch`, `qresync`, …); use
   cases branch on capabilities, never on "is this Gmail".
3. **Contract tests.** `packages/testkit` holds one test suite per port. The
   in-memory fake and every real adapter must pass the same suite (real IMAP
   against Dovecot in Docker).
4. **One composition root** (`apps/desktop/src/backend/main.ts`) wires
   adapters to use cases.
5. **Ports are batch- and stream-shaped** (`upsertMessages(batch)`,
   `search(query, limit)`, `changesSince(seq)`), so the abstraction does not
   cost speed on hot paths ([ADR 0012](0012-performance-budgets.md)).
6. Adapters are compiled in. No runtime third-party plugin loading in the MVP:
   a mail client holds all of a user's mail, and plugins need a security model
   first.

Dependency injection is plain TypeScript (interfaces + constructor
parameters). Effect was considered: it offers
layers, typed errors and retries, but has a steep learning curve and narrows
the contributor pool. It can be adopted later inside adapters without changing
ports.

## Consequences

- A new integration = a new `adapter-*` package + passing contract tests.
- Core logic is testable in milliseconds with fakes.
- More packages and interfaces than a flat app; the boundary lint keeps it
  honest.
