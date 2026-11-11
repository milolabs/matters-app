# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-11-03

## Context

Matters is public and will have outside contributors. They need to know not
only how the code is built but why, so they don't undo a deliberate choice.

## Decision

Every architectural decision is an ADR in `docs/adr/`, in English, using
`template.md`. Accepted ADRs are not edited; a new ADR supersedes them.

## Consequences

Pull requests that change architecture include an ADR. Reviews can point to an
ADR instead of re-arguing a settled question.
