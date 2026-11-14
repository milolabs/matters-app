// Thin main process (ADR 0005): window, backend supervision, port handoff. It never
// sees data messages; the renderer talks to the backend over a direct MessagePort.
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  constants,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, uptime } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  EncryptedFileCredentialStore,
  parseCredential,
  type RpcPort,
  serveCredentials,
} from "@matters/adapter-secrets";
import {
  type AppearanceInfo,
  type AppearanceMode,
  MAX_THEMES,
  type ReceivedAnswer,
  THEMES_FULL,
  type ThemeAddAnswer,
} from "@matters/contracts";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  Notification,
  nativeTheme,
  screen,
  shell,
  utilityProcess,
} from "electron";
import attachmentWorkerPath from "../backend/attachmentWorker.ts?modulePath";
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
import { CHANNEL_NOTICE_SYSTEM } from "../preload/noticeBridge.ts";
import { CHANNEL_RECEIVED } from "../preload/receivedBridge.ts";
import { CHANNEL_STORAGE } from "../preload/storageBridge.ts";
import {
  APPEARANCE_FILE,
  appearanceInfo,
  builtInTheme,
  type ChosenTheme,
  DEFAULT_APPEARANCE,
  differsFromDefault,
  isAppearanceMode,
  isResetAppearanceChord,
  isThemeId,
  type LoadedTheme,
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
  themeListing,
  themeSourceFor,
  windowColors,
  windowGround,
  withOwnTheme,
} from "./appearance.ts";
import { BackendLink } from "./backendLink.ts";
import { BUILT_IN_THEMES } from "./builtInThemes.ts";
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
} from "./identityMigration.ts";
import {
  bringForward,
  claimDatabase,
  nodeOwnerFs,
  nodeProcessFacts,
  type Owner,
  ownerPath,
  ownerVerdict,
} from "./instanceLock.ts";
import { linkForSystem } from "./mailto.ts";
import { NOTIFICATION_SETTINGS_URL, noticeSystem } from "./noticeSystem.ts";
import { NoticeShower, noticeFrom, type PauseState, pauseMenu, pauseTarget } from "./notices.ts";
import { createQuarantine } from "./quarantine.ts";
import { ReceivedFiles } from "./received.ts";
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
  app.on("second-instance", () => {
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
const identity = identityHelper ? null : moveData();
if (!identityHelper && process.platform === "win32") claimDataFolder();

/**
 * The database's own claim (ADR 0110): `MATTERS_DB_PATH` can point two data folders at one
 * database, which Electron's lock does not see. After the identity move, which must find nothing
 * of this run's in the folder it fills; before the Keychain and the backend.
 */
function claimDatabaseFile(): void {
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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
    userData: app.getPath("userData"),
  };
  const claim = claimDatabase({
    path: ownerPath(path),
    me,
    fs: nodeOwnerFs,
    judge: (owner, ageMs) => ownerVerdict(owner, ageMs, facts()),
    nowMs: () => Date.now(),
  });
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
if (!identityHelper) claimDatabaseFile();

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

const currentAppearance = (): AppearanceInfo =>
  appearanceInfo(stored, chosen.theme, chosen.fallback, themeList());

// A new window asks for the colours as its preload starts (ADR 0134, rule 9): main answers from
// memory, at once. Every window of the app may ask; it gets only checked values.
if (!identityHelper) {
  ipcMain.on(CHANNEL_APPEARANCE_COLORS, (event) => {
    event.returnValue = windowColors(chosen.theme);
  });
}

/**
 * Applies what the person chose, keeps it, and tells every open window, so a Settings window and
 * the mail window agree whichever of them (or the menu, or the shortcut) changed it. Under the
 * benchmark's theme nothing changes.
 */
function applyAppearance(next: StoredAppearance, theme: ChosenTheme): AppearanceInfo {
  if (traceTheme) return currentAppearance();
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
const resetAppearance = () => applyAppearance(DEFAULT_APPEARANCE, { theme: null, fallback: null });

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
 * every reason; one that passes is written to `themes/` under an id main makes, listed, and put on
 * unless `putOn` is false.
 */
function addTheme(text: string, putOn: boolean): ThemeAddAnswer | null {
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
  const appearance = putOn
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

/** The settings window (ADR 0036): shown once painted, so it never opens blank. */
function createSettingsWindow(): BrowserWindow {
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
    void win.loadURL(new URL("settings.html", page).href);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/settings.html"));
  }
  return win;
}

/**
 * Corpus runs only (ADR 0047): reports every navigation the window attempts and whether it was
 * stopped, and every network request that leaves it. Added after `lockDown`, so a listener sees the
 * verdict of the real handlers. It changes nothing: requests continue, navigations keep their fate.
 */
function watchSecurity(win: BrowserWindow): void {
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
  store: ReturnType<typeof createCredentialStore>,
  testAccount: string | undefined,
): Electron.UtilityProcess {
  const { MATTERS_TEST_PASSWORD: _secret, MATTERS_TEST_ACCOUNT: _hook, ...inherited } = process.env;
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
  serveCredentials(rpc, store);
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

// The helper has its own `whenReady` (identityHelper.ts) and never gets as far as the app.
if (!identityHelper)
  app.whenReady().then(async () => {
    trace("main-ready");
    // Before the window exists: its dom-ready must not fire before the port handoff is armed.
    const store = createCredentialStore();
    if (credentialsPending) await moveCredentials(store);
    const testAccount = await prepareTestAccount(store);
    // The backend first: it starts in its own process while main builds the window, so the
    // window's construction (tens of milliseconds of main-thread work) no longer delays it.
    const backend = startBackend(store, testAccount);
    const boot = createWindow();
    const { win, stage } = boot;
    mailWindow = boot;
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

    // Every way out (window closed, Cmd+Q, smoke finished) passes through here once.
    let stopped = false;
    app.on("before-quit", (event) => {
      if (stopped) return;
      event.preventDefault();
      void stopBackend(backend)
        .then(() => mint.releaseAll())
        .then(() => {
          stopped = true;
          app.quit();
        });
    });

    // One settings window at most; asking again brings it forward.
    let settings: BrowserWindow | null = null;
    function openSettings() {
      if (settings) {
        settings.show();
        settings.focus();
        return;
      }
      settings = createSettingsWindow();
      connectToBackend(settings, backend);
      settings.once("closed", () => {
        settings = null;
      });
    }
    ipcMain.on("matters:open-settings", (event) => {
      if (event.sender === win.webContents) openSettings();
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
    ipcMain.handle(CHANNEL_STORAGE, async (event, action: unknown) => {
      if (!settings || event.sender !== settings.webContents) return null;
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
      if (action === "add" && typeof arg === "string") return addTheme(arg, more !== false);
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
              { type: "separator" },
              { label: "Settings…", accelerator: "CmdOrCtrl+,", click: openSettings },
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
          { role: "fileMenu" },
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

    // Only web and mail addresses leave the app, and only from our own window.
    ipcMain.on("matters:open-link", (event, href: unknown) => {
      if (event.sender !== win.webContents || typeof href !== "string") return;
      // A mailto is rebuilt first: only its addresses, subject and body go on (ADR 0048).
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
