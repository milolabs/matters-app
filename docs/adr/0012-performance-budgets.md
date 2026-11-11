# 0012. Performance budgets enforced in CI

- Status: Accepted
- Date: 2026-11-03

## Context

Speed is the product's foundation, not a later optimization. The maintainer's
mailbox is ~8k messages, where anything is fast; other users will have 100k–
500k. Without automated checks, a contributor can quietly make it slower.

## Decision

Budgets, identical at every mailbox size:

| Interaction | Budget |
|---|---|
| launch → inbox visible | < 500 ms |
| `j`/`k`, archive, mark read | < 16 ms (one frame) |
| open a thread | < 50 ms |
| search per keystroke (query + IPC + render) | < 16 ms |
| list scrolling | no dropped frames at 60/120 Hz |

- `bench/` generates synthetic mailboxes of 8k, 100k and 500k messages.
- Playwright drives the Electron app and measures key → frame; CI fails when a
  budget is exceeded.
- Renderer bundle size has its own budget.
- Real exports (e.g. Google Takeout mbox) are used locally only, never
  committed.

Techniques the budgets rely on: precompute at sync time (sanitized HTML,
snippet, thread), prefetch neighbouring messages, a pool of pre-created
sandboxed iframes for message HTML, remote images blocked by default, a cached
first screen at startup, lazy-loaded heavy modules.

## Consequences

- CI is slower and needs a display (xvfb on Linux).
- Every feature is judged against the budgets before it merges.
