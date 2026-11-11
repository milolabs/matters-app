# 0010. SolidJS 1.9 for the UI

- Status: Accepted
- Date: 2026-11-03

## Context

The renderer must update one row of a 500k-message list without re-rendering
the list. SolidJS updates exactly the DOM nodes that depend on changed data,
with no virtual DOM. React has a larger ecosystem and contributor pool.
Solid 2.0 is a release candidate (`solid-js@next`, `@solidjs/web`); 1.9 is
stable.

## Decision

- **SolidJS 1.9** (stable). Move to 2.0 after its stable release, in a
  dedicated ADR.
- Kobalte for accessible primitives (menus, dialogs, command palette),
  TanStack Virtual for lists, Tailwind 4 for styling, CodeMirror 6 for the
  editor.
- Keyboard-first: every action has a shortcut; command palette on `⌘K`.
- Fixed row heights in lists; no spinners on the interaction path.

## Consequences

- Fewer ready-made components and contributors than React.
- One migration to Solid 2.0 ahead.
