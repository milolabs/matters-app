# 0005. Electron runtime, backend in a utility process

- Status: Accepted
- Date: 2026-11-03
- Supersedes: the Swift menu bar prototype as the shipping target

## Context

We want macOS, Windows and Linux from one codebase, and a public, contributor-
friendly stack. Electron ships its own Node (Electron 45: Node 24.22, SQLite
3.53 in `node:sqlite`); Bun cannot replace it. Electrobun (Bun-based) was
considered and rejected for now: younger, weaker update/signing story, system
webview differences. Fast Electron apps exist (Superhuman, Linear) when the
heavy work stays off the UI thread.

`node:sqlite` is synchronous: running it in main or the renderer would block
windows or the UI.

## Decision

- Runtime: **Electron**, Node inside it. Bun is tooling only.
- Three processes:
  - **main**: windows, tray, menus, updater, process supervision. Nothing heavy.
  - **backend** (`utilityProcess`): composition root, SQLite, IMAP/SMTP, MIME
    parsing, indexing.
  - **renderer**: SolidJS UI.
- Renderer ↔ backend over a direct `MessagePort` (no hop through main),
  using schemas from `packages/contracts`.
- Native Node modules are avoided where Electron already provides the feature
  (`node:sqlite`, `node:zlib` zstd, `safeStorage`).

## Consequences

- Bundle size ~150 MB; acceptable for a desktop mail client.
- Startup must be guarded (lazy modules, cached first screen, bundle budget).
- Local Node on developer machines must be ≥ 24 (Node 23.11's `node:sqlite`
  has no FTS5), or tests run via `ELECTRON_RUN_AS_NODE`.
