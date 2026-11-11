# 0002. AGPL-3.0 with a contributor license agreement

- Status: Accepted
- Date: 2026-11-03

## Context

The code must be public and genuinely open source (OSI-approved), while leaving
room for commercial offerings (hosted drafting agent, sync, team features,
commercial licenses). Options considered:

- MIT / Apache-2.0: maximum adoption, but anyone can ship a closed fork or SaaS.
- FSL / BSL: blocks competing products, but is not open source until conversion.
- PolyForm Noncommercial: not open source;
  would even forbid a freelancer using the app for work.
- AGPL-3.0: open source; anyone offering a modified version, including over a
  network, must publish their changes.

## Decision

- The whole codebase is licensed under **AGPL-3.0**.
- Contributors sign a **CLA that grants a license** (not a copyright
  assignment), so the project can also offer the code under commercial terms.
- The CLA is collected automatically on pull requests (e.g. CLA Assistant).

Decided on 2026-11-11: **`AGPL-3.0-only`**. Version 3 applies and no later one by
itself; the CLA lets the project move to a later version if it chooses to.

## Consequences

- Every dependency must be AGPL-compatible ([ADR 0013](0013-dependency-license-policy.md)).
- The name and logo are not covered by the license; trademark is handled
  separately.
- The CLA text and the commercial license deserve a one-time legal review.
