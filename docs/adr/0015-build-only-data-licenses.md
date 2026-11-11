# 0015. Attribution-licensed data packages

- Status: Accepted
- Date: 2026-11-03
- Amends: [0013](0013-dependency-license-policy.md)

## Context

The SolidJS compiler toolchain (`vite-plugin-solid` → `@babel/core` →
`@babel/helper-compilation-targets` → `browserslist`) pulls in `caniuse-lite`,
browser-support data licensed CC-BY-4.0. ADR 0013 does not list CC-BY-4.0, so
the license check failed. The package is used at build time only and is not
part of the shipped app. CC-BY-4.0 is a permissive attribution license for
content, compatible with distributing AGPL-3.0 software. There is no practical
way to build Solid without this chain.

## Decision

- CC-BY-4.0 is allowed with a note **for data packages only**, named one by one
  in `tools/check-licenses.ts` (`DATA_PACKAGES`). Today: `caniuse-lite`.
- It is never allowed for code.
- Adding a package to `DATA_PACKAGES` requires a PR that names it and states
  whether it ships in the app; if it ships, its attribution goes into the
  app's third-party notices.

## Consequences

- The license check passes and still fails on any other CC-BY-4.0 package.
- Each new data package is a conscious, reviewed exception.
