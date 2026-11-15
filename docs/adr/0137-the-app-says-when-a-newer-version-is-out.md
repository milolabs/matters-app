# 0137. The app says when a newer version is out

- Status: Accepted
- Date: 2026-11-14
- Builds on: [0123](0123-releases.md), rule 11 (stage 2, its first half: saying, not installing),
  [0129](0129-the-site-offers-pre-releases.md) (the file the site publishes),
  [0036](0036-settings-window.md) (a section of Settings), [0115](0115-every-window-hears-a-changed-status.md)
- Design: [`docs/design/new-version-notice.html`](../design/new-version-notice.html)

## Context

There are four alphas. A tester who has one is not told about the next: ADR 0123 says so in its
consequences ("until stage 2 a person with an old version is not told"), and a security fix
reaches them only if they look. Alphas come often, so most testers run an old one.

Stage 2 of ADR 0123 has two halves. Saying that a newer release exists is small. Installing one
is not: it needs a checked signature, and an alpha is signed ad hoc, so there is nothing to check
it against yet. This record is the first half only.

ADR 0123 asked for a record of its own because the app would make a network request it does not
make today. Today the app talks to the person's mail servers, to the sign-in pages they open, to
the agent they chose, and to remote images when they allow them. It never talks to the project.

What already exists: the site publishes `https://getmatters.app/release.json` (ADR 0129), written
by the site workflow from the list of releases. It names the release the site offers: the newest
stable one, or, while there is none, the newest published pre-release. Read on 2026-11-14:

```json
{ "repo": "milolabs/matters-app", "version": "v0.1.0-alpha.4", "date": "2026-11-13T19:57:53Z",
  "url": "https://github.com/milolabs/matters-app/releases/download/v0.1.0-alpha.4/Matters-0.1.0-alpha.4-arm64.dmg",
  "notes": "https://github.com/milolabs/matters-app/releases/tag/v0.1.0-alpha.4", "stage": "alpha", "stars": 0 }
```

It is a static file of 335 bytes, served by GitHub Pages with an `ETag`. The other source would be
GitHub's API (`/repos/…/releases`): it allows 60 requests an hour for an address, answers with
far more than is needed, and would make the app repeat the rule of ADR 0129 about which release
counts.

Not tried: anything in the app. Nothing here has been built.

## Decision

1. **The app only says.** It learns that a newer release exists and says so. It downloads nothing
   and installs nothing. Installing is the second half of stage 2 and gets its own record.
2. **One file, from the site.** The app reads `https://getmatters.app/release.json` and nothing
   else. What counts as "the release" is decided once, by the site workflow (ADR 0129); the app
   does not ask GitHub's API.
3. **The request says nothing about the person.** A `GET` with no cookie, no identifier, no query,
   and not the version the app has: the comparison is made on the Mac. The `User-Agent` is the word
   `Matters`, with no version and no system. The host still sees the address the request comes
   from, as any web server does; the host is GitHub Pages.
4. **When.** At every cold start of the app, then once in 24 hours while it runs, and when the
   person asks. A cold start is the app's process starting, not a window opening or the Mac
   waking. The check of a start is made after the first window has shown its mail, never before:
   it is not on the path of the launch or of a keystroke (architecture, principle 1; the launch
   budget of ADR 0012). The last answer is kept, so the dot is there from the start, before the
   new answer comes. `If-None-Match` is sent when an `ETag` is known, so a start that learns
   nothing new costs an answer with no body.
5. **Only a release build asks.** A build that is not packaged (`app.isPackaged` false: a
   developer's build, a local bundle) never makes the request and says so in Settings. Its version
   is not one a release can be compared with.
6. **On by default, and the person can turn it off.** Settings has the switch, and nothing more
   about it: what the request is (rule 3) is written here and in `docs/security/standards.md`,
   not in the window. Off means no request at all, also not from the menu item, which then only
   opens Settings. On by default because the people who most need to hear about a fix are the
   ones who would never open Settings.
7. **Newer means newer by semantic versioning**, with the precedence of pre-releases:
   `0.1.0-alpha.4` < `0.1.0-alpha.5` < `0.1.0-alpha.10` < `0.1.0-beta.1` < `0.1.0` < `0.1.1`. The
   leading `v` of a tag is dropped. Equal or older says nothing. The rule is a pure function in
   `packages/core`, with the cases above as tests.
8. **The file is not trusted.** It is read with a size limit (16 KiB) and a time limit (10 s). The
   version must be a version. The two links are used only when they are `https` links under
   `https://github.com/milolabs/matters-app/releases/`; a link that is not is left out, and with no
   usable link the app sends the person to `https://getmatters.app/download.html`. A file that
   cannot be read is a failed check (rule 12), never "newest". No text from the file is shown
   other than the version, the stage and the date.
9. **A dot on the Settings gear.** The list's foot row keeps its parts: the accounts and their
   sync, the agent's reading, the gear. When a newer version is known, the gear in every mail
   window carries a small dot in the colour of the text: not green (sent), not red (late), not
   violet (the agent's). No segment is added and nothing in the row moves. The gear's name for a
   screen reader and its tooltip say it in words: "Settings · Matters 0.1.0-alpha.5 is out".
   While the dot is there, the gear opens Settings on About; without it, the gear opens Settings
   as it does today.
10. **Seeing About takes the dot away.** The same dot marks About in the list of sections. Once
    About has been shown while that version is known, both dots go, in every window, until a
    version newer than that one is out. There is no "never tell me": that is the switch of rule 6.
    About keeps saying what is out for as long as it is true.
11. **Settings, About.** A new section, last in the list: the name, the version and its stage; the
    line that says where the check stands (newest; a newer one; could not check; turned off; a
    build that does not ask); the switch; when it last checked; Check now. With a newer one the
    line has the version, the date, for a pre-release that macOS will ask before it opens one, that
    Matters does not install it, and two actions that open the browser (rule 8): Download and
    Release notes. The app menu gets "Check for a Newer Version…" under About: it opens this
    section and checks. When a newer one is known the item reads "New Version: 0.1.0-alpha.5…".
12. **A failed check is quiet.** No dot, no words in the mail window. Settings says "Could not
    check", why in one phrase, and when it last worked. The next try is
    the next start's or the next day's, whichever comes first.
13. **Never a banner, a badge or a dialog.** Banners are for mail (ADR 0071) and the badge counts
    unread mail. Nothing appears at start between the person and their mail, and nothing takes
    focus.
14. **Where it lives.** The rules (compare, read the file, when the next check is due, which
    links pass) are pure functions in `packages/core`. Main makes the request with Electron's
    `net`, keeps the last answer, the switch and the version About was last seen with in a file under `userData`
    as it does for appearance (ADR 0134), and tells every window when the state changes (ADR
    0115). The backend and the database are not involved: this is about the app, not the mail.
15. **Tests.** Unit tests for rule 7 and rule 8. A window test with a stand-in for the file that
    shows the dot, that About takes it away, and the lines of Settings. The security run (`smoke:security`)
    gains a case: with the check off, and in a build that is not packaged, no request leaves for
    the site.

## Consequences

- A tester with a release build hears about the next alpha when they next start the app, or
  within a day if it stays open, in the window they already look at.
- The app makes a request to the project's site for the first time. `docs/security/standards.md`
  and the threat model gain a row for it; "what an outsider can check" (ADR 0125) can check it:
  one host, one path, no body.
- GitHub Pages sees that an address asked for the file, at each start of the app and once a day
  while it runs. It cannot tell which version,
  account or Mac. The project sees nothing: Pages gives its owner no request log.
- Whoever can change the site can make the app say that a version is out. They cannot make it
  install anything, and the links they can send it to are the project's own release pages. The
  worst case is a false "New version" that leads to a real release page.
- The four alphas already out never learn. Testers must be told once, by hand, to take the first
  build that has this.
- The site offers a stable release over any newer pre-release (ADR 0129). Once there is a stable
  one, a person on a beta of the next version is told only when that version is stable. Good
  enough until there are betas after 1.0; a second line in the file would mend it.
- A Mac that sleeps for a week with the app open checks when it wakes and the day has passed,
  not on a calendar.
- The file names one build, for Apple Silicon. When there is an Intel, Windows or Linux build
  (stage 3), the file and rule 8 must name one for each.
- The file has no way to say "this one fixes a security problem". A release that must not be
  missed is still said in the notes and the advisory; a flag in the file is a later step.
- The mail window says it without words: a dot, with the words in the tooltip, for a screen
  reader, in the menu and in Settings. That is the price of adding nothing to the foot row. A
  tester may not notice a dot on a gear; the menu item and the release notes are the other ways.
  If testers stay on old versions, the next step is a segment in the foot row with the words.
- The gear does two things: with the dot it opens About, without it the last section. The dot is
  what tells them apart.
- No new dependency.
