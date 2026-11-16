// Thin main process (ADR 0005): window, backend supervision, port handoff. It never
// sees data messages; the renderer talks to the backend over a direct MessagePort.
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  constants,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, uptime } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BrowserOAuth } from "@matters/adapter-oauth";
import {
  EncryptedFileCredentialStore,
  parseCredential,
  RenewingCredentialStore,
  type RpcPort,
  serveCredentials,
} from "@matters/adapter-secrets";
import {
  type AppearanceInfo,
  type AppearanceMode,
  type BrowserSignInAnswer,
  type BrowserSignInOffer,
  MAX_THEMES,
  type PrintAction,
  type PrintAnswer,
  type ReceivedAnswer,
  THEMES_FULL,
  type ThemeAddAnswer,
} from "@matters/contracts";
import {
  type AgentKeyVaultPort,
  type CredentialPort,
  checkDue,
  isPermissionPageId,
  isReleaseLink,
  msUntilCheck,
  parseMailto,
  permissionPageUrl,
  RELEASE_DOWNLOAD_PAGE,
  RELEASE_FILE_URL,
} from "@matters/core";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  Notification,
  nativeTheme,
  net,
  powerMonitor,
  screen,
  session,
  shell,
  utilityProcess,
} from "electron";
import attachmentWorkerPath from "../backend/attachmentWorker.ts?modulePath";
import backupWorkerPath from "../backend/backupWorker.ts?modulePath";
import {
  BOOT_STAGE_MESSAGE,
  BOOT_START,
  type BootReport,
  readBootReport,
} from "../backend/bootStage.ts";
import backendPath from "../backend/main.ts?modulePath";
import readWorkerPath from "../backend/readWorker.ts?modulePath";
import syncWorkerPath from "../backend/syncWorker.ts?modulePath";
import { mark } from "../backend/trace.ts";
import {
  CHANNEL_APPEARANCE,
  CHANNEL_APPEARANCE_CHANGED,
  CHANNEL_APPEARANCE_COLORS,
} from "../preload/appearanceBridge.ts";
import { CHANNEL_DROP, CHANNEL_PASTE, CHANNEL_PICK } from "../preload/fileBridge.ts";
import {
  CHANNEL_DEFAULT_MAIL,
  CHANNEL_MAILTO_DONE,
  CHANNEL_MAILTO_TAKE,
  CHANNEL_MAILTO_WAITING,
} from "../preload/mailtoBridge.ts";
import { CHANNEL_NOTICE_SYSTEM } from "../preload/noticeBridge.ts";
import { CHANNEL_RECEIVED } from "../preload/receivedBridge.ts";
import {
  CHANNEL_RELEASE,
  CHANNEL_RELEASE_CHANGED,
  CHANNEL_SETTINGS_SECTION,
} from "../preload/releaseBridge.ts";
import { CHANNEL_SIGN_IN } from "../preload/signInBridge.ts";
import { CHANNEL_STORAGE } from "../preload/storageBridge.ts";
import {
  APPEARANCE_FILE,
  type AppearanceRevisions,
  appearanceInfo,
  builtInTheme,
  type ChosenTheme,
  DEFAULT_APPEARANCE,
  differsFromDefault,
  FIRST_REVISIONS,
  isAppearanceMode,
  isResetAppearanceChord,
  isThemeId,
  type LoadedTheme,
  nextRevisions,
  ownThemeFile,
  ownThemeId,
  ownThemeRoom,
  ownThemes,
  parseAppearance,
  RESET_APPEARANCE_ACCELERATOR,
  resolveChosenTheme,
  type StoredAppearance,
  serializeAppearance,
  THEMES_FOLDER,
  type ThemeRead,
  themeAddDecision,
  themeListing,
  themeSourceFor,
  windowColors,
  windowGround,
  withOwnTheme,
} from "./appearance.ts";
import { BackendLink } from "./backendLink.ts";
import { BackupJobs } from "./backupJobs.ts";
import {
  clientIds,
  isLoopbackUrl,
  parseSignInAsk,
  SignInService,
  testBrowser,
} from "./browserSignIn.ts";
import { BUILT_IN_THEMES } from "./builtInThemes.ts";
import { EmlSaves } from "./emlSaves.ts";
import { CHANNEL_EML, CHANNEL_EML_ASK, CHANNEL_EML_PROGRESS } from "./emlShapes.ts";
import {
  type EraseOrder,
  type EraseOrderRead,
  readEraseOrder,
  startFor,
  writeEraseOrder,
} from "./erase.ts";
import { enterEraseMode, enterUnreadableMode } from "./eraseMode.ts";
import { eraseOverview } from "./eraseOverview.ts";
import { type GrantMessage, GrantMint } from "./grants.ts";
import {
  isIdentityHelper,
  probeOldApp,
  readOldCredentials,
  runIdentityHelper,
} from "./identityHelper.ts";
import {
  CREDENTIALS,
  DATABASE,
  type DataOutcome,
  identityPlan,
  moveIdentityCredentials,
  moveIdentityData,
  nodeFs,
  OLD_APP_NAME,
} from "./identityMigration.ts";
import { Installer, placeOfThisCopy, systemInstallDeps } from "./installer.ts";
import {
  bringForward,
  type Claim,
  claimDatabase,
  nodeOwnerFs,
  nodeProcessFacts,
  type Owner,
  ownerPath,
  ownerVerdict,
} from "./instanceLock.ts";
import { linkForSystem } from "./mailto.ts";
import {
  createLinkQueue,
  defaultMailInfo,
  type LinkSource,
  linkSummary,
  type MailtoClient,
  mailtoArguments,
  makeDefaultMail,
  standInMailtoClient,
} from "./mailtoLinks.ts";
import { NOTIFICATION_SETTINGS_URL, noticeSystem } from "./noticeSystem.ts";
import { NoticeShower, noticeFrom, type PauseState, pauseMenu, pauseTarget } from "./notices.ts";
import {
  createPrinter,
  PDF_MARGIN_IN,
  type PrintReady,
  type PrintWindow,
  paperFor,
} from "./printer.ts";
import {
  CHANNEL_PRINT,
  CHANNEL_PRINT_ASK,
  CHANNEL_PRINT_AVAILABLE,
  CHANNEL_PRINT_DOCUMENT,
  CHANNEL_PRINT_READY,
  isPrintAction,
  readPrintDocument,
} from "./printShapes.ts";
import { createQuarantine } from "./quarantine.ts";
import { ReceivedFiles } from "./received.ts";
import {
  ABOUT_LINKS,
  afterCheck,
  etagToSend,
  markSeen,
  newerRelease,
  parseStoredRelease,
  RELEASE_STATE_FILE,
  type ReleaseOutcome,
  releaseInfo,
  releaseLinkFor,
  releaseMenuLabel,
  type StoredRelease,
  serializeStoredRelease,
} from "./release.ts";
import { requestReleaseFile } from "./releaseRequest.ts";
import { isReleaseOpen } from "./releaseShapes.ts";
import {
  readHeldFile,
  removeSetAside,
  type SwapOutcome,
  swapPendingRestore,
  writeHeldFile,
} from "./restore.ts";
import { holdRestoredAccounts } from "./restoreHold.ts";
import { revealDeadline } from "./revealPolicy.ts";
import { SafeStorageEncryptor } from "./safeStorage.ts";
import {
  runSmoke,
  runSyncSmoke,
  SMOKE_PREFIX,
  SMOKE_SIGNAL_PREFIX,
  type SmokeReport,
  type SyncSmokeReport,
} from "./smoke.ts";
import { SMOKE_EARLIER_KEY_SERVICE, SMOKE_KEY_SERVICE, smokeKeychain } from "./smokeKeychain.ts";
import { folderUsage, type MainStorage, processUsage } from "./storageUsage.ts";
import { parseTheme, serializeTheme } from "./themes.ts";
import {
  DEFAULT_PLACEMENT,
  restorePlacement,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
  type WindowPlacement,
} from "./windowPlacement.ts";

// The identity move's helper (ADR 0105) is this executable started for one job: it must take the
// old name before anything else reads the app's identity, and then do nothing else.
const identityHelper = isIdentityHelper(process.argv);
if (identityHelper) runIdentityHelper(process.argv);

// Approximate process start on the wall clock, to compare with the renderer's timestamps.
const processStartEpochMs = Date.now() - process.uptime() * 1000;
// Test hooks never apply to a packaged app: smoke mode swaps in a mock keychain.
const devBuild = !app.isPackaged;
const smoke = devBuild && process.env.MATTERS_SMOKE === "1";
// Launch trace (tools/bench-launch.ts): dev builds only; a packaged app drops the variable, so
// neither main nor the backend ever writes a trace there.
if (!devBuild) delete process.env.MATTERS_TRACE_FILE;
const tracing = devBuild && !!process.env.MATTERS_TRACE_FILE;
const trace = (name: string, epochMs?: number) => {
  if (tracing) mark(name, epochMs);
};
trace("process-created", process.getCreationTime() ?? undefined);
trace("main-start");
// The driver runs a cold start (empty database, seeding) and then a warm one.
const smokePhase = process.env.MATTERS_SMOKE_PHASE === "cold" ? "cold" : "warm";
// "sync": measure while the test account syncs (tools/smoke-desktop-sync.ts).
// "security": the hostile-mail corpus in a real window (tools/smoke-security.ts, ADR 0047).
const smokeMode =
  process.env.MATTERS_SMOKE_MODE === "sync"
    ? "sync"
    : process.env.MATTERS_SMOKE_MODE === "security"
      ? "security"
      : "seeded";
// Dev builds only, like every smoke hook: the corpus run watches what leaves the window.
const securityRun = smoke && smokeMode === "security";
const SECURITY_EVENT_PREFIX = "MATTERS_SECURITY_EVENT ";
const securityEvent = (kind: string, data: Record<string, unknown>) =>
  process.stdout.write(`${SECURITY_EVENT_PREFIX}${JSON.stringify({ kind, ...data })}\n`);

// Test runs keep their data (database, credentials) in a directory of their own, and macOS
// must not ask the login keychain for permission in the middle of a run.
if (!identityHelper && devBuild && process.env.MATTERS_USER_DATA) {
  app.setPath("userData", process.env.MATTERS_USER_DATA);
}
if (!identityHelper && (smoke || tracing) && process.platform === "darwin")
  app.commandLine.appendSwitch("use-mock-keychain");

/** The mail window once it exists, for a second start to bring forward (ADR 0110). */
let mailWindow: { readonly win: BrowserWindow; revealed(): boolean } | null = null;

/**
 * One running copy per data folder (ADR 0110), after userData is final and before anything reads or
 * writes it (the identity move included). A second start on the same folder hands its turn to the
 * first, which comes forward, and leaves without opening anything.
 */
function claimDataFolder(): void {
  if (!app.requestSingleInstanceLock()) {
    console.error(
      `matters-instance: another copy of Matters runs on ${app.getPath("userData")}; it was brought forward`,
    );
    app.exit(0);
    process.exit(0);
  }
  app.on("second-instance", (_event, argv) => {
    // A link the second start was given goes to this copy (ADR 0143, rule 5); nothing else of its
    // arguments is read.
    for (const href of mailtoArguments(argv)) receiveLink(href, "outside");
    bringForward(mailWindow?.win ?? null, mailWindow?.revealed() ?? false, () => {
      if (process.platform !== "darwin") return;
      app.show();
      app.focus({ steal: true });
    });
  });
}
// On Windows Chromium's lock is a file held open in the folder, which the identity move could not
// carry into its copy; there the lock follows the move.
if (!identityHelper && process.platform !== "win32") claimDataFolder();

/**
 * Erase everything (ADR 0138, rule 3): an order in the data folder makes this start erase, before
 * the identity move, the database's claim, the Keychain and the backend, none of which runs. A
 * normal start pays for one read that finds nothing. When that read fails otherwise, whether there
 * is an order is not known: this start neither erases nor opens anything, and says so.
 */
const orderRead: EraseOrderRead = identityHelper
  ? { kind: "none" }
  : readEraseOrder(app.getPath("userData"));
/** Not a normal start: an erase, or a data folder that could not be read. */
const erasing = orderRead.kind !== "none";

/**
 * `mailto:` links (ADR 0143): each is read by core's `parseMailto` the moment it arrives and waits
 * here, at most five, until the mail window has shown its mail and can open a composer. A link
 * that starts the app comes before ready, so the handler is registered now (rule 5). An erase or
 * an unreadable data folder opens no message: the links are dropped.
 */
const links = createLinkQueue();
/** The mail window's side, once it exists: it is told that a link waits. */
let linkArrived: (source: LinkSource) => void = () => {};
function receiveLink(href: string, source: LinkSource): void {
  if (identityHelper || erasing) return;
  // A corpus run records what each link's draft would hold, as it records what would have left
  // (ADR 0047), whether or not there is room for it: a smoke run never takes one off the queue.
  if (securityRun) {
    const read = parseMailto(href);
    if (read) securityEvent("compose", { source, ...read });
  }
  const draft = links.offer(href);
  if (draft === null) return;
  // A smoke run says that a link arrived, never what it holds.
  if (smoke) console.error(linkSummary(draft, source));
  linkArrived(source);
}
if (!identityHelper && !erasing) {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    receiveLink(url, "outside");
  });
  // Windows and Linux hand a link that starts the app as an argument.
  for (const href of mailtoArguments(process.argv.slice(1))) receiveLink(href, "outside");
}
startFor(orderRead, {
  none: () => {},
  unreadable: (code) =>
    enterUnreadableMode({
      dataDir: app.getPath("userData"),
      code,
      smoke,
      background: () => background(),
      titleBar: () => titleBar,
      lockDown: (win) => lockDown(win),
    }),
  order: (eraseOrder) => enterErase(eraseOrder),
});

function enterErase(eraseOrder: EraseOrder): void {
  if (process.platform === "win32") claimDataFolder();
  const dataDir = app.getPath("userData");
  // Read now: the erase points userData at a throwaway folder before it claims anything.
  const erasedDatabase = databasePath();
  // Only the person's own run touches the Keychain: a dev, test or smoke run never does, whatever
  // its folders (a dev build shares the real key's name).
  const ownRun = app.isPackaged && !process.env.MATTERS_USER_DATA && !process.env.MATTERS_DB_PATH;
  enterEraseMode({
    order: eraseOrder,
    dataDir,
    databasePath: erasedDatabase,
    earlierDir: earlierCopyDir(),
    keychain: ownRun
      ? { current: `${app.getName()} Safe Storage`, earlier: `${OLD_APP_NAME} Safe Storage` }
      : smoke
        ? { current: SMOKE_KEY_SERVICE, earlier: SMOKE_EARLIER_KEY_SERVICE }
        : { current: null, earlier: null },
    smoke,
    ...(smoke ? { keychainPort: smokeKeychain(process.env.MATTERS_ERASE_KEYCHAIN_LOG) } : {}),
    ...(devBuild && process.env.MATTERS_ERASE_TEMP_DIR
      ? { tempDir: process.env.MATTERS_ERASE_TEMP_DIR }
      : {}),
    // A database another run owns (a shared `MATTERS_DB_PATH`) is left, never deleted under it.
    claimDatabase: () => databaseClaim(erasedDatabase, dataDir),
    background: () => background(),
    titleBar: () => titleBar,
    lockDown: (win) => lockDown(win),
  });
}

/**
 * The earlier identity's folder (ADR 0105) as this run sees it: the real one only for a run on the
 * real folders, a dev build's own with `MATTERS_OLD_USER_DATA`, none for a test run of its own.
 */
function earlierCopyDir(): string | null {
  const plan = identityPlan({
    devBuild,
    env: process.env,
    appData: app.getPath("appData"),
    userData: app.getPath("userData"),
  });
  return plan?.oldDir ?? null;
}

/**
 * Says why the app cannot start and leaves. A smoke run has nobody to read a dialog: the line on
 * stderr is what its driver checks.
 */
function stopForIdentity(problem: string): never {
  console.error(`matters-identity: ${problem}`);
  if (!smoke) {
    dialog.showErrorBox(
      "Matters could not move your data",
      `${problem}\n\nNothing under the old name was changed or removed. Matters will quit now and ` +
        "try again the next time it starts.",
    );
  }
  app.exit(1);
  process.exit(1);
}

/**
 * The data half of the identity move (ADR 0105), before ready: Chromium has not created anything in
 * the new folder yet. Runs only when this run uses the real folders (or a dev build's own pair).
 */
function moveData(): DataOutcome | null {
  const plan = identityPlan({
    devBuild,
    env: process.env,
    appData: app.getPath("appData"),
    userData: app.getPath("userData"),
  });
  if (!plan) return null;
  const outcome = moveIdentityData({
    ...plan,
    fs: nodeFs,
    probe: probeOldApp,
    now: () => new Date(),
  });
  switch (outcome.kind) {
    case "refused":
      return stopForIdentity(
        outcome.reason === "running"
          ? "Another copy of Matters still has your mailbox open. Quit it, then start Matters again."
          : `Your mailbox was written to while it was being copied (${outcome.detail}). Quit every ` +
              "other copy of Matters, then start Matters again.",
      );
    case "failed":
      return stopForIdentity(
        `Your mailbox could not be copied to its new folder: ${outcome.message}`,
      );
    case "kept-existing":
      // Said once (the marker remembers), and the app starts with the data it found.
      console.error(
        `matters-identity: ${plan.newDir} already had data; ${plan.oldDir} was left as it is`,
      );
      if (!smoke) {
        dialog.showErrorBox(
          "Matters found two mailboxes",
          `Matters already has data in ${plan.newDir}, so the mailbox in ${plan.oldDir} was not ` +
            "copied over it. Neither folder was changed; Matters starts with the first one.",
        );
      }
      return outcome;
    case "copied":
      if (outcome.setAside) {
        console.error(
          `matters-identity: ${plan.newDir} held no mailbox, only what an earlier start left; ` +
            `it was set aside as ${outcome.setAside}`,
        );
      }
      console.error(
        `matters-identity: copied ${outcome.files} files (${outcome.bytes} bytes) to ${plan.newDir}`,
      );
      return outcome;
    default:
      return outcome;
  }
}
const identity = identityHelper || erasing ? null : moveData();
if (!identityHelper && !erasing && process.platform === "win32") claimDataFolder();

/**
 * The database's own claim (ADR 0110): `MATTERS_DB_PATH` can point two data folders at one
 * database, which Electron's lock does not see. After the identity move, which must find nothing
 * of this run's in the folder it fills; before the Keychain and the backend.
 */
function claimDatabaseFile(): void {
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const claim = databaseClaim(path, app.getPath("userData"));
  if (claim.kind === "claimed") {
    app.on("will-quit", () => claim.release());
    // `app.exit` (smoke runs, a refused start) skips will-quit.
    process.on("exit", () => claim.release());
    return;
  }
  const where = claim.owner ? ` (${claim.why}, data folder ${claim.owner.userData})` : "";
  console.error(`matters-instance: ${path} is in use by another copy of Matters${where}`);
  if (!smoke) {
    dialog.showErrorBox(
      "Matters is already open",
      `Another copy of Matters has this mailbox open${where}:\n${path}\n\nQuit it, then start ` +
        `Matters again. If no other copy is running anywhere, remove ${ownerPath(path)} and start ` +
        "again.",
    );
  }
  app.exit(1);
  process.exit(1);
}
if (!identityHelper && !erasing) claimDatabaseFile();

/**
 * A restore from a backup (ADR 0145, rule 9) is a swap at this start: inside the single-instance
 * lock and the database's claim, before anything opens the database. With none waiting it costs
 * one `stat`. A swap that fails leaves the database in use as it was, and says so on stderr; the
 * restore still waits, and Settings › Storage shows it.
 */
const restoreSwap: SwapOutcome =
  identityHelper || erasing ? { kind: "none" } : swapPendingRestore(databasePath());
if (restoreSwap.kind === "swapped") {
  // The cache of received files is keyed by message keys, which the restored database gives out
  // on its own: a copy could stand for another message now. It is a cache (ADR 0043, rule 8), so
  // it goes whole, and a file is fetched again when asked for.
  rmSync(join(app.getPath("userData"), "received"), { recursive: true, force: true });
  console.error(
    `matters-restore: the backup is in place; the database before it is in restore/set-aside/${restoreSwap.setAside}`,
  );
} else if (restoreSwap.kind === "failed") {
  console.error(`matters-restore: the restore was not put in place: ${restoreSwap.message}`);
}

/**
 * Takes the database's owner file for this process, or says who has it (ADR 0110). Shared by a
 * normal start and by the erase, which claims the database before it deletes its files.
 */
function databaseClaim(path: string, userData: string): Claim {
  const facts = () =>
    nodeProcessFacts({
      pid: process.pid,
      host: hostname(),
      nowMs: Date.now(),
      uptimeS: uptime(),
      platform: process.platform,
    });
  const me: Owner = {
    pid: process.pid,
    startedAtMs: process.getCreationTime() ?? processStartEpochMs,
    host: hostname(),
    token: randomUUID(),
    userData,
  };
  return claimDatabase({
    path: ownerPath(path),
    me,
    fs: nodeOwnerFs,
    judge: (owner, ageMs) => ownerVerdict(owner, ageMs, facts()),
    nowMs: () => Date.now(),
  });
}

const credentialsPending =
  (identity?.kind === "copied" || identity?.kind === "settled") &&
  identity.state === "credentials-pending";

/** The toolbar is the title bar: the traffic lights sit in its 52 px, centred. */
const titleBar =
  process.platform === "darwin"
    ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 20, y: 19 } }
    : {};

/**
 * A window's colour before its page paints (ADR 0134, rule 9). `shouldUseDarkColors` follows
 * `themeSource`, which the appearance sets before the first window is made.
 */
const background = () => windowGround(chosen.theme, nativeTheme.shouldUseDarkColors);

// The app icon (docs/brand). macOS takes it from the bundle; Windows and Linux take it per window.
const iconDir = join(app.getAppPath(), "build/icons");
const windowIcon = process.platform === "darwin" ? {} : { icon: join(iconDir, "png/512x512.png") };

/** Nothing leaves the app, from any of its windows: no popups, no navigation, no permissions. */
function lockDown(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  // A message's frame may load our own pages, and nothing a message links to (ADR 0024).
  win.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !isOwnPage(event.url)) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, done) => done(false));
}

const placementPath = () => join(app.getPath("userData"), "window.json");

/** A smoke run measures the default window, whatever an earlier run left. */
function readPlacement(): WindowPlacement {
  if (smoke) return DEFAULT_PLACEMENT;
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(placementPath(), "utf8"));
  } catch {
    return DEFAULT_PLACEMENT;
  }
  const areas = screen.getAllDisplays().map((display) => display.workArea);
  return restorePlacement(saved, areas);
}

function savePlacement(win: BrowserWindow): void {
  if (smoke) return;
  const placement = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
  try {
    writeFileSync(placementPath(), JSON.stringify(placement));
  } catch (error) {
    // Not worth stopping the quit for: the window opens at the default size next time.
    console.error("could not save the window's place", error);
  }
}

/** Dev-only knobs of the launch benchmark (tools/bench-launch.ts); a packaged app never traces. */
const neverReady = tracing && process.env.MATTERS_TRACE_NEVER_READY === "1";
/** The benchmark's theme wins over the person's and is never written to their file. */
const traceTheme: AppearanceMode | null =
  tracing &&
  (process.env.MATTERS_TRACE_THEME === "dark" || process.env.MATTERS_TRACE_THEME === "light")
    ? process.env.MATTERS_TRACE_THEME
    : null;

const appearancePath = () => join(app.getPath("userData"), APPEARANCE_FILE);
const themesPath = () => join(app.getPath("userData"), THEMES_FOLDER);

/** One file of `themes/`, by a name `appearance.ts` made (never one from a page). */
function readOwnTheme(file: string): ThemeRead {
  try {
    return { kind: "text", text: readFileSync(join(themesPath(), file), "utf8") };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable" };
  }
}

/**
 * The appearance in force (ADR 0134, rule 8), read once userData is final and the identity move is
 * done, before any window is made, so the first one already has its colours. Only the chosen theme
 * is read now; the list waits until Appearance asks. A smoke run measures the default, whatever an
 * earlier run left, as it does for the window's place; so does the benchmark, in its own mode.
 */
function readStoredAppearance(): StoredAppearance {
  if (traceTheme) return { mode: traceTheme, theme: null };
  if (smoke) return parseAppearance(null);
  let text: string | null = null;
  try {
    text = readFileSync(appearancePath(), "utf8");
  } catch {
    // No file yet, or one that cannot be read: the default (ADR 0134, rule 11).
  }
  return parseAppearance(text);
}
let stored: StoredAppearance = identityHelper ? parseAppearance(null) : readStoredAppearance();
let chosen: ChosenTheme = identityHelper
  ? { theme: null, fallback: null }
  : resolveChosenTheme(stored.theme, BUILT_IN_THEMES, readOwnTheme);
if (chosen.fallback) console.error(`appearance: ${chosen.fallback}`);
if (!identityHelper) nativeTheme.themeSource = themeSourceFor(stored.mode, chosen.theme);
/** The person's own themes, read when Appearance first asks and kept in step after. */
let ownList: LoadedTheme[] | null = null;

function themeList(): LoadedTheme[] {
  if (ownList === null) {
    let files: string[] = [];
    try {
      files = readdirSync(themesPath());
    } catch {
      // No folder yet: no own themes.
    }
    ownList = ownThemes(files, readOwnTheme, ownThemeRoom(BUILT_IN_THEMES.length));
  }
  const builtIns = BUILT_IN_THEMES.map((t) => builtInTheme(BUILT_IN_THEMES, t.id)).filter(
    (t): t is LoadedTheme => t !== null,
  );
  return [...builtIns, ...ownList];
}

/** Every change counts, and every way back is marked (ADR 0134, rule 11; see `nextRevisions`). */
let revisions: AppearanceRevisions = FIRST_REVISIONS;

const currentAppearance = (): AppearanceInfo =>
  appearanceInfo(stored, chosen.theme, chosen.fallback, themeList(), revisions);

// A new window asks for the colours as its preload starts (ADR 0134, rule 9): main answers from
// memory, at once. Every window of the app may ask; it gets only checked values.
if (!identityHelper) {
  ipcMain.on(CHANNEL_APPEARANCE_COLORS, (event) => {
    event.returnValue = windowColors(chosen.theme);
  });
}

/**
 * Applies what the person chose, keeps it, and tells every open window, so a Settings window and
 * the mail window agree whichever of them (or the menu, or the shortcut) changed it. Every call
 * moves the revision on; `reset` marks a way back, even one that changes nothing (ADR 0134,
 * rule 11). Under the benchmark's theme nothing changes.
 */
function applyAppearance(
  next: StoredAppearance,
  theme: ChosenTheme,
  reset = false,
): AppearanceInfo {
  if (traceTheme) return currentAppearance();
  const themeChanged =
    next.theme !== stored.theme || (theme.theme?.id ?? null) !== (chosen.theme?.id ?? null);
  revisions = nextRevisions(revisions, { reset, themeChanged });
  stored = next;
  chosen = theme;
  nativeTheme.themeSource = themeSourceFor(stored.mode, chosen.theme);
  if (!smoke) {
    try {
      writeFileSync(appearancePath(), serializeAppearance(stored));
    } catch (error) {
      // It holds for this run; the next start opens in what was written before.
      console.error("could not save the appearance", error);
    }
  }
  const info = currentAppearance();
  const colors = windowColors(chosen.theme);
  const ground = background();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    // A theme can change the ground without the mode changing, so `updated` may not come.
    win.setBackgroundColor(ground);
    win.webContents.send(CHANNEL_APPEARANCE_CHANGED, { appearance: info, colors });
  }
  appearanceChanged();
  return info;
}

const setMode = (mode: AppearanceMode) => applyAppearance({ ...stored, mode }, chosen);

/** The way back (ADR 0134, rule 11): mode System and no theme; the themes stay in the list. */
const resetAppearance = () =>
  applyAppearance(DEFAULT_APPEARANCE, { theme: null, fallback: null }, true);

/** A theme of the list, or the default (null). An id main does not know changes nothing. */
function chooseTheme(id: string | null): AppearanceInfo | null {
  if (id === null)
    return applyAppearance({ ...stored, theme: null }, { theme: null, fallback: null });
  const theme = themeList().find((t) => t.id === id);
  if (!theme) return null;
  return applyAppearance({ ...stored, theme: id }, { theme, fallback: null });
}

/**
 * A theme handed in as text (ADR 0134, rule 12): the agent's answer to the person's description,
 * which the page passes on as something from outside. It passes the check or is refused with
 * every reason; one that passes is written to `themes/` under an id main makes and listed. `since`
 * is the revision the making started at: main alone decides from it whether a way back stopped the
 * theme, or a later choice keeps it off (rule 11, `themeAddDecision`). Decided here, before the
 * file is written and in the same synchronous call, so no message between can undo it.
 */
function addTheme(text: string, since: unknown): ThemeAddAnswer | null {
  const decision = themeAddDecision(since, revisions);
  // Gone back to the default meanwhile: nothing is saved, and no second turn is asked for.
  if (decision === "stopped") return { ok: false, stopped: true };
  // A full list keeps no more than it can show (`MAX_THEMES`), whatever the text, so no second
  // turn is asked for. Read before the file is written, so the scan cannot already hold the new
  // theme when it is added below.
  if (themeList().length >= MAX_THEMES) return { ok: false, full: THEMES_FULL };
  const result = parseTheme(text);
  if (!result.ok) return { ok: false, problems: result.problems };
  const id = ownThemeId(randomBytes(6).toString("hex"));
  const file = ownThemeFile(id);
  if (file === null) return null;
  try {
    mkdirSync(themesPath(), { recursive: true, mode: 0o700 });
    writeFileSync(join(themesPath(), file), serializeTheme(result.theme), { mode: 0o600 });
  } catch (error) {
    console.error("could not save the theme", error);
    return null;
  }
  const loaded: LoadedTheme = { id, source: "own", theme: result.theme };
  ownList = withOwnTheme(ownList ?? [], loaded);
  // The person chose another theme while this one was made: it is listed, and theirs stays on.
  const appearance =
    decision === "on"
      ? applyAppearance({ ...stored, theme: id }, { theme: loaded, fallback: null })
      : applyAppearance(stored, chosen);
  return { ok: true, theme: themeListing(loaded), appearance };
}

/**
 * The text of a theme of the list, as its file holds it, for the agent to change it (ADR 0134,
 * rule 14): only when the person asks, and only a theme main already checked. Null for an id main
 * does not know.
 */
function themeText(id: string): { text: string } | null {
  const theme = themeList().find((t) => t.id === id);
  return theme ? { text: serializeTheme(theme.theme) } : null;
}

/** Removes an own theme; built-ins cannot be. Removing the one on returns to the default. */
function removeTheme(id: string): AppearanceInfo | null {
  const file = ownThemeFile(id);
  if (file === null) return null;
  try {
    unlinkSync(join(themesPath(), file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("could not remove the theme", error);
      return null;
    }
  }
  // Read again when next asked: a folder that held more than the list carries shows the next one.
  ownList = null;
  if (stored.theme !== id) {
    // Nothing on screen changes; the list does, in every window that shows it.
    return applyAppearance(stored, chosen);
  }
  return applyAppearance({ ...stored, theme: null }, { theme: null, fallback: null });
}

/** The menu follows the appearance (its Reset Appearance is off at the default). */
let appearanceChanged = () => {};

/**
 * Where the check for a newer version reads (ADR 0137, rules 2 and 5). A packaged app reads the
 * site's file; a build that is not packaged never asks, unless a window test of it points the
 * check at a stand-in on this machine (`MATTERS_TEST_RELEASE_URL`, loopback only), which then
 * also turns it on. A packaged app reads no such variable.
 */
const releaseUrl: string | null = app.isPackaged
  ? RELEASE_FILE_URL
  : (() => {
      const standIn = process.env.MATTERS_TEST_RELEASE_URL;
      return standIn !== undefined && isLoopbackUrl(standIn) ? standIn : null;
    })();
const releasePath = () => join(app.getPath("userData"), RELEASE_STATE_FILE);

/**
 * Where an install downloads from and which copy it replaces (ADR 0140, rules 2 and 3). A packaged
 * app uses the release downloads and the bundle it runs from. A build that is not packaged never
 * installs, unless a window test points it at a stand-in on this machine
 * (`MATTERS_TEST_INSTALL_URL`, loopback only) and names the folder of a stand-in Matters.app
 * (`MATTERS_TEST_INSTALL_DIR`). A packaged app reads neither.
 */
const installTest: { readonly base: string; readonly folder: string } | null = app.isPackaged
  ? null
  : (() => {
      const base = process.env.MATTERS_TEST_INSTALL_URL;
      const folder = process.env.MATTERS_TEST_INSTALL_DIR;
      if (base === undefined || folder === undefined || !isLoopbackUrl(base)) return null;
      return { base: base.endsWith("/") ? base : `${base}/`, folder };
    })();

/**
 * Whether Matters is the default mail app, and asking macOS to make it so (ADR 0143, rule 2). Only
 * a packaged app asks: a build that is not packaged would register the Electron runtime. A window
 * test of such a build may use a stand-in that only remembers the press
 * (`MATTERS_TEST_DEFAULT_MAIL=1`); a packaged app reads no such variable.
 */
const mailtoClient: MailtoClient | null = app.isPackaged
  ? {
      isDefault: () => app.isDefaultProtocolClient("mailto"),
      makeDefault: () => app.setAsDefaultProtocolClient("mailto"),
    }
  : process.env.MATTERS_TEST_DEFAULT_MAIL === "1"
    ? standInMailtoClient()
    : null;

/** What `newer-version.json` holds; read when first needed, after userData is final. */
function readStoredRelease(): StoredRelease {
  let text: string | null = null;
  try {
    text = readFileSync(releasePath(), "utf8");
  } catch {
    // No file yet: the check is on, and nothing is known (ADR 0137, rule 6).
  }
  return parseStoredRelease(text);
}

/**
 * The request's own session, in memory only: no cookie jar, no cache and nothing of the mail's
 * pages is shared with it (ADR 0137, rule 3). A corpus run watches it as it watches the windows.
 */
let releaseSessionMade: Electron.Session | null = null;
function releaseSession(): Electron.Session {
  if (releaseSessionMade) return releaseSessionMade;
  releaseSessionMade = session.fromPartition("matters-release", { cache: false });
  if (securityRun) {
    releaseSessionMade.webRequest.onBeforeRequest((details, done) => {
      securityEvent("request", { url: details.url, type: "release" });
      done({});
    });
  }
  return releaseSessionMade;
}

/** One GET of the file (ADR 0137, rules 3, 4 and 8): no cookie, no credentials, no redirect. */
function fetchRelease(url: string, etag: string | null): Promise<ReleaseOutcome> {
  return requestReleaseFile(
    {
      open: (target) =>
        net.request({
          method: "GET",
          url: target,
          session: releaseSession(),
          credentials: "omit",
          useSessionCookies: false,
          redirect: "error",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        }),
    },
    url,
    etag,
  );
}

/**
 * The window's side of startup (ADR 0103): the backend's stage, which the preload puts on the page
 * for the loading screen, and when to show the window if the page does not say it is ready.
 */
interface BootWindow {
  readonly win: BrowserWindow;
  /** Whether the window has been shown once (smoke runs never show it). */
  revealed(): boolean;
  /** The backend reached a stage; only a name and two integers (ADR 0005). */
  stage(report: BootReport): void;
}

function createWindow(): BootWindow {
  const placement = readPlacement();
  const win = new BrowserWindow({
    ...placement.bounds,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    // It opens with the mail in it: see `reveal`. A smoke run never shows it.
    show: false,
    ...titleBar,
    ...windowIcon,
    backgroundColor: background(),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // A hidden smoke window must keep painting for the frame timings to mean anything.
      backgroundThrottling: !smoke,
      additionalArguments: smoke ? ["--matters-smoke"] : tracing ? ["--matters-trace"] : [],
    },
  });
  if (tracing) {
    win.once("ready-to-show", () => trace("window-ready-to-show"));
    win.webContents.once("did-start-loading", () => trace("page-load-start"));
    win.webContents.once("dom-ready", () => trace("page-dom-ready"));
    win.webContents.once("did-finish-load", () => trace("page-load-finished"));
  }

  // A smoke run has no one watching the console: surface what the page complains about.
  if (smoke) {
    win.webContents.on("console-message", (event) => {
      if (event.level === "error" || event.level === "warning") {
        console.error(
          `renderer ${event.level}: ${event.message} (${event.sourceId}:${event.lineNumber})`,
        );
      }
    });
  }

  // What the preload is told: the backend's stage, and whether the loading screen is on screen.
  const createdAtMs = performance.now();
  let report: BootReport = BOOT_START;
  let scriptStartedAtMs: number | null = null;
  let loaderShown = false;
  let revealed = false;
  // A normal start has nothing to tell: the loader is not seen and its words change only for an
  // update. Once told, the page is kept up to date.
  let told = false;
  const tell = () => {
    if (win.isDestroyed()) return;
    if (!told && !loaderShown && report.stage !== "updating") return;
    told = true;
    win.webContents.send("matters:boot", { ...report, shown: loaderShown });
  };
  // Maximizing also shows a window, so it waits for the same moment. `loader` is a show at the
  // deadline: the page is told before the window appears, so the mark's motion starts with it.
  const reveal = (loader: boolean) => {
    if (revealed || smoke || win.isDestroyed()) return;
    revealed = true;
    clearTimeout(deadline);
    if (loader) {
      loaderShown = true;
      tell();
      trace("boot-shown");
      captureLoader(win);
    }
    if (placement.maximized) win.maximize();
    win.show();
    trace("window-shown");
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (revealed) return;
    clearTimeout(deadline);
    const at = revealDeadline({ createdAtMs, scriptStartedAtMs, stage: report.stage });
    deadline = setTimeout(() => reveal(true), Math.max(0, at - performance.now()));
  };
  arm();
  const onFirstScreen = (event: Electron.IpcMainEvent) => {
    if (event.sender !== win.webContents || neverReady) return;
    reveal(false);
  };
  // The page's first module ran: it is about to finish, so the deadline may wait for it a little.
  const onScriptStart = (event: Electron.IpcMainEvent) => {
    if (event.sender !== win.webContents || scriptStartedAtMs !== null) return;
    scriptStartedAtMs = performance.now();
    trace("script-start-received");
    arm();
  };
  // A page (a new one after a reload too) asks for the stage once its preload runs.
  const onHello = (event: Electron.IpcMainEvent) => {
    if (event.sender !== win.webContents) return;
    loaderShown = loaderShown || win.isVisible();
    tell();
  };
  ipcMain.on("matters:first-screen", onFirstScreen);
  ipcMain.on("matters:script-start", onScriptStart);
  ipcMain.on("matters:boot-hello", onHello);
  win.once("closed", () => {
    clearTimeout(deadline);
    ipcMain.removeListener("matters:first-screen", onFirstScreen);
    ipcMain.removeListener("matters:script-start", onScriptStart);
    ipcMain.removeListener("matters:boot-hello", onHello);
  });
  win.on("close", () => savePlacement(win));

  lockDown(win);
  if (securityRun) watchSecurity(win);

  const page = process.env.ELECTRON_RENDERER_URL;
  const smokeValue = smokeMode === "sync" ? "sync" : smokeMode === "security" ? "security" : "1";
  const query: Record<string, string> | undefined = smoke
    ? { smoke: smokeValue }
    : tracing
      ? { trace: "1", ...(neverReady ? { neverReady: "1" } : {}) }
      : undefined;
  if (page && !app.isPackaged) {
    const search = query ? `?${new URLSearchParams(query)}` : "";
    void win.loadURL(`${page}${search}`);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/index.html"), { query });
  }
  return {
    win,
    revealed: () => revealed,
    stage(next) {
      if (next.stage === report.stage && next.step === report.step && next.total === report.total) {
        return;
      }
      report = next;
      trace(`boot-stage-${next.stage}`);
      tell();
      arm();
    },
  };
}

/**
 * Benchmark only (dev builds, MATTERS_TRACE_SHOT): a picture of the loading screen some time after it
 * was shown, for checking its look without filming the screen (ADR 0070's consequence).
 */
function captureLoader(win: BrowserWindow): void {
  const file = tracing ? process.env.MATTERS_TRACE_SHOT : undefined;
  if (!file) return;
  setTimeout(
    () => {
      if (win.isDestroyed()) return;
      void win.webContents.capturePage().then((image) => {
        writeFileSync(file, image.toPNG());
        trace("boot-shot");
      });
    },
    Number(process.env.MATTERS_TRACE_SHOT_MS ?? 1500),
  );
}

/**
 * The settings window (ADR 0036): shown once painted, so it never opens blank. `section` is the
 * one it opens on, when main asks for one (the menu's newer-version item opens About, ADR 0137).
 */
function createSettingsWindow(section?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 600,
    minHeight: 400,
    show: false,
    fullscreenable: false,
    ...titleBar,
    ...windowIcon,
    backgroundColor: background(),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  lockDown(win);
  win.once("ready-to-show", () => win.show());
  const page = process.env.ELECTRON_RENDERER_URL;
  if (page && !app.isPackaged) {
    const url = new URL("settings.html", page);
    if (section !== undefined) url.searchParams.set("section", section);
    void win.loadURL(url.href);
  } else {
    void win.loadFile(
      join(import.meta.dirname, "../renderer/settings.html"),
      section === undefined ? undefined : { query: { section } },
    );
  }
  return win;
}

/**
 * Back Up… and Restore from a Backup… (ADR 0145): the dialogs are main's, the work a process of
 * its own per job (backupWorker.ts), ended on Stop. A window test of a dev build names the file
 * to write (`MATTERS_TEST_BACKUP_PATH`) and the file to restore (`MATTERS_TEST_RESTORE_PATH`)
 * without a dialog; a packaged app reads neither.
 */
function createBackupJobs(owner: () => BrowserWindow | null): BackupJobs {
  const backupPath = devBuild ? process.env.MATTERS_TEST_BACKUP_PATH : undefined;
  const restorePath = devBuild ? process.env.MATTERS_TEST_RESTORE_PATH : undefined;
  const parent = () => {
    const w = owner();
    return w && !w.isDestroyed() ? w : undefined;
  };
  return new BackupJobs({
    databasePath: databasePath(),
    async chooseSavePath(defaultName) {
      if (backupPath) return backupPath;
      const options = {
        defaultPath: join(app.getPath("documents"), defaultName),
        filters: [{ name: "Matters backup", extensions: ["db"] }],
      };
      const w = parent();
      const chosen = w
        ? await dialog.showSaveDialog(w, options)
        : await dialog.showSaveDialog(options);
      return chosen.canceled ? undefined : chosen.filePath;
    },
    async chooseBackupFile() {
      if (restorePath) return restorePath;
      const options = {
        defaultPath: app.getPath("documents"),
        properties: ["openFile" as const],
        filters: [{ name: "Matters backup", extensions: ["db"] }],
      };
      const w = parent();
      const chosen = w
        ? await dialog.showOpenDialog(w, options)
        : await dialog.showOpenDialog(options);
      return chosen.canceled ? undefined : chosen.filePaths[0];
    },
    work(job) {
      const child = utilityProcess.fork(backupWorkerPath, [], {
        serviceName: "matters-backup",
        stdio: "inherit",
      });
      const answer = new Promise<unknown>((resolve) => {
        child.once("message", (message: unknown) => {
          resolve(message);
          child.kill();
        });
        child.once("exit", () => resolve({ ok: false, message: "the backup process ended" }));
      });
      child.postMessage(job);
      return { answer, kill: () => child.kill() };
    },
    fs: {
      async createPrivate(path) {
        await (await open(path, "wx", 0o600)).close();
      },
      async sync(path) {
        const handle = await open(path, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
      rename: (from, to) => rename(from, to),
      remove: (path) => rm(path, { force: true }),
      async copyIn(from, to) {
        await copyFile(from, to, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
        await chmod(to, 0o600);
      },
      size: (path) =>
        stat(path).then(
          (s) => (s.isFile() ? s.size : 0),
          () => 0,
        ),
      mkdir: async (path) => {
        await mkdir(path, { recursive: true, mode: 0o700 });
      },
      chmodPrivate: (path) => chmod(path, 0o600),
    },
    now: () => Date.now(),
    dayOf: (ms) => localDay(ms),
    log: (message, error) =>
      console.error(`matters-main: ${message}`, error instanceof Error ? error.message : ""),
  });
}

/** `YYYY-MM-DD` of a time on this Mac's calendar, for a file's name (ADR 0145, rule 4). */
function localDay(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The print view of a thread (ADR 0144, rule 4): a hidden window of our own page, made only when
 * asked and destroyed after. The mail window's walls: its session (so its frames are the reader's
 * frames, under the same policy), `lockDown` (no popup, no navigation, no permission), a sandboxed
 * preload that exposes nothing. A corpus run watches where it tries to go, as for the mail window;
 * its requests are watched already, on the session they share.
 */
function openPrintWindow(): PrintWindow {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    skipTaskbar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/print.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // Hidden, it must still lay out and paint: the page waits for frames before it says ready.
      backgroundThrottling: false,
    },
  });
  lockDown(win);
  if (securityRun) watchNavigation(win);
  const printLog = devBuild ? process.env.MATTERS_TEST_PRINT_LOG : undefined;
  return {
    render(doc, widthPx, timeoutMs) {
      return new Promise<PrintReady>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          ipcMain.removeListener(CHANNEL_PRINT_READY, onReady);
        };
        const timer = setTimeout(() => {
          done();
          reject(new Error("the print view did not get ready"));
        }, timeoutMs);
        const onReady = (event: Electron.IpcMainEvent, ready: unknown) => {
          if (win.isDestroyed() || event.sender !== win.webContents) return;
          done();
          const r = (ready ?? {}) as { ok?: unknown; scriptRan?: unknown };
          resolve({ ok: r.ok === true, scriptRan: r.scriptRan === true });
        };
        ipcMain.on(CHANNEL_PRINT_READY, onReady);
        win.webContents.once("did-finish-load", () => {
          if (!win.isDestroyed()) win.webContents.send(CHANNEL_PRINT_DOCUMENT, { doc, widthPx });
        });
        win.webContents.once("did-fail-load", () => {
          done();
          reject(new Error("the print view did not load"));
        });
        const page = process.env.ELECTRON_RENDERER_URL;
        const loading =
          page && !app.isPackaged
            ? win.loadURL(new URL("print.html", page).href)
            : win.loadFile(join(import.meta.dirname, "../renderer/print.html"));
        loading.catch(() => {});
      });
    },
    print() {
      // Window tests only (dev builds): the system's dialog cannot be driven, so the call is written
      // down instead of made, with the window it was for.
      if (printLog) {
        appendFileSync(printLog, `${JSON.stringify({ window: win.id })}\n`);
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve, reject) => {
        win.webContents.print({ silent: false, printBackground: true }, (success, reason) => {
          if (success) resolve(true);
          else if (/cancel/i.test(reason)) resolve(false);
          else reject(new Error(reason));
        });
      });
    },
    async printToPDF(paper) {
      const margin = PDF_MARGIN_IN;
      const pdf = await win.webContents.printToPDF({
        pageSize: paper,
        printBackground: true,
        margins: { top: margin, bottom: margin, left: margin, right: margin },
        displayHeaderFooter: false,
        preferCSSPageSize: false,
        generateTaggedPDF: false,
        generateDocumentOutline: false,
      });
      return new Uint8Array(pdf);
    },
    destroy() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

/** Corpus runs only (ADR 0047): every navigation a window attempts, and whether it was stopped. */
function watchNavigation(win: BrowserWindow): void {
  const navigated = (event: { url: string; isMainFrame?: boolean; defaultPrevented: boolean }) =>
    securityEvent("navigate", {
      url: event.url,
      mainFrame: event.isMainFrame !== false,
      prevented: event.defaultPrevented,
    });
  win.webContents.on("will-navigate", navigated);
  // The main frame is reported by will-navigate, with the verdict of lockDown's handler.
  win.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) navigated(event);
  });
}

/**
 * Corpus runs only (ADR 0047): reports every navigation the window attempts and whether it was
 * stopped, and every network request that leaves it. Added after `lockDown`, so a listener sees the
 * verdict of the real handlers. It changes nothing: requests continue, navigations keep their fate.
 */
function watchSecurity(win: BrowserWindow): void {
  watchNavigation(win);
  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "ftp://*/*"] },
    (details, done) => {
      securityEvent("request", { url: details.url, type: details.resourceType });
      done({});
    },
  );
}

function isOwnPage(url: string): boolean {
  const dev = process.env.ELECTRON_RENDERER_URL;
  return url.startsWith("file:") || url.startsWith("about:") || (!!dev && url.startsWith(dev));
}

/** The backend never imports electron, so main decides where the database lives. */
function databasePath(): string {
  return process.env.MATTERS_DB_PATH ?? join(app.getPath("userData"), DATABASE);
}

/** The passwords of all accounts: encrypted by the OS keychain, in a file under userData. */
function createCredentialStore() {
  return new EncryptedFileCredentialStore(
    join(app.getPath("userData"), CREDENTIALS),
    new SafeStorageEncryptor(),
  );
}

/**
 * Browser sign-in (ADR 0133): the person's own browser through `shell.openExternal` (rule 1), the
 * client id from the source or the environment (rule 4), or none when a dev build's window test
 * says so (`MATTERS_TEST_NO_CLIENT_ID`). Window tests of a dev build may point it
 * at a stand-in authorization server on this machine (`MATTERS_TEST_OAUTH_AUTHORITY`, which the
 * adapter refuses unless it is loopback, rule 13) and play the browser against it
 * (`MATTERS_TEST_OAUTH_BROWSER`, see `testBrowser`). A packaged app reads neither.
 */
function createBrowserOAuth(): BrowserOAuth {
  const authority = devBuild ? process.env.MATTERS_TEST_OAUTH_AUTHORITY : undefined;
  const standIn =
    authority === undefined ? null : testBrowser(process.env.MATTERS_TEST_OAUTH_BROWSER, authority);
  try {
    return new BrowserOAuth({
      clientIds: clientIds(process.env, { devBuild }),
      openBrowser: standIn ?? ((url) => shell.openExternal(url)),
      ...(authority === undefined ? {} : { authority }),
    });
  } catch (error) {
    // Only a test's variable can get here: say so and stop rather than sign in anywhere else.
    console.error(`matters-main: ${error instanceof Error ? error.message : "browser sign-in"}`);
    app.exit(1);
    process.exit(1);
  }
}

/**
 * The passwords half of the identity move (ADR 0105): decrypted under the old name by the helper,
 * encrypted again here under the new one. Until it succeeds the app does not start.
 */
async function moveCredentials(store: ReturnType<typeof createCredentialStore>): Promise<void> {
  const outcome = await moveIdentityCredentials({
    newDir: app.getPath("userData"),
    fs: nodeFs,
    readOld: (staged) => readOldCredentials(staged),
    replaceAll: (credentials) => store.replaceAll(credentials),
    readBack: (id) => store.get(id),
    parse: parseCredential,
    now: () => new Date(),
  });
  if (outcome.kind === "failed") {
    stopForIdentity(`Your saved passwords could not be moved: ${outcome.message}`);
  }
  const dropped = outcome.dropped > 0 ? `; ${outcome.dropped} could not be decrypted` : "";
  console.error(`matters-identity: moved ${outcome.moved} saved passwords${dropped}`);
}

/**
 * The smoke driver can pre-configure one account through the environment, with the password
 * going into the credential store like any other (never to the backend, a file or a log).
 * Honoured in smoke runs of an unpackaged app only.
 */
async function prepareTestAccount(
  store: ReturnType<typeof createCredentialStore>,
): Promise<string | undefined> {
  const raw = process.env.MATTERS_TEST_ACCOUNT;
  if (!raw || !smoke || app.isPackaged) return undefined;
  const account = JSON.parse(raw) as { id: string; username: string };
  const password = process.env.MATTERS_TEST_PASSWORD ?? "";
  await store.set(account.id, { kind: "password", username: account.username, password });
  // The smoke run proves the vault round-trips here, in Electron, before anything else depends on it.
  const back = await store.get(account.id);
  if (back?.kind !== "password" || back.password !== password) {
    console.error("smoke: the credential did not round-trip through safeStorage");
    app.exit(1);
  }
  return raw;
}

function startBackend(
  store: CredentialPort,
  keys: AgentKeyVaultPort,
  testAccount: string | undefined,
): Electron.UtilityProcess {
  // What only main uses stays in main: the test password, and how browser sign-in is set up.
  const {
    MATTERS_TEST_PASSWORD: _secret,
    MATTERS_TEST_ACCOUNT: _hook,
    MATTERS_MICROSOFT_CLIENT_ID: _clientId,
    MATTERS_TEST_NO_CLIENT_ID: _noClientId,
    MATTERS_TEST_OAUTH_AUTHORITY: _authority,
    MATTERS_TEST_OAUTH_BROWSER: _browser,
    MATTERS_TEST_GRAPH_BASE: graphBase,
    MATTERS_TEST_ANTHROPIC_BASE: anthropicBase,
    MATTERS_TEST_DNS: testDns,
    MATTERS_TEST_RELEASE_URL: _releaseUrl,
    MATTERS_TEST_DEFAULT_MAIL: _defaultMail,
    MATTERS_TEST_SAVE_DIR: _saveDir,
    MATTERS_TEST_BACKUP_PATH: _backupPath,
    MATTERS_TEST_RESTORE_PATH: _restorePath,
    MATTERS_TEST_NO_RELAUNCH: _noRelaunch,
    MATTERS_TEST_PRINT_LOG: _printLog,
    ...inherited
  } = process.env;
  trace("backend-fork");
  const backend = utilityProcess.fork(backendPath, [], {
    serviceName: "matters-backend",
    stdio: "inherit",
    env: {
      ...inherited,
      NODE_COMPILE_CACHE: join(app.getPath("userData"), "compile-cache"),
      MATTERS_DB_PATH: databasePath(),
      // electron-vite resolves ?modulePath in the main bundle only, so main hands the worker's
      // path to the backend, which spawns it.
      MATTERS_SYNC_WORKER: syncWorkerPath,
      MATTERS_READ_WORKER: readWorkerPath,
      // Same for the attachment worker, which the sync worker starts (ADR 0041, rule 4), and for
      // the two directories it works in.
      MATTERS_ATTACHMENT_WORKER: attachmentWorkerPath,
      MATTERS_ATTACHMENTS_DIR: join(app.getPath("userData"), "attachments"),
      MATTERS_SPOOL_DIR: join(app.getPath("userData"), "spool"),
      // Downloaded copies of received files, a cache the worker trims (ADR 0043, rules 6 and 8).
      MATTERS_RECEIVED_DIR: receivedDir(),
      ...(testAccount ? { MATTERS_TEST_ACCOUNT: testAccount } : {}),
      // Window tests of a dev build only (ADR 0130): a stand-in Graph service on this machine
      // (ADR 0136, rule 12: loopback only, and the adapter checks again) and DNS answers from a
      // table. A packaged app passes neither.
      ...(devBuild && graphBase && isLoopbackUrl(graphBase)
        ? { MATTERS_TEST_GRAPH_BASE: graphBase }
        : {}),
      ...(devBuild && testDns ? { MATTERS_TEST_DNS: testDns } : {}),
      // A stand-in Anthropic API on this machine (ADR 0141, rule 11), for the same window tests.
      ...(devBuild && anthropicBase && isLoopbackUrl(anthropicBase)
        ? { MATTERS_TEST_ANTHROPIC_BASE: anthropicBase }
        : {}),
      // The backend writes to the trace only when main allowed it (a dev build, a benchmark).
      MATTERS_TRACE_FILE: tracing ? (process.env.MATTERS_TRACE_FILE ?? "") : "",
    },
  });
  if (tracing) backend.once("spawn", () => trace("backend-spawned"));

  // Credentials get their own channel, never the one the renderer holds.
  const secrets = new MessageChannelMain();
  backend.postMessage({ type: "credentials" }, [secrets.port1]);
  const rpc: RpcPort = {
    postMessage: (m) => secrets.port2.postMessage(m),
    onMessage: (handler) => secrets.port2.on("message", (e) => handler(e.data)),
  };
  // The API keys of runtimes are kept in the same vault (ADR 0141, rule 4), on the same channel.
  serveCredentials(rpc, store, keys);
  secrets.port2.start();

  return backend;
}

/**
 * Every page talks to the backend over a direct port of its own. A reload (View > Reload) throws
 * away the page and the port it held, and the new page waits for one before it renders anything,
 * so each load gets a fresh channel; the backend forgets the old one when it closes.
 */
function connectToBackend(win: BrowserWindow, backend: Electron.UtilityProcess): void {
  // dom-ready fires after the module script has registered its listener.
  win.webContents.on("dom-ready", () => {
    const { port1, port2 } = new MessageChannelMain();
    backend.postMessage({ type: "port" }, [port1]);
    win.webContents.postMessage("matters:port", null, [port2]);
  });
}

/** Where received files are kept once someone asked for them; main reads here, the worker writes. */
const receivedDir = () => join(app.getPath("userData"), "received");

/**
 * Opening, previewing and saving received files (ADR 0043, rules 10 to 14). The page names a file
 * by message key and part id; everything else, including the cache's path, stays in here.
 */
function createReceivedFiles(win: BrowserWindow, link: BackendLink): ReceivedFiles {
  const run = promisify(execFile);
  const quarantine = createQuarantine({
    platform: process.platform,
    run: async (file, args) => {
      await run(file, [...args]);
    },
    now: () => Date.now(),
  });
  return new ReceivedFiles({
    cacheDir: receivedDir(),
    fetch: (messageKey, partId) => link.fetchReceived(messageKey, partId),
    async list(dir) {
      try {
        return (await readdir(dir, { withFileTypes: true })).map((e) => ({
          name: e.name,
          isFile: e.isFile(),
          isSymlink: e.isSymbolicLink(),
        }));
      } catch {
        return [];
      }
    },
    async copy(from, to, overwrite) {
      // A clone where the volume allows it: a large file costs no second copy of its bytes.
      await copyFile(
        from,
        to,
        overwrite
          ? constants.COPYFILE_FICLONE
          : constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
      );
      // The cache is private to the app; a file the person saved is theirs.
      await chmod(to, 0o644);
    },
    quarantine,
    openPath: (path) => shell.openPath(path),
    ...(process.platform === "darwin" ? { preview: (path: string) => win.previewFile(path) } : {}),
    async chooseSavePath(defaultName) {
      const chosen = await dialog.showSaveDialog(win, {
        defaultPath: join(app.getPath("downloads"), defaultName),
      });
      return chosen.canceled ? undefined : chosen.filePath;
    },
    async chooseFolder() {
      const chosen = await dialog.showOpenDialog(win, {
        properties: ["openDirectory", "createDirectory"],
      });
      return chosen.canceled ? undefined : chosen.filePaths[0];
    },
    log: (message, error) =>
      console.error(`matters-main: ${message}`, error instanceof Error ? error.message : ""),
  });
}

/**
 * A line of main's own to the backend (ADR 0043, rule 10). The events on it are banners, the
 * badge and the pause (ADR 0071, 0108); what main asks on it is a received file, a banner's button,
 * the menu's pause and a refused test banner.
 */
function connectMainLine(
  win: BrowserWindow,
  backend: Electron.UtilityProcess,
  onPause: (state: PauseState) => void,
): BackendLink {
  const line = new MessageChannelMain();
  backend.postMessage({ type: "rpc" }, [line.port1]);
  let notices: NoticeShower | null = null;
  const link = new BackendLink(line.port2, (data) => {
    const event = noticeFrom(data);
    if (event) notices?.handle(event);
  });
  notices = createNoticeShower(win, link, onPause);
  return link;
}

/**
 * System banners and the badge on the icon (ADR 0071, rule 8). A click brings the mail window
 * forward and asks the page to open that message. The badge is the dock's text on macOS and a
 * count elsewhere where the system has one (a dot there is 1). A banner of one message has two
 * buttons where the system has them (macOS); they act through the router's own commands, as the
 * page's do, and leave the window where it is (ADR 0108).
 */
function createNoticeShower(
  win: BrowserWindow,
  link: BackendLink,
  onPause: (state: PauseState) => void,
): NoticeShower {
  const log = (what: string) => (ok: boolean) => {
    if (!ok) console.error(`matters-main: a banner's ${what} was not done`);
  };
  return new NoticeShower({
    focused: () => !win.isDestroyed() && win.isFocused(),
    banner(text, options) {
      if (!Notification.isSupported()) return null;
      const n = new Notification({
        title: text.title,
        ...(text.subtitle === undefined ? {} : { subtitle: text.subtitle }),
        body: text.body,
        silent: options.silent,
        ...(options.id === undefined ? {} : { id: options.id }),
        ...(process.platform === "darwin" && options.actions.length > 0
          ? { actions: options.actions.map((label) => ({ type: "button" as const, text: label })) }
          : {}),
      });
      return {
        on(event: string, listener: (arg: never) => void) {
          if (event === "action") {
            n.on("action", (details) => (listener as (i: number) => void)(details.actionIndex));
          } else if (event === "failed") {
            n.on("failed", (_e, error) => (listener as (r: string) => void)(error));
          } else if (event === "click") {
            n.on("click", () => (listener as () => void)());
          } else if (event === "close") {
            n.on("close", () => (listener as () => void)());
          }
          return n;
        },
        show: () => n.show(),
        close: () => n.close(),
      };
    },
    act(action, key, threadId) {
      if (action === "read") {
        void link.send({ type: "setSeen", keys: [key], seen: true }).then(log("mark as read"));
      } else {
        void link.send({ type: "moveThread", threadId, action: "archive" }).then(log("archive"));
      }
    },
    remove(ids) {
      if (process.platform === "darwin" && ids.length > 0) Notification.remove([...ids]);
    },
    failed(reason) {
      void link.send({ type: "bannerFailed", reason: reason.slice(0, 200) });
    },
    paused: onPause,
    setBadge(text) {
      if (process.platform === "darwin") {
        app.dock?.setBadge(text);
        return;
      }
      const n = text === "" ? 0 : text === "•" ? 1 : Number.parseInt(text, 10);
      app.setBadgeCount(Number.isFinite(n) ? n : 0);
    },
    open(key, threadId) {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (key > 0) win.webContents.send("matters:open-mail", { key, threadId });
    },
  });
}

/** Pasted images wait here, only for the app to read, until their copy has ended. */
const pasteDir = () => join(app.getPath("userData"), "paste");

/**
 * Hands the router a dedicated port for grants and mints them (ADR 0041, rule 3). Paths go to
 * the router over this port and nowhere else; the router says when a copy ended so a pasted
 * image's temporary file can go.
 */
async function connectGrants(backend: Electron.UtilityProcess): Promise<GrantMint> {
  // Left over from a run that did not quit cleanly.
  await rm(pasteDir(), { recursive: true, force: true });
  await mkdir(pasteDir(), { recursive: true, mode: 0o700 });
  const channel = new MessageChannelMain();
  backend.postMessage({ type: "grants" }, [channel.port1]);
  const mint = new GrantMint({
    async stat(path) {
      try {
        const s = await stat(path);
        return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
      } catch {
        return null;
      }
    },
    async writeTemp(extension, bytes) {
      const path = join(pasteDir(), `${randomUUID()}.${extension}`);
      await writeFile(path, bytes, { mode: 0o600 });
      return path;
    },
    removeTemp: (path) => rm(path, { force: true }),
    send: (message: GrantMessage) => channel.port2.postMessage(message),
    newId: () => randomUUID(),
  });
  channel.port2.on("message", (event) => {
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null) return;
    const { type, grantId } = data as { type?: unknown; grantId?: unknown };
    if (type === "release" && typeof grantId === "string") void mint.release(grantId);
  });
  channel.port2.start();
  return mint;
}

/** Asks the backend to close the database and exit; kills it if it does not answer. */
function stopBackend(backend: Electron.UtilityProcess): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      backend.kill();
      resolve();
    }, 6000);
    backend.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    backend.postMessage({ type: "shutdown" });
  });
}

// The helper has its own `whenReady` (identityHelper.ts) and never gets as far as the app; nor
// does an erase (eraseMode.ts).
if (!identityHelper && !erasing)
  app.whenReady().then(async () => {
    trace("main-ready");
    // Before the window exists: its dom-ready must not fire before the port handoff is armed.
    const store = createCredentialStore();
    if (credentialsPending) await moveCredentials(store);
    const testAccount = await prepareTestAccount(store);
    // The backend gets the vault through the renewing store (ADR 0133, rules 5 to 8): a browser
    // sign-in's access token, renewed when it ends soon, never its refresh token. What a sign-in
    // gave waits there under a handle until setup has tested it (rule 6).
    const oauth = createBrowserOAuth();
    const vault = new RenewingCredentialStore({ vault: store, renewal: oauth });
    const signIns = new SignInService({
      oauth,
      hold: (signIn) => vault.hold(signIn),
      // The person signed in in their browser: bring the window that asked back in front of it.
      returned: (owner) => {
        const asked = BrowserWindow.getAllWindows().find((w) => w.webContents.id === owner);
        if (!asked || asked.isDestroyed()) return;
        if (asked.isMinimized()) asked.restore();
        asked.show();
        app.focus({ steal: true });
        asked.focus();
      },
    });
    // The backend first: it starts in its own process while main builds the window, so the
    // window's construction (tens of milliseconds of main-thread work) no longer delays it.
    // After a restore, accounts whose credential this Mac holds back answer as having none (ADR
    // 0145, rule 9); the list is read when the backend first asks for one.
    const held = holdRestoredAccounts(vault, {
      read: () => readHeldFile(databasePath()),
      write: (ids) => writeHeldFile(databasePath(), ids),
    });
    const backend = startBackend(held, store.keys(), testAccount);
    const boot = createWindow();
    const { win, stage } = boot;
    mailWindow = boot;
    // The mail window showed its mail (ADR 0137, rule 4). Heard from here, before anything below
    // is awaited: the page loads meanwhile, and a listener added later could miss it.
    let mailShown = false;
    let whenMailShown: (() => void) | null = null;
    const onMailShown = (event: Electron.IpcMainEvent) => {
      if (event.sender !== win.webContents) return;
      ipcMain.removeListener("matters:first-screen", onMailShown);
      mailShown = true;
      whenMailShown?.();
      // Links that came before the mail was shown are opened now, one by one (ADR 0143, rule 5).
      if (links.size() > 0) linkArrived("mail");
    };
    ipcMain.on("matters:first-screen", onMailShown);
    // `mailto:` links (ADR 0143, rule 5): the window takes one when it has shown its mail and can
    // open a composer, never before, so a link that started the app waits for the launch. A link
    // from outside brings the window forward. A smoke run never opens one: it only says it came.
    const linksOpen = () => mailShown && !smoke && !win.isDestroyed();
    linkArrived = (source) => {
      if (!linksOpen()) return;
      if (source === "outside") {
        bringForward(win, boot.revealed(), () => {
          if (process.platform !== "darwin") return;
          app.show();
          app.focus({ steal: true });
        });
      }
      win.webContents.send(CHANNEL_MAILTO_WAITING);
    };
    // The first link stays first until the window says a composer opened with it, by the id given
    // here, or it failed too often: one taken while another composer started, or whose
    // preparation failed, is offered again (rule 5). Main checks the id against its own.
    ipcMain.handle(CHANNEL_MAILTO_TAKE, (event) =>
      event.sender === win.webContents && linksOpen() ? links.next() : null,
    );
    ipcMain.handle(CHANNEL_MAILTO_DONE, (event, id: unknown, opened: unknown) =>
      event.sender === win.webContents && linksOpen() ? links.done(id, opened) : 0,
    );
    trace("window-created");
    connectToBackend(win, backend);
    // The backend's stage, for the loading screen (ADR 0103, rule 1): a name and two integers.
    backend.on("message", (message: unknown) => {
      if ((message as { type?: unknown } | null)?.type !== BOOT_STAGE_MESSAGE) return;
      const report = readBootReport(message);
      if (report) stage(report);
    });
    // An unpackaged run has Electron's own bundle, so the dock would show Electron's icon. Set ours
    // after the window and the backend are on their way; smoke and trace runs skip it to keep timings clean.
    if (devBuild && !smoke && !tracing && process.platform === "darwin") {
      app.dock?.setIcon(join(iconDir, "icon.png"));
    }
    if (tracing) {
      // The page's phases arrive here (preload, ADR 0005: main sees no data, only these marks).
      // The benchmark may ask the app to leave once the rows are on screen.
      ipcMain.on("matters:trace", (event, entry: unknown) => {
        if (event.sender !== win.webContents || typeof entry !== "object" || entry === null) return;
        const { name, epochMs } = entry as { name?: unknown; epochMs?: unknown };
        if (typeof name !== "string" || typeof epochMs !== "number") return;
        trace(name, epochMs);
        if (name === "rows-painted" && process.env.MATTERS_TRACE_EXIT === "1") {
          setTimeout(() => app.quit(), Number(process.env.MATTERS_TRACE_EXIT_MS ?? 300));
        }
      });
    }
    const mint = await connectGrants(backend);

    // The three ways a file comes in. Only the mail window may ask; the answer is grants, never
    // paths (ADR 0041, rule 3). A drop's paths come from the preload, which read them from a
    // trusted event; a pick has none, because the dialog is ours.
    ipcMain.handle(CHANNEL_PICK, async (event) => {
      if (event.sender !== win.webContents) return [];
      const picked = await dialog.showOpenDialog(win, {
        properties: ["openFile", "multiSelections"],
      });
      return picked.canceled ? [] : mint.fromPaths(picked.filePaths);
    });
    ipcMain.handle(CHANNEL_DROP, (event, paths: unknown) =>
      event.sender === win.webContents ? mint.fromPaths(paths) : [],
    );
    ipcMain.handle(CHANNEL_PASTE, (event, mime: unknown, bytes: unknown) =>
      event.sender === win.webContents ? mint.fromPaste(mime, bytes) : null,
    );

    // The menu's Notifications items follow the pause the router keeps (ADR 0108).
    let pause: PauseState = { enabled: true, untilMs: null };
    let pauseEnds: ReturnType<typeof setTimeout> | undefined;
    let rebuildMenu = () => {};
    const link = connectMainLine(win, backend, (state) => {
      pause = state;
      clearTimeout(pauseEnds);
      const left = state.untilMs === null ? 0 : state.untilMs - Date.now();
      // When the pause ends by itself, the menu offers to pause again (a timer is at most ~24 days).
      if (left > 0 && left < 2 ** 31 - 1) pauseEnds = setTimeout(() => rebuildMenu(), left + 500);
      rebuildMenu();
    });
    // Printing the open thread, or saving it as a PDF (ADR 0144): only the mail window may ask, and
    // the menu's items are on while it says one thread is open. A window test of a dev build may
    // name the folder a PDF goes to without the dialog (`MATTERS_TEST_SAVE_DIR`); a packaged app
    // reads no such variable.
    let printAvailable = false;
    let printed: { ready: PrintReady; path: string | undefined } | null = null;
    const saveDir = devBuild ? process.env.MATTERS_TEST_SAVE_DIR : undefined;
    const printer = createPrinter({
      open: () => openPrintWindow(),
      async chooseSavePath(defaultName) {
        if (saveDir) return join(saveDir, defaultName);
        // The attachments' place (ADR 0043): the dialog asks before it replaces a file.
        const chosen = await dialog.showSaveDialog(win, {
          defaultPath: join(app.getPath("downloads"), defaultName),
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        return chosen.canceled ? undefined : chosen.filePath;
      },
      writeFile: (path, bytes) => writeFile(path, bytes),
      paper: () => paperFor(app.getLocaleCountryCode()),
      onReady: (_action, ready, path) => {
        printed = { ready, path };
      },
      log: (message, error) =>
        console.error(`matters-main: ${message}`, error instanceof Error ? error.message : ""),
    });
    ipcMain.handle(CHANNEL_PRINT, async (event, action: unknown, doc: unknown) => {
      const failed: PrintAnswer = { kind: "failed" };
      if (event.sender !== win.webContents || !isPrintAction(action)) return failed;
      const thread = readPrintDocument(doc);
      if (thread === null) return failed;
      printed = null;
      const answer = await printer.run(action, thread);
      // A corpus run hears how it ended, whether anything in a message ran, and where the file is.
      if (securityRun) {
        // Set by `onReady` while the job ran; TypeScript cannot see that through the call.
        const seen = printed as { ready: PrintReady; path: string | undefined } | null;
        securityEvent("print", {
          action,
          answer: answer.kind,
          scriptRan: seen?.ready.scriptRan ?? false,
          path: answer.kind === "done" ? (seen?.path ?? "") : "",
        });
      }
      return answer;
    });
    ipcMain.on(CHANNEL_PRINT_AVAILABLE, (event, available: unknown) => {
      if (event.sender !== win.webContents || (available === true) === printAvailable) return;
      printAvailable = available === true;
      rebuildMenu();
    });
    /** The menu's items: they act on the mail window's open thread, and only from that window. */
    const askPrint = (action: PrintAction, focused: Electron.BaseWindow | undefined) => {
      if (win.isDestroyed() || !printAvailable || (focused !== undefined && focused !== win))
        return;
      win.webContents.send(CHANNEL_PRINT_ASK, action);
    };

    // Save as .eml… (ADR 0145, rules 1 to 5): only the mail window may ask, for the thread it has
    // open, while the menu's print items are on. The dialogs are main's; the same test variable
    // as a PDF's names the place in a dev build's window tests (the file, or the folder of several).
    const emlQuarantine = createQuarantine({
      platform: process.platform,
      run: async (file, args) => {
        await promisify(execFile)(file, [...args]);
      },
      now: () => Date.now(),
    });
    const emlSaves = new EmlSaves({
      async chooseSavePath(defaultName) {
        if (saveDir) return join(saveDir, defaultName);
        const chosen = await dialog.showSaveDialog(win, {
          defaultPath: join(app.getPath("downloads"), defaultName),
          filters: [{ name: "Email message", extensions: ["eml"] }],
        });
        return chosen.canceled ? undefined : chosen.filePath;
      },
      async chooseFolder() {
        if (saveDir) return saveDir;
        const chosen = await dialog.showOpenDialog(win, {
          defaultPath: app.getPath("downloads"),
          properties: ["openDirectory", "createDirectory"],
          buttonLabel: "Save Here",
        });
        return chosen.canceled ? undefined : chosen.filePaths[0];
      },
      exists: (path) =>
        lstat(path).then(
          () => true,
          () => false,
        ),
      save: (job, messageKey, target, overwrite, onBytes) =>
        link.saveSource(job, messageKey, target, overwrite, onBytes),
      stop: (job) => link.stopSource(job),
      quarantine: emlQuarantine,
      dayOf: (ms) => localDay(ms),
      progress: (progress) => {
        if (!win.isDestroyed()) win.webContents.send(CHANNEL_EML_PROGRESS, progress);
      },
      newJob: () => randomUUID(),
      log: (message, error) =>
        console.error(`matters-main: ${message}`, error instanceof Error ? error.message : ""),
    });
    ipcMain.handle(CHANNEL_EML, async (event, action: unknown, letters: unknown) => {
      if (event.sender !== win.webContents) return { kind: "invalid" };
      if (action === "stop") {
        await emlSaves.stop();
        return { kind: "cancelled" };
      }
      if (action !== "save" || !printAvailable) return { kind: "invalid" };
      return emlSaves.save(letters);
    });
    /** The menu's Save as .eml…: it acts on the mail window's open thread, from that window only. */
    const askEml = (focused: Electron.BaseWindow | undefined) => {
      if (win.isDestroyed() || !printAvailable || (focused !== undefined && focused !== win))
        return;
      win.webContents.send(CHANNEL_EML_ASK);
    };

    // Received files: only the mail window may ask, by message key and part id (ADR 0043, rule 10).
    const received = createReceivedFiles(win, link);
    ipcMain.handle(
      CHANNEL_RECEIVED,
      async (
        event,
        action: unknown,
        messageKey: unknown,
        partId: unknown,
        name: unknown,
        items: unknown,
      ): Promise<ReceivedAnswer> => {
        if (event.sender !== win.webContents) return { kind: "failed" };
        switch (action) {
          case "open":
            return received.open(messageKey, partId);
          case "preview":
            return received.preview(messageKey, partId);
          case "save":
            return received.save(messageKey, partId, name);
          case "saveAll":
            return received.saveAll(items);
          default:
            return { kind: "failed" };
        }
      },
    );

    // Installing a newer version (ADR 0140): made here so that quitting can wait for an install
    // to clean up; wired to the release state below.
    let installTold = (_progress: boolean) => {};
    const installer = new Installer({
      place: () =>
        placeOfThisCopy({
          packaged: app.isPackaged,
          executable: process.execPath,
          testFolder: installTest?.folder ?? null,
        }),
      deps: (step) =>
        systemInstallDeps(
          (target) =>
            net.request({
              method: "GET",
              url: target,
              session: releaseSession(),
              credentials: "omit",
              useSessionCookies: false,
              redirect: "manual",
              cache: "no-store",
              referrerPolicy: "no-referrer",
            }),
          app.getPath("temp"),
          step,
          installTest !== null,
        ),
      running: () => app.getVersion(),
      pid: () => process.pid,
      told: (progress) => installTold(progress),
      // The helper waits for this process to end before it swaps (ADR 0110: one copy at a time),
      // so the words have a moment on screen first.
      quit: () => setTimeout(() => app.quit(), 600),
      ...(installTest ? { base: installTest.base } : {}),
    });

    // Every way out (window closed, Cmd+Q, smoke finished) passes through here once.
    let stopped = false;
    app.on("before-quit", (event) => {
      if (stopped) return;
      event.preventDefault();
      void installer
        .settle(10_000)
        .then(() => stopBackend(backend))
        .then(() => mint.releaseAll())
        .then(() => {
          stopped = true;
          app.quit();
        });
    });

    // One settings window at most; asking again brings it forward.
    let settings: BrowserWindow | null = null;
    function openSettings(section?: string) {
      if (settings) {
        if (section !== undefined) settings.webContents.send(CHANNEL_SETTINGS_SECTION, section);
        settings.show();
        settings.focus();
        return;
      }
      // Where this copy runs from, once, for Settings › About (ADR 0140, rule 2).
      installer.knowPlace();
      settings = createSettingsWindow(section);
      connectToBackend(settings, backend);
      settings.once("closed", () => {
        settings = null;
      });
    }
    ipcMain.on("matters:open-settings", (event) => {
      if (event.sender === win.webContents) openSettings();
    });
    // Browser sign-in (ADR 0133): setup in the mail window and Settings › Accounts may ask. The
    // answer is a handle and the address that signed in, never a token (rule 5). A sign-in ends
    // when the window that asked closes or loads another page (rule 2).
    ipcMain.handle(
      CHANNEL_SIGN_IN,
      async (
        event,
        action: unknown,
        provider: unknown,
        address: unknown,
      ): Promise<BrowserSignInAnswer | BrowserSignInOffer | { cancelled: true } | null> => {
        const sender = event.sender;
        if (sender !== win.webContents && (!settings || sender !== settings.webContents)) {
          return null;
        }
        const ask = parseSignInAsk(action, provider, address);
        if (ask === null) return null;
        if (ask.action === "offered") return { offered: signIns.offered(ask.provider) };
        if (ask.action === "cancel") {
          signIns.cancel(sender.id);
          return { cancelled: true };
        }
        const owner = sender.id;
        const end = () => signIns.cancel(owner);
        const navigated = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
          if (details.isMainFrame && !details.isSameDocument) end();
        };
        sender.once("destroyed", end);
        sender.on("render-process-gone", end);
        sender.on("did-start-navigation", navigated);
        try {
          return await signIns.start(owner, ask.provider, ask.address);
        } finally {
          if (!sender.isDestroyed()) {
            sender.removeListener("destroyed", end);
            sender.removeListener("render-process-gone", end);
            sender.removeListener("did-start-navigation", navigated);
          }
        }
      },
    );
    // Newer versions (ADR 0137). The state is main's: the switch, the last answer and its ETag, and
    // the version About was last shown with, in a file under userData (rule 14). Every window
    // hears when it changed (ADR 0115), and the menu follows it.
    let releaseStored: StoredRelease | null = null;
    const releaseState = (): StoredRelease => {
      releaseStored ??= readStoredRelease();
      return releaseStored;
    };
    const releaseOn = () => releaseUrl !== null && releaseState().enabled;
    let releaseChecking = false;
    /** When this run last tried, for the day between checks (rules 4 and 12); null before the first. */
    let releaseTriedMs: number | null = null;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const currentRelease = () =>
      releaseInfo(
        releaseState(),
        app.getVersion(),
        releaseUrl !== null,
        releaseChecking,
        installer.view(),
      );
    /** Every window hears the state; the menu is rebuilt unless only a download's bytes moved. */
    const tellRelease = (menu = true) => {
      const info = currentRelease();
      for (const open of BrowserWindow.getAllWindows()) {
        if (!open.isDestroyed()) open.webContents.send(CHANNEL_RELEASE_CHANGED, info);
      }
      if (menu) rebuildMenu();
    };
    installTold = (progress) => tellRelease(!progress);
    const keepRelease = (next: StoredRelease) => {
      const before = serializeStoredRelease(releaseState());
      releaseStored = next;
      const text = serializeStoredRelease(next);
      if (text !== before) {
        try {
          writeFileSync(releasePath(), text, { mode: 0o600 });
        } catch (error) {
          // It holds for this run; the next start asks again.
          console.error("could not save what is known of newer versions", error);
        }
      }
      tellRelease();
    };
    /**
     * The next check once a day has passed since the last try (rules 4 and 12). The timer is
     * capped at an hour and the time read again when it fires, so a Mac that slept checks when it
     * wakes and the day has passed, not on a calendar.
     */
    const armRelease = () => {
      clearTimeout(releaseTimer);
      if (!releaseOn()) return;
      const wait = Math.min(msUntilCheck(releaseTriedMs, Date.now()), 60 * 60 * 1000);
      releaseTimer = setTimeout(() => {
        if (checkDue(releaseTriedMs, Date.now())) void checkRelease();
        else armRelease();
      }, wait);
    };
    /** One check, now. Off, or a build that does not ask, makes no request at all (rules 5, 6). */
    const checkRelease = async (): Promise<void> => {
      if (!releaseOn() || releaseUrl === null || releaseChecking) return;
      releaseChecking = true;
      releaseTriedMs = Date.now();
      tellRelease();
      try {
        const outcome = await fetchRelease(releaseUrl, etagToSend(releaseState()));
        releaseChecking = false;
        // Turned off while it was on its way: what came back is not kept.
        if (releaseOn()) keepRelease(afterCheck(releaseState(), outcome, Date.now()));
        else tellRelease();
      } finally {
        releaseChecking = false;
        armRelease();
      }
    };
    // The check of a start comes after the mail window has shown its mail, never before: it is
    // not on the path of the launch (rule 4; ADR 0012). The mail may have been shown while this
    // function was waiting, so the listener above heard it and this only asks whether it did.
    whenMailShown = armRelease;
    if (mailShown) armRelease();
    powerMonitor.on("resume", () => {
      if (mailShown) armRelease();
    });
    /** The menu's item: About, and a check when the switch is on (rule 11). */
    const checkFromMenu = () => {
      openSettings("about");
      void checkRelease();
    };
    // The default mail app (ADR 0143, rule 2): only Settings asks, and only on the person's press
    // does main ask macOS. A build that is not packaged has no client and offers nothing.
    ipcMain.handle(CHANNEL_DEFAULT_MAIL, (event, action: unknown) => {
      if (!settings || event.sender !== settings.webContents) return null;
      if (action === "get") return defaultMailInfo(mailtoClient);
      if (action === "make") return makeDefaultMail(mailtoClient);
      return null;
    });
    // Either window may read the state; only the settings window may change it, ask for a check,
    // say About was shown, or open a link, and a link only by name (rule 8): main picks the URL
    // from what it checked, so nothing a page says is opened.
    ipcMain.handle(CHANNEL_RELEASE, async (event, action: unknown, arg: unknown) => {
      const fromSettings = !!settings && event.sender === settings.webContents;
      if (!fromSettings && event.sender !== win.webContents) return null;
      if (action === "get") return currentRelease();
      if (!fromSettings) return null;
      if (action === "enable" && typeof arg === "boolean") {
        // While an install runs the switch stays: turning it off would hide what is under way.
        if (installer.busy()) return currentRelease();
        keepRelease({ ...releaseState(), enabled: arg });
        armRelease();
        return currentRelease();
      }
      if (action === "check") {
        void checkRelease();
        return currentRelease();
      }
      if (action === "seen") {
        keepRelease(markSeen(releaseState(), app.getVersion(), releaseUrl !== null));
        return currentRelease();
      }
      // Install only on the person's press (ADR 0140, rule 1), and only the version main knows
      // of: the page names none.
      if (action === "install") {
        if (releaseOn()) installer.start(newerRelease(releaseState(), app.getVersion()));
        return currentRelease();
      }
      if (action === "cancel") {
        installer.cancel();
        return currentRelease();
      }
      if (action === "open" && isReleaseOpen(arg)) {
        const href =
          arg === "download" || arg === "notes"
            ? releaseOn()
              ? releaseLinkFor(releaseState(), app.getVersion(), arg)
              : null
            : ABOUT_LINKS[arg];
        // Checked again where it is opened: the file's links only under the release pages.
        const allowed =
          href !== null &&
          (href === RELEASE_DOWNLOAD_PAGE ||
            isReleaseLink(href) ||
            (Object.values(ABOUT_LINKS) as string[]).includes(href));
        if (allowed) {
          if (securityRun) securityEvent("open-external", { href });
          else void shell.openExternal(href);
        }
        return currentRelease();
      }
      return null;
    });
    // Settings › Storage (ADR 0089, rule 5): only the settings window may ask; sizes, never paths.
    const mainStorage = async (): Promise<MainStorage> => ({
      folders: await folderUsage(app.getPath("userData"), databasePath()),
      processes: processUsage(app.getAppMetrics(), {
        backend: backend.pid,
        mail: win.webContents.getOSProcessId(),
        ...(settings ? { settings: settings.webContents.getOSProcessId() } : {}),
      }),
    });
    // Back Up… and Restore from a Backup… (ADR 0145): main's dialogs, a worker process per job.
    const backups = createBackupJobs(() => settings);
    ipcMain.handle(CHANNEL_STORAGE, async (event, action: unknown, arg: unknown, more: unknown) => {
      if (!settings || event.sender !== settings.webContents) return null;
      switch (action) {
        case "backupOverview":
          return backups.overview();
        case "backup":
          return backups.backup();
        case "restoreBackup":
          return backups.restore();
        case "restoreSetAside":
          return backups.restoreSetAside(arg);
        case "stopBackup":
          backups.stop();
          return { ok: true };
        case "cancelRestore":
          await backups.cancelPending();
          return backups.overview();
        case "removeSetAside":
          await removeSetAside(databasePath(), arg);
          return backups.overview();
        case "restartToRestore":
          if (smoke) return null;
          // The swap is the next start's (rule 9); this one quits as it always does.
          if (!(devBuild && process.env.MATTERS_TEST_NO_RELAUNCH === "1")) app.relaunch();
          setImmediate(() => app.quit());
          return { ok: true };
      }
      // A provider's page where the person takes back the app's permission (ADR 0138, rule 8):
      // by name only, at a fixed address.
      if (action === "permissionPage") {
        if (!isPermissionPageId(arg)) return null;
        const href = permissionPageUrl(arg);
        if (securityRun) securityEvent("open-external", { href });
        else await shell.openExternal(href);
        return { ok: true };
      }
      // Erase everything (ADR 0138): what goes, measured now, and the order with a restart.
      if (action === "eraseOverview") {
        return eraseOverview({
          dataDir: app.getPath("userData"),
          databasePath: databasePath(),
          earlierDir: earlierCopyDir(),
        });
      }
      if (action === "erase") {
        if (smoke) return null;
        writeEraseOrder(app.getPath("userData"), {
          version: 1,
          at: new Date().toISOString(),
          earlierCopy: arg === true && earlierCopyDir() !== null,
          permissionPages: Array.isArray(more) ? more.filter(isPermissionPageId) : [],
        });
        // The next start erases; this one closes the backend on its way out (before-quit).
        app.relaunch();
        setImmediate(() => app.quit());
        return { ok: true };
      }
      if (action === "clearCaches") {
        await win.webContents.session.clearCache();
        await win.webContents.session.clearCodeCaches({});
      } else if (action !== "overview") {
        return null;
      }
      return mainStorage();
    });
    // Settings › Notifications (ADR 0108): only the settings window may ask. It hears how the app
    // runs, and main opens System Settings at a fixed address; the page names no URL.
    const system = noticeSystem(process.platform, process.execPath, (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });
    ipcMain.handle(CHANNEL_NOTICE_SYSTEM, async (event, action: unknown) => {
      if (!settings || event.sender !== settings.webContents) return null;
      if (action === "status") return system;
      if (action !== "openSettings" || system.platform !== "macos") return null;
      if (securityRun) {
        securityEvent("open-external", { href: NOTIFICATION_SETTINGS_URL });
        return { opened: false };
      }
      await shell.openExternal(NOTIFICATION_SETTINGS_URL);
      return { opened: true };
    });
    // Settings › Appearance (ADR 0134): either window may read the appearance; only the settings
    // window may change it, and only to a mode, a theme main knows, or a theme it has just checked.
    // Every window hears the result.
    ipcMain.handle(CHANNEL_APPEARANCE, (event, action: unknown, arg: unknown, more: unknown) => {
      const fromSettings = !!settings && event.sender === settings.webContents;
      if (!fromSettings && event.sender !== win.webContents) return null;
      if (action === "get") return currentAppearance();
      if (!fromSettings) return null;
      if (action === "reset") return resetAppearance();
      if (action === "set" && isAppearanceMode(arg)) return setMode(arg);
      if (action === "theme" && (arg === null || isThemeId(arg))) return chooseTheme(arg);
      if (action === "remove" && isThemeId(arg)) return removeTheme(arg);
      if (action === "add" && typeof arg === "string") return addTheme(arg, more);
      if (action === "text" && isThemeId(arg)) return themeText(arg);
      return null;
    });
    // The way back from any window, for a person who cannot read Settings any more (ADR 0134,
    // rule 11). Main handles it before the page, so it works whatever the page shows or binds, and
    // on Windows and Linux too, where there is no app menu (the page binds Ctrl+, there itself).
    const watchResetChord = (target: BrowserWindow) =>
      target.webContents.on("before-input-event", (event, input) => {
        if (!isResetAppearanceChord(input, process.platform)) return;
        event.preventDefault();
        resetAppearance();
      });
    watchResetChord(win);
    app.on("browser-window-created", (_event, created) => {
      if (created !== win) watchResetChord(created);
    });
    // Open windows take the new ground too, for the edge a resize shows before the page repaints
    // (ADR 0134, rule 9); the system's own switch comes through here as well.
    nativeTheme.on("updated", () => {
      for (const open of BrowserWindow.getAllWindows()) {
        if (!open.isDestroyed()) open.setBackgroundColor(background());
      }
    });
    appearanceChanged = () => rebuildMenu();
    const zone = (ms: number) => -new Date(ms).getTimezoneOffset();
    const notificationItems = (): Electron.MenuItemConstructorOptions[] =>
      pauseMenu(pause, Date.now(), zone).map((item) => {
        const choice = item.choice;
        if (choice === undefined) return { label: item.label, enabled: false };
        return {
          label: item.label,
          click: () =>
            void link.send({
              type: "pauseNotifications",
              untilMs: pauseTarget(choice, Date.now(), zone),
            }),
        };
      });
    // Elsewhere the window has no such menu: the page binds Ctrl+, itself.
    rebuildMenu = () => {
      if (process.platform !== "darwin") return;
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "Matters",
            submenu: [
              { role: "about" },
              // Opens About and checks; with the check off it only opens About (ADR 0137, rule 11).
              { label: releaseMenuLabel(currentRelease()), click: checkFromMenu },
              { type: "separator" },
              { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => openSettings() },
              { label: "Notifications", submenu: notificationItems() },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          // The role's Close Window, then Save as PDF… and Print… for the open thread (ADR 0144,
          // rule 1), where a Mac app has them.
          {
            label: "File",
            submenu: [
              { role: "close" },
              { type: "separator" },
              {
                label: "Save as PDF…",
                enabled: printAvailable,
                click: (_item, focused) => askPrint("pdf", focused),
              },
              {
                label: "Save as .eml…",
                enabled: printAvailable,
                click: (_item, focused) => askEml(focused),
              },
              { type: "separator" },
              {
                label: "Print…",
                accelerator: "CmdOrCtrl+P",
                enabled: printAvailable,
                click: (_item, focused) => askPrint("print", focused),
              },
            ],
          },
          { role: "editMenu" },
          // The role's own items, with Reset Appearance among them: the way back for a person who
          // cannot read Settings any more (ADR 0134, rule 11).
          {
            label: "View",
            submenu: [
              { role: "reload" },
              { role: "forceReload" },
              { role: "toggleDevTools" },
              { type: "separator" },
              { role: "resetZoom" },
              { role: "zoomIn" },
              { role: "zoomOut" },
              { type: "separator" },
              {
                id: "reset-appearance",
                label: "Reset Appearance",
                // Shown here; `before-input-event` above handles the keys in every window.
                accelerator: RESET_APPEARANCE_ACCELERATOR,
                registerAccelerator: false,
                enabled: differsFromDefault(stored),
                click: () => resetAppearance(),
              },
              { type: "separator" },
              { role: "togglefullscreen" },
            ],
          },
          { role: "windowMenu" },
        ]),
      );
    };
    rebuildMenu();

    // Only web addresses leave the app, and only from our own window. A mail address opens a new
    // message here, read by the same rules as a link from outside (ADR 0143, rule 6).
    ipcMain.on("matters:open-link", (event, href: unknown) => {
      if (event.sender !== win.webContents || typeof href !== "string") return;
      if (/^mailto:/i.test(href.trim())) {
        receiveLink(href, "mail");
        return;
      }
      const target = linkForSystem(href);
      if (target !== null) {
        // A corpus run records what would have been handed to the system, and hands nothing.
        if (securityRun) securityEvent("open-external", { href: target });
        else void shell.openExternal(target);
      }
    });

    let done = false;
    if (smoke) {
      // The backend's memory while files are attached (ADR 0041): the page says when it starts and
      // ends, and main samples the backend process (router, sync worker and attachment worker).
      const backendKB = () => {
        const m = app.getAppMetrics().find((p) => p.pid === backend.pid)?.memory;
        return m ? (m.privateBytes ?? m.workingSetSize) : 0;
      };
      // A Map: the label comes from the page, and `__proto__` must stay a label like any other.
      const memory = new Map<string, { startKB: number; peakKB: number; endKB: number }>();
      let sampler: ReturnType<typeof setInterval> | undefined;
      // The page asks the driver for something (new mail) by name; the driver watches stdout.
      ipcMain.on("matters:smoke-signal", (_event, name: unknown) => {
        if (typeof name === "string") process.stdout.write(`${SMOKE_SIGNAL_PREFIX}${name}\n`);
        const [what, label] = typeof name === "string" ? name.split(":") : [];
        if (what === "memory-start" && label) {
          const startKB = backendKB();
          const sample = { startKB, peakKB: startKB, endKB: startKB };
          memory.set(label, sample);
          clearInterval(sampler);
          sampler = setInterval(() => {
            sample.peakKB = Math.max(sample.peakKB, backendKB());
          }, 20);
        } else if (what === "memory-end" && label) {
          clearInterval(sampler);
          const sample = memory.get(label);
          if (sample) {
            sample.endKB = backendKB();
            sample.peakKB = Math.max(sample.peakKB, sample.endKB);
          }
        }
        // A developer can ask for a picture of the window at that moment.
        const shot = process.env.MATTERS_SMOKE_SHOT;
        if (name === "shot" && shot) {
          void win.webContents.capturePage().then((image) => writeFileSync(shot, image.toPNG()));
        }
      });
      ipcMain.once("matters:smoke", (_event, report: SmokeReport | SyncSmokeReport) => {
        const result =
          smokeMode === "security"
            ? { ok: true, output: report }
            : smokeMode === "sync"
              ? runSyncSmoke(report as SyncSmokeReport)
              : runSmoke(
                  { ...(report as SmokeReport), backendMemory: memory },
                  processStartEpochMs,
                  smokePhase,
                );
        done = true;
        // One prefixed line: the smoke driver (tools/smoke-desktop.ts) picks it out of stdout.
        process.stdout.write(`${SMOKE_PREFIX}${JSON.stringify(result.output)}\n`, () => {
          void stopBackend(backend).then(() => app.exit(result.ok ? 0 : 1));
        });
      });
      backend.once("exit", (code) => {
        if (done) return;
        console.error(`backend exited early (code ${code})`);
        app.exit(1);
      });
      setTimeout(() => {
        console.error("smoke timed out");
        app.exit(1);
      }, Number(process.env.MATTERS_SMOKE_TIMEOUT_MS) || 30_000).unref();
    }

    // The mail window is the app: settings do not outlive it.
    win.once("closed", () => {
      settings?.close();
      app.quit();
    });
  });
