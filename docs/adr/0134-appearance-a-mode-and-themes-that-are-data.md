# 0134. Appearance: a mode the person chooses, and themes that are data

- Status: Accepted
- Date: 2026-11-14
- Amends: [0085](0085-mail-in-the-dark-theme.md) (the dark ground and ink under a message are the
  theme's, not always `#1e1e20`),
  [0103](0103-the-window-waits-for-the-page-not-a-clock.md) (the loading screen reads the app's
  colour tokens and keeps its own values only as fallbacks),
  [0118](0118-effort-is-set-per-kind-of-work.md) (rule 1: a fifth kind of work, appearance),
  [0121](0121-a-runtime-for-each-kind-of-work.md) (rule 1: the fifth kind has its own runtime;
  rule 4: it asks no account for consent, because no mail goes with it)
- Builds on: [0036](0036-settings-window.md) (a section in Settings; this
  preference goes through main, not `localStorage`)
- Relates to: [0033](0033-account-dot-and-chosen-colors.md) (account colours are not part of a
  theme), [0012](0012-performance-budgets.md) (no budget changes)

## Context

- **The app follows the system and nothing else.** `styles.css` has one set of colour tokens in
  `:root` and a second one under `prefers-color-scheme: dark`. `appTheme.ts` reads the same media
  query. A person cannot keep Matters light on a dark system, or the other way round.
- **The colours are already tokens.** About forty custom properties carry every surface, line,
  ink and accent. A different look is a different set of values for the same names.
- **Three places know the colours outside `styles.css`.** Main gives each window a background
  colour before the page loads (`#1e1e20` or `#ffffff`). The loading screen (`boot.css`) repeats
  six values because it is shown before `styles.css`. The mail frame's base style has the dark
  ground and ink of ADR 0085.
- **The mode can be set in one place for every window.** Electron's `nativeTheme.themeSource`
  decides what `prefers-color-scheme` answers in every window of the app. Main already sets it
  for traces (`MATTERS_TRACE_THEME`).
- **Settings are a second window** (ADR 0036). A change made there has to show in the mail window
  at once, and a window opened later has to start in the right colours.
- **This is a mail client.** CSS from outside can send data out (`url(…)`) and can hide or move
  what the person reads. A theme that is CSS would be code from a stranger running over the mail.
- **People want to make their own,** and to describe a look in words and get it. The agent runs
  on the person's own subscription and can write a set of colours from a description.
- **A person who makes a bad theme must be able to get out of it,** including when they cannot
  read the screen any more.

## Decision

1. **Settings get a section, *Appearance*.** It has the mode, the themes, and *Use default*.
2. **The mode is System, Light or Dark.** Main keeps it and sets `nativeTheme.themeSource` from
   it. Everything that reads `prefers-color-scheme` follows without a change: `styles.css`, the
   loading screen, `appDark`, and what ADR 0085 does with mail.
3. **The default theme is the CSS.** It is not a file and is not in the list of things that can
   be removed or changed. A theme is an overlay on it: values for some tokens, and nothing more.
4. **A theme is a JSON file of colours.** It has a name and a set of values for light, for dark,
   or for both. A value is a hex colour (`#rgb`, `#rrggbb`, `#rrggbbaa`) and nothing else: no
   CSS, no `url`, no image, no font, no size, no animation. A key that is not a known token, a
   value that is not a hex colour, or a file over 16 KB makes the whole file refused.
5. **What a theme may set:** the surfaces (`bg`, `chrome`, `fill`, `soft`, `selected`, `button`,
   `pill`), the lines (`hairline`, `edge`), the ink (`ink`, `mid`, `secondary`), the accent
   (`agent`, `agent-soft`, `agent-edge`, `agent-wash`), the signals (`late`, `good`) and the
   search hit (`hit`, `hit-ink`). A token it leaves out keeps the default's value for that mode.
   Account colours (ADR 0033), the mark's violet, type, spacing and shadows are not in a theme.
6. **A theme has to be readable to be applied.** Before a theme is used, each ink (`ink`, `mid`,
   `secondary`, `agent`, `late`, `good`) is checked against each surface it is drawn on, and
   `hit-ink` against `hit`, at 4.5:1 (WCAG 2.1 contrast). A theme that fails is not applied, and
   Appearance says which pair failed and by how much. The check and the parser are one pure
   module with tests; a window only ever gets values that passed.
7. **A theme with one set fixes the mode while it is on.** A theme that has only dark values
   shows the app dark, whatever the mode says, and the mode control says so. A theme with both
   sets leaves the mode free.
8. **Main owns the appearance.** The mode and the chosen theme are in `appearance.json` in the
   data folder; themes are files in `themes/` there. Main reads them before it opens a window. On
   a change it writes the file, sets the mode, and sends the checked values to every open window.
   The backend is not involved: this is not mail.
9. **The colours are there before the first paint.** Main gives a new window the theme's `bg` as
   its background colour. The preload sets the theme's values as custom properties on the root
   element before the page's own scripts run. The loading screen reads those tokens, with its
   present values as fallbacks, so it is in the theme too.
10. **Mail in a theme.** In dark, the ground and ink under a message are the theme's `bg` and
    `ink`, and recolored mail (ADR 0085, rule 3) lands on that ground. In light, a message is
    still shown as sent, on white.
11. **Three ways back to the default.**
    - *Use default* in Appearance: the mode goes to System and no theme is on. Themes stay in the
      list.
    - *Reset Appearance* in the app menu (View), for a person who cannot read Settings.
    - By itself: a chosen theme that is missing, refused or unreadable (rule 6) is not applied.
      The app starts in the default and Appearance says why.
12. **Themes come from two places, and all pass the same check.** Built into the app (a small
    number, kept in the source); and the agent: the person describes a look, the agent answers
    with the JSON of rule 4, and the answer is treated as something from outside. Appearance
    offers no way to add a file, because the format is not something a person should have to
    know; a file put into `themes/` by hand is still read and checked. What the agent writes is
    never CSS and is never applied without rules 4 and 6.
13. **Making a theme is a kind of work of its own, *Appearance*.** Settings › Agents lists it
    with the other four (`appearance` beside `understand`, `write`, `answer`, `titles`), and the
    person chooses its runtime, model and effort as for the others (ADR 0118, ADR 0121). Each
    runtime remembers its model and effort for it. It starts on the runtime that writing has
    when the kind first appears, at effort `default`.
14. **No mail goes with it, so no account is asked.** A turn of this kind gets the person's
    description, the list of tokens with what each is for, and the theme that is on, if the
    person asks to change it. It gets no mail, no address and no account name, and it has no
    tools. The consent of ADR 0121, rule 4 is about mail and is not asked; a runtime needs only
    to be ready.
15. **The rest of ADR 0121 holds for it.** Never a fallback: when its runtime cannot be used,
    Appearance says why and waits, and nothing moves to another runtime. Its turns count against
    that runtime's plan as work the person asked for, not as background work, and the ledger
    names them. A theme that fails rule 4 or 6 is asked for again once, with what failed; after
    that the person is told and decides.
16. **Appearance says who will make the theme:** the runtime and model of this kind, beside the
    description field, with a way to Settings › Agents.
17. **It is built in three steps, each usable on its own:** (a) the section, the mode, main's
    ownership and *Use default*; (b) theme files, the check, the built-in themes, the loading
    screen and mail; (c) the kind of work and a theme from a description.

## Consequences

- A person can keep Matters light or dark whatever the system does, and the Settings window and
  the mail window change together.
- A theme cannot run code, load anything or move anything. The cost is that a theme cannot change
  shape, type or add a background picture or animation. That is meant: nothing moves that the
  person did not ask to move, and startup and scrolling cost the same as today.
- The contrast floor refuses some looks people will ask for (pale ink on a pale ground). The
  message has to say what to change, or the agent's themes will be refused without a reason the
  person can act on.
- Agents gets a fifth row for work most people do a few times a year. In return a person can
  give it a model of its own, for example the best one they pay for, without touching writing.
- A runtime in use only for appearance is checked and tested like any other in use (ADR 0121,
  rule 2), with no account agreed to it. That case does not exist today and needs a test.
- Account dots were tuned for 3:1 on the two default grounds (ADR 0033). On a theme's ground a
  dot can fall under that. Not checked here; to look at once themes exist.
- A light theme with a tinted ground shows mail as a white page on that ground.
- `boot.css` and `styles.css` still have to agree on the default values, as now.
- Measured in a window: the root element is not there when the preload runs (the document is
  still loading and empty). The preload gets the checked values from main synchronously, watches
  the document, and puts them on the root element as it appears, under 2 ms later, with the head
  parsed and no body yet, so before anything is drawn. The window's own background colour covers
  the time before.
- Windows and Linux have no app menu, so *Reset Appearance* is also a key chord main handles in
  every window, whatever the page shows: Cmd+Option+Shift+0 on macOS (shown on the menu item),
  Ctrl+Alt+Shift+0 elsewhere. Appearance names it.
- The colour picker of ADR 0033 keeps using `localStorage`. Two ways for a display preference to
  cross windows now exist; this one is in main because main needs it before a page loads.
- Themes are files on this computer. They do not sync, and nothing shares or installs them from
  the network.
- Measured with one real turn of the kind (Claude Code, Sonnet, effort default, the description
  "Warm paper with dark brown text and a deep green accent, in light and dark"): about 3k tokens
  in and 1.5k out, 12.6 s, and a theme with both sets and every token that passed rules 4 and 6
  on the first try, so the retry did not run.
- The ledger needed a schema change for the turns of this kind to be named: `appearance` is a new
  `purpose`, with no account (`""`) and no thread (migration 56 rebuilds the table's CHECK).
- A runtime in use for this kind is tested by itself once AI is on, also when it shares the
  runtime with kinds that take mail and no account agreed to it yet: the test is the made-up
  message only, as before.
