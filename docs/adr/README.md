# Architecture decision records

One file per decision, numbered, never rewritten once accepted. To change a
decision, add a new ADR that supersedes the old one and set the old one's status
to `Superseded by NNNN`.

Format: copy [`template.md`](template.md).

| # | Decision | Status |
|---|---|---|
| [0001](0001-record-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-license-agpl-and-cla.md) | AGPL-3.0 with a contributor license agreement | Accepted |
| [0003](0003-monorepo-bun-workspaces.md) | Monorepo with Bun workspaces | Accepted |
| [0004](0004-hexagonal-architecture.md) | Hexagonal architecture (ports and adapters) | Accepted |
| [0005](0005-electron-runtime.md) | Electron runtime, backend in a utility process | Accepted |
| [0006](0006-sqlite-storage-and-search.md) | SQLite (`node:sqlite`) for storage and FTS5 search | Accepted |
| [0007](0007-local-first-sync.md) | Local-first: change log, outbox, provider cursors | Accepted |
| [0008](0008-imap-smtp-first.md) | IMAP and SMTP as the first provider | Accepted |
| [0009](0009-message-storage-and-compression.md) | Raw messages as zstd blocks per thread | Accepted |
| [0010](0010-ui-solidjs.md) | SolidJS 1.9 for the UI | Accepted |
| [0011](0011-markdown-compose.md) | Compose in Markdown, send as HTML | Accepted |
| [0012](0012-performance-budgets.md) | Performance budgets enforced in CI | Accepted |
| [0013](0013-dependency-license-policy.md) | Dependency license policy | Accepted |
| [0014](0014-labels-threads-identity.md) | Labels, threads and message identity | Accepted |
| [0015](0015-build-only-data-licenses.md) | Attribution-licensed data packages (amends 0013) | Accepted |
| [0016](0016-message-identity-and-locations.md) | Message identity and locations (refines 0014) | Accepted |
| [0017](0017-allow-mit-0.md) | Allow MIT-0 (amends 0013) | Accepted |
| [0018](0018-accounts-credentials-background-sync.md) | Accounts, credentials and background sync | Accepted |
| [0019](0019-backend-router-and-sync-worker.md) | Backend: a read router and a sync worker thread | Accepted |
| [0020](0020-sending-outbox-and-compose.md) | Sending: drafts, approval, outbox and compose | Accepted |
| [0021](0021-allow-psf-2.md) | Allow PSF-2.0 with a note (amends 0013) | Accepted |
| [0022](0022-thread-context-ignores-own-messages.md) | Thread context ignores the user's own messages (refines 0020) | Accepted |
| [0023](0023-lookup-by-mx-and-probing.md) | Lookup through MX and probing, outgoing test before saving (amends 0018) | Accepted |
| [0024](0024-rendering-mail-html.md) | Rendering mail: letters, and pages in a sandbox | Accepted |
| [0025](0025-query-language-and-plans.md) | A query language, and query plans chosen per query (amends 0006) | Accepted |
| [0026](0026-query-bar.md) | One query bar, with the text as the only state | Accepted |
| [0027](0027-saved-views.md) | Saved views are named query text | Accepted |
| [0028](0028-people-suggestions.md) | People in suggestions, checked against the index | Accepted |
| [0029](0029-query-bar-full-width.md) | The query bar is a full-width strip, and writes fields instead of quick filters (amends 0026, 0027, 0028) | Accepted |
| [0030](0030-recent-searches-per-view.md) | Recent searches are remembered per view | Accepted |
| [0031](0031-result-count-on-active-tab.md) | The result count is on the active tab (amends 0027, 0029) | Superseded by 0093 |
| [0032](0032-account-mark-in-the-list.md) | Rows mark their account when a view mixes accounts | Accepted |
| [0033](0033-account-dot-and-chosen-colors.md) | The account is a dot and a name, in a colour the user can choose (amends 0032) | Accepted |
| [0034](0034-account-dot-without-name.md) | A row marks its account with the dot alone (amends 0033) | Accepted |
| [0035](0035-account-color-picker.md) | The account's colour is chosen with a colour picker (amends 0033) | Accepted |
| [0036](0036-settings-window.md) | Settings live in a window of their own | Accepted |
| [0037](0037-remembering-image-choices.md) | Remembering image choices: one list of rules (amends 0024) | Accepted |
| [0038](0038-resizable-list-and-window-placement.md) | The list's width is the reader's choice, and the window opens where it was left | Accepted |
| [0039](0039-marking-read.md) | Marking read and unread (refines 0007) | Accepted |
| [0040](0040-attachments-and-carriers.md) | Attachments go in the message; large files can later leave through carriers (refines 0020) | Accepted |
| [0041](0041-attachments-never-block.md) | Attaching and sending files never block anything (refines 0012, 0019, 0020) | Accepted |
| [0042](0042-reply-to.md) | Replies go where the sender asked (refines 0020) | Accepted |
| [0043](0043-received-attachments.md) | Received attachments: listed at once, downloaded on demand, never run by accident (refines 0007) | Accepted |
| [0044](0044-moving-mail.md) | Moving mail: archive, delete, spam and folders, with a way back (refines 0007, 0016, 0029) | Accepted |
| [0045](0045-forwarding.md) | Forwarding carries the message and its files | Accepted |
| [0046](0046-startup.md) | Startup: reads before the worker, a frame before the data (refines 0005, 0012, 0019) | Accepted |
| [0047](0047-hostile-mail-corpus.md) | A corpus of hostile mail, run through the real code | Accepted |
| [0048](0048-trusting-authentication-results.md) | Whose Authentication-Results to trust, and who a message says it is from (refines 0037) | Accepted |
| [0049](0049-fluid-reading-column.md) | The reading column fills the pane (amends 0038) | Accepted |
| [0050](0050-choosing-the-sender.md) | Choosing the sender of a message | Accepted |
| [0051](0051-agents-on-the-users-own-plans.md) | Agents run on the user's own plans | Accepted |
| [0052](0052-things-that-matter.md) | Things that matter | Superseded by 0117 |
| [0053](0053-reading-that-shows-itself.md) | Reading that shows itself (amends 0052) | Superseded by 0117 |
| [0054](0054-closing-in-the-persons-own-words.md) | Closing a thing in the person's own words, and what the agent remembers (amends 0052) | Superseded by 0117 |
| [0055](0055-every-thing-shows.md) | Every thing that matters shows (amends 0052) | Superseded by 0117 |
| [0056](0056-acting-on-rows-of-the-list.md) | Acting on rows of the list: search in Matters, row menus, several rows | Superseded by 0117 |
| [0057](0057-what-the-mail-itself-says-about-a-thing.md) | What the mail itself says about a thing (amends 0052) | Superseded by 0117 |
| [0058](0058-what-ignoring-it-costs.md) | What ignoring it costs, what is for now, and learning from no (amends 0052) | Superseded by 0117 |
| [0059](0059-bundles-and-a-map-of-what-depends-on-what.md) | Bundles, and a map of what depends on what | Superseded by 0117 |
| [0060](0060-the-mail-itself-shows-in-matters.md) | The mail itself shows in Matters | Superseded by 0117 |
| [0061](0061-a-series-is-one-row.md) | A series is one row (amends 0059) | Superseded by 0117 |
| [0062](0062-the-list-holds-still-after-you-act.md) | The list holds still after you act | Superseded by 0117 |
| [0063](0063-the-agent-in-ordinary-threads.md) | The agent in ordinary threads (amends 0052) | Accepted |
| [0064](0064-one-prompt-for-a-thread-or-all-mail.md) | One prompt for a thread or all mail (amends 0051, 0063) | Accepted |
| [0065](0065-a-closing-covers-only-its-own-ask.md) | A closing covers only its own ask (amends 0061) | Superseded by 0117 |
| [0066](0066-what-you-would-regret-not-seeing.md) | What you would regret not seeing (amends 0052, 0057, 0058) | Superseded by 0117 |
| [0067](0067-what-the-owners-labels-taught.md) | What the owner's labels taught (amends 0066) | Superseded by 0117 |
| [0068](0068-who-writes-what-you-refuse-what-comes-from-an-office.md) | Who writes, what you refuse, what comes from an office (amends 0066, 0067) | Superseded by 0117 |
| [0069](0069-the-agent-has-its-own-column.md) | The agent has its own column (amends 0052, 0064) | Accepted |
| [0070](0070-the-window-opens-with-the-mail.md) | The window opens with the mail (amends 0046) | Accepted |
| [0071](0071-notifications.md) | Notifications: banners, notices inside, and the badge | Accepted |
| [0072](0072-the-name-matters.md) | The name is Matters | Accepted |
| [0073](0073-the-thread-on-one-grid.md) | The thread on one grid | Accepted |
| [0074](0074-finding-files-by-name.md) | Finding files by name | Accepted |
| [0075](0075-promises-under-the-message.md) | Promises under the message | Superseded by 0117 |
| [0076](0076-live-search-under-cmd-k.md) | Live search under ⌘K | Accepted |
| [0077](0077-showing-what-was-found.md) | Showing what was found | Accepted |
| [0078](0078-the-sender-leads.md) | The sender leads | Accepted |
| [0079](0079-a-sender-that-failed-and-matters-leads-with-the-sender.md) | A sender that failed shows it, and Matters leads with the sender too | Accepted |
| [0080](0080-the-agent-follows-the-trail.md) | The agent follows the trail (amends 0064) | Accepted |
| [0081](0081-finding-what-the-question-means.md) | Finding what the question means (amends 0080) | Accepted |
| [0082](0082-what-the-plan-asks-for-is-not-put-behind.md) | What the plan asks for is not put behind (amends 0080) | Accepted |
| [0083](0083-the-agent-searches-in-a-loop.md) | The agent searches in a loop (amends 0051, 0080) | Accepted |
| [0084](0084-the-answer-reads-every-thread-found.md) | The answer reads every thread found (amends 0080, 0083) | Accepted |
| [0085](0085-mail-in-the-dark-theme.md) | Mail in the dark theme: the sender's theme first (amends 0024) | Accepted |
| [0086](0086-talks-across-all-mail.md) | Talks across all mail (amends 0064, 0069) | Accepted |
| [0087](0087-the-agent-reads-attached-files.md) | The agent reads attached files (amends 0083) | Accepted |
| [0088](0088-a-senders-html-is-kept-together.md) | A sender's HTML is kept together (amends 0009, 0024) | Accepted |
| [0089](0089-storage-in-settings.md) | Storage in Settings: what the app keeps and holds | Accepted |
| [0090](0090-a-file-with-no-text-goes-to-the-answer-whole.md) | A file with no text goes to the answer whole (amends 0087) | Accepted |
| [0091](0091-a-reply-joins-the-thread-it-answers.md) | A reply joins the thread it answers (amends 0014) | Accepted |
| [0092](0092-one-copy-of-a-sent-message.md) | One copy of a sent message (amends 0020) | Accepted |
| [0093](0093-a-tab-number-is-always-unread.md) | A tab's number is always its unread mail (supersedes 0031, amends 0027) | Accepted |
| [0094](0094-a-message-opens-as-sent.md) | A message opens as sent (amends 0024, 0077) | Accepted |
| [0095](0095-the-reader-says-what-a-button-does.md) | The reader says what a button does (amends 0066, 0068) | Accepted |
| [0096](0096-a-reply-is-written-not-filled-in.md) | A reply is written, not filled in | Accepted |
| [0097](0097-the-reader-has-one-frame.md) | The reader has one frame | Accepted |
| [0098](0098-the-agent-helps-write-a-reply.md) | The agent helps write a reply | Accepted |
| [0099](0099-each-letter-names-its-sender.md) | Each letter names its sender (amends 0075, 0078) | Accepted |
| [0100](0100-a-reply-is-written-under-its-thread.md) | A reply is written under its thread | Accepted |
| [0101](0101-a-new-message-reads-like-a-letter.md) | A new message reads like a letter (amends 0041, 0100) | Accepted |
| [0102](0102-the-agent-proposes-the-person-presses.md) | The agent proposes, the person presses (amends 0083) | Accepted |
| [0103](0103-the-window-waits-for-the-page-not-a-clock.md) | The window waits for the page, not for a clock (amends 0046, 0070) | Accepted |
| [0104](0104-a-reply-without-ids-joins-the-thread-it-answers.md) | A reply without ids joins the thread it answers (amends 0091) | Accepted |
| [0105](0105-the-app-identity-moves-to-matters.md) | The app identity moves to Matters (completes 0072) | Accepted |
| [0106](0106-notifications-that-matter.md) | Notifications that matter: by arrival, across a restart, and from the agent (amends 0071) | Accepted |
| [0107](0107-matters-runs-on-macos-as-its-own-app.md) | Matters runs on macOS as its own app | Accepted |
| [0108](0108-banners-act-and-leave.md) | Banners act and leave; the system's part is said (amends 0106, 0107) | Accepted |
| [0109](0109-the-badge-counts-what-is-in-matters.md) | The badge counts what is in Matters (amends 0071) | Superseded by 0117 |
| [0110](0110-one-instance-per-data-folder.md) | One running copy per data folder (amends 0105, 0107) | Accepted |
| [0111](0111-bulk-mail-says-so-at-its-foot.md) | Bulk mail says so at its foot (amends 0052, 0066) | Accepted |
| [0112](0112-what-you-answered-waits-for-its-reading.md) | What you answered waits for its reading (amends 0052, 0109) | Accepted |
| [0113](0113-a-refused-password-is-mended-in-place.md) | A refused password is mended in place (amends 0023) | Accepted |
| [0114](0114-a-refused-sign-in-says-why.md) | A refused sign-in says why (amends 0023) | Accepted |
| [0115](0115-every-window-hears-a-changed-status.md) | Every window hears a changed status (amends 0052, 0112) | Accepted |
| [0116](0116-a-prompt-is-a-filter.md) | A prompt is a filter (builds on 0025, 0027, 0051, 0064) | Accepted |
| [0117](0117-matters-is-a-view-with-a-prompt.md) | Matters is a view with a prompt (supersedes 0052, 0075; amends 0063, 0071, 0078, 0079, 0116) | Accepted |
| [0118](0118-effort-is-set-per-kind-of-work.md) | Effort is set per kind of work (amends 0051) | Accepted |
| [0119](0119-a-runtime-on-this-machine.md) | A runtime on this machine (amends 0051, 0118) | Accepted |
| [0120](0120-codex-is-a-runtime.md) | Codex is a runtime (amends 0051, 0090) | Accepted |
| [0121](0121-a-runtime-for-each-kind-of-work.md) | A runtime for each kind of work (amends 0051, 0119) | Accepted |
| [0122](0122-security-policy-and-checks-on-every-change.md) | A security policy, and checks on every change (builds on 0012, 0013, 0047) | Accepted |
| [0123](0123-releases.md) | Releases (turns around 0107 rule 4 for a release build; builds on 0105, 0122) | Accepted |
| [0124](0124-the-release-workflow-sets-the-version.md) | The release workflow sets the version (amends 0123) | Accepted |
| [0125](0125-what-an-outsider-can-check.md) | What an outsider can check (builds on 0047, 0122; amends 0123) | Accepted |
| [0126](0126-changes-reach-main-by-pull-request.md) | Changes reach main by pull request (amends 0124, 0125) | Accepted |
| [0127](0127-the-site-lives-in-the-repository.md) | The site lives in the repository (builds on 0123, 0126) | Accepted |
| [0128](0128-tests-are-not-scanned.md) | Tests are not scanned by CodeQL (amends 0122) | Accepted |
| [0129](0129-the-site-offers-pre-releases.md) | The site offers pre-releases (amends 0127, 0123) | Accepted |
| [0130](0130-the-app-is-tested-in-a-window.md) | The app is tested in a window, on every change (builds on 0018, 0122; amends 0128) | Accepted |
| [0131](0131-the-person-sets-the-background-limit.md) | The person sets the background limit, and the log leaves Settings (amends 0051, 0054, 0121) | Accepted |
