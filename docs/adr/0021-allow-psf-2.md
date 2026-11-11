# 0021. Allow PSF-2.0 with a note

- Status: Accepted
- Date: 2026-11-03
- Amends: [0013](0013-dependency-license-policy.md)

## Context

markdown-it 15 (compose pipeline, [ADR 0020](0020-sending-outbox-and-compose.md))
depends on `argparse` 3, licensed PSF-2.0 (the Python Software Foundation
license). It is used only by markdown-it's command-line tool and does not
appear in the app build. PSF-2.0 is a permissive, GPL-compatible license, and
so compatible with AGPL-3.0. ADR 0013 did not list it.

## Decision

`PSF-2.0` (and its SPDX alias `Python-2.0`) is allowed **with a note**: the
license check reports it, and every pull request that adds such a package says
why and whether it ships in the app.

## Consequences

`check:licenses` passes with argparse reported as a notice.
