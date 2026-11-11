# 0013. Dependency license policy

- Status: Accepted
- Date: 2026-11-03

## Context

The code is public under AGPL-3.0 ([ADR 0002](0002-license-agpl-and-cla.md)).
One incompatible dependency or copied file compromises both the open-source
release and the commercial licensing. GitHub's license badge is not reliable
(imapflow shows `NOASSERTION` but is MIT in `LICENSE.txt` and `package.json`).

## Decision

Rule 1: **comply with every license.**

- Allowed without discussion: MIT, ISC, BSD-2-Clause, BSD-3-Clause,
  Apache-2.0, 0BSD, Unlicense, CC0-1.0, public domain, Zlib, BlueOak-1.0.0.
- Allowed with a note in the PR: MPL-2.0, LGPL-2.1+/LGPL-3.0, GPL-3.0,
  AGPL-3.0, dual licenses that include an allowed option (e.g. DOMPurify
  `MPL-2.0 OR Apache-2.0`).
- Forbidden: GPL-2.0-only (incompatible with AGPL-3.0), SSPL, BSL/BUSL, FSL
  before conversion, Commons Clause, PolyForm (any), Creative Commons NC/ND,
  "source available", proprietary, no license.
- Check the actual license file of the version being added, not the badge.
- Never copy code from source-available projects (e.g. under PolyForm
  Noncommercial). Patterns and ideas only.
- Copied snippets from permissive projects keep their copyright and license
  notice.
- CI runs a license check over the full dependency tree and fails on anything
  outside the allowed lists.
- Fonts, icons and images follow the same rule (OFL-1.1 is allowed for fonts).

Checked so far (2026-11-03): solid-js, @kobalte/core, @tanstack/solid-virtual,
markdown-it, marked, micromark, juice, turndown, @codemirror/lang-markdown,
imapflow are MIT; DOMPurify is MPL-2.0 OR Apache-2.0.

## Consequences

- Adding a dependency costs a license check; CI makes it routine.
- Some convenient libraries will be off-limits.
