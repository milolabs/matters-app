# 0107. Matters runs on macOS as its own app

- Status: Accepted
- Date: 2026-11-10
- Amended by: [0108](0108-banners-act-and-leave.md) (Settings says what is known: the stock runtime
  shows no banners, the bundle needs the person's yes)

## Context

ADR 0071 shows banners through Electron's `Notification`, and none ever appeared on macOS. The app
only ran as `electron apps/desktop`: the stock `Electron.app`, bundle id `com.github.Electron`,
signed ad hoc. macOS keys notification permission to a bundle id; System Settings › Notifications
listed neither Electron nor Matters.

What we found on Electron 45.2.1 and macOS 26:

- Electron 45 shows notifications through `UNUserNotificationCenter`. Its notification presenter
  asks for permission once, when it is created, and never reads the answer. The docs say only
  that the app must be code-signed for notifications to appear.
- Matters started from the bundle by exec, not through LaunchServices, got `show` for a banner
  and never reached the notification server: `show` means the request was accepted, not that
  anyone saw it. Started with `open`, the system asked "Matters would like to send
  notifications" about two seconds after launch, before the first banner, and the next banner was
  shown.
- Electron 45 has no call that reads the authorization, and no event for "not allowed": `failed`
  fires only when adding the request returns an error.
- `app.isPackaged` is true only when the main executable is not named `Electron`. A packaged app
  drops the dev switches (`MATTERS_USER_DATA`, `MATTERS_OLD_USER_DATA`, the smoke and trace
  hooks; ADR 0105, rule 4).
- The name, the default userData folder and the Keychain item follow `productName` in the
  `package.json` Electron loads (ADR 0105), not the bundle id or the executable's name.

## Decision

1. **`bun run bundle:macos`** builds the app and then `dist/Matters.app` (git-ignored) with
   `tools/bundle-macos.ts`. No packaging dependency: the script copies the Electron runtime the repo
   pins and edits it with the system's `ditto`, `plutil` and `codesign`.
2. **Its identity.** Bundle id `app.getmatters.Matters`, name and display name `Matters`, the icon
   from `apps/desktop/build/icons/icon.icns`. The helpers become `Matters Helper.app`,
   `Matters Helper (GPU|Renderer|Plugin).app`, with ids `app.getmatters.Matters.helper[.GPU|…]`.
3. **Self-contained.** `Contents/Resources/app` holds `out/`, the icons, a `package.json` with
   the repo's `name`, `productName`, `version`, `type` and `main`, and a `node_modules` of the
   packages the built main, backend and preload import (what electron-vite leaves external) with
   their dependencies, two versions side by side where two are needed. Nothing points back into
   the repo; a bundle built yesterday runs yesterday's code.
4. **The main executable keeps the name `Electron`.** So `app.isPackaged` stays false and the
   bundle runs the code paths `electron apps/desktop` runs today: name `Matters`, userData
   `~/Library/Application Support/Matters`, database `matters.db`, Keychain item
   `Matters Safe Storage`, and the identity move finds its marker `done` and does nothing. The dev
   switches keep working, so the bundle can be tried on data of its own.
5. **Signed inside out with the local code-signing identity** (`MATTERS_SIGN_IDENTITY`, else the
   only one in the keychain; never printed or stored): every loose Mach-O (libraries, the crash
   handler, native modules), then the frameworks, the helpers and the app, with the hardened
   runtime and the two entitlements V8 needs (`allow-jit`, `allow-unsigned-executable-memory`).
   No timestamp. `codesign --verify --deep --strict` must pass before the bundle replaces the old
   one.
6. **On Windows and Linux nothing changes.** `app.setAppUserModelId` is not set: Windows shows a
   toast only for an id that a Start Menu shortcut carries, and there is no installer to make one.
   Setting it now could stop the toasts a dev run shows today. It comes with the installer.

## What it is not

Not a distribution build. No Developer ID, no notarization, no auto-update, no installer, no
`isPackaged`. It runs on the Mac that built it. Each is a later decision, and the first of them
must turn rule 4 around: a packaged app has no dev switches.

## Consequences

- The person opens `dist/Matters.app` from Finder (or `open`), not by its executable: only then
  does the system register it and ask about notifications. The answer is theirs, and it belongs
  to the bundle id, not to one build.
- **One Keychain prompt.** `Matters Safe Storage` was created by the ad-hoc Electron binary. The
  bundle is signed differently, so the first time it reads a saved password macOS asks whether
  Matters may use that item. *Always Allow* adds the bundle to the item's list; rebuilds keep the
  same signing identity and should not ask again. *Deny* leaves the passwords unreadable in the
  bundle and changes nothing for the dev build.
- A run on data of its own (`MATTERS_USER_DATA` and `MATTERS_DB_PATH`) with no saved passwords
  never reads the Keychain: the credential store calls `safeStorage` only for a password it has
  or is given. Pass `--use-mock-keychain` to be sure.
- The bundle and a dev run use one folder and one database. Since
  [0110](0110-one-instance-per-data-folder.md) the second of them to start quits and brings the
  first forward.
- A banner shows nothing while permission is denied and the app cannot tell. Saying so in Settings
  needs a native read of the authorization, which Electron 45 lacks; that is its own decision.
- 350 MB per build, most of it Electron. Rebuilding replaces the bundle in one rename.
