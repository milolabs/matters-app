# 0003. Monorepo with Bun workspaces

- Status: Accepted
- Date: 2026-11-03

## Context

The app is one product made of a core, many adapters, IPC contracts, a test
kit and benchmarks. Projects of this kind commonly
use the same shape: `apps/` + `packages/`, one package per provider.

## Decision

One repository, Bun workspaces:

- `apps/` for runnable programs (`desktop`, later `cli`),
- `packages/` for libraries (`core`, `contracts`, `adapter-*`, `testkit`),
- `bench/` and `docs/` at the root.

Bun is the package manager, script runner and bundler front-end. It is **not**
the runtime of the shipped app ([ADR 0005](0005-electron-runtime.md)).

## Consequences

- One lockfile, one CI, atomic changes across core and adapters.
- Package boundaries make the hexagon visible and enforceable
  ([ADR 0004](0004-hexagonal-architecture.md)).
- Tests that touch SQLite must run on the same Node as Electron, not on Bun.
