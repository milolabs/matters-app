// The start that erases (ADR 0138, rules 3 and 11). Chosen right after the single-instance claim
// and before the identity move, the database's claim, the Keychain and the backend: none of them
// runs in this start. Electron is pointed at a throwaway data folder, so Chromium holds nothing open
// in the real one, and one small window shows the steps and the result. The result is kept nowhere.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type EraseResult, permissionPageUrl } from "@matters/core";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { CHANNEL_ERASE, CHANNEL_ERASE_PROGRESS } from "../preload/eraseBridge.ts";
import {
  dropEraseOrder,
  type EraseOrder,
  type EraseProgress,
  type EraseTargets,
  eraseGuard,
  type KeychainPort,
  macKeychain,
  nodeEraseFs,
  otherKeychain,
  runErase,
} from "./erase.ts";
import { eraseReport } from "./eraseReport.ts";
import { ALL_HOLDINGS, IDENTITY_TEMP_PREFIX } from "./holdings.ts";
import { MARKER } from "./identityMigration.ts";

export interface EraseModeOptions {
  readonly order: EraseOrder;
  /** The real data folder, read before userData is pointed elsewhere. */
  readonly dataDir: string;
  readonly databasePath: string;
  readonly earlierDir: string | null;
  /** Null in every run that is not the person's own (tests, dev, smoke): no key is touched. */
  readonly keychain: { readonly current: string | null; readonly earlier: string | null };
  /** A smoke run: no window; one result line on stdout, then exit. */
  readonly smoke: boolean;
  /** Where the key store is asked, or a fake (smoke runs). */
  readonly keychainPort?: KeychainPort;
  /** The temp directory whose `matters-*` folders go (a smoke run passes its own). */
  readonly tempDir?: string;
  readonly background: () => string;
  /** Read when the window is made: the caller declares it after this mode is chosen. */
  readonly titleBar: () => Partial<Electron.BrowserWindowConstructorOptions>;
  readonly lockDown: (win: BrowserWindow) => void;
}

export const ERASE_RESULT_PREFIX = "MATTERS_ERASE_RESULT ";

const run = (file: string, args: readonly string[]) =>
  new Promise<{ code: number | null }>((done) => {
    execFile(file, [...args], { timeout: 30_000 }, (error) => {
      done({ code: error ? (typeof error.code === "number" ? error.code : null) : 0 });
    });
  });

/** Points this run at a throwaway data folder. Call before ready, before anything reads it. */
export function enterEraseMode(options: EraseModeOptions): void {
  const throwaway = mkdtempSync(join(tmpdir(), "matters-erase-"));
  app.setPath("userData", throwaway);
  app.setPath("sessionData", throwaway);
  process.on("exit", () => rmSync(throwaway, { recursive: true, force: true }));

  const tempDir = options.tempDir ?? tmpdir();
  const targets: EraseTargets = {
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    tempDir,
    earlierDir: options.earlierDir,
    keychain: options.keychain,
    ownFolder: throwaway,
  };
  const tempPrefixes = ALL_HOLDINGS.flatMap((h) =>
    h.place.kind === "temp" ? [h.place.prefix] : [],
  );
  const keychain =
    options.keychainPort ??
    (process.platform === "darwin" ? macKeychain(run) : otherKeychain(process.platform));
  const guardFor = (order: EraseOrder) =>
    eraseGuard(
      {
        folders: [
          options.dataDir,
          ...(order.earlierCopy && options.earlierDir ? [options.earlierDir] : []),
        ],
        files: [
          ...["", "-wal", "-shm", "-journal", ".owner"].map((s) => options.databasePath + s),
          join(dirname(options.databasePath), "notifications-state.json"),
        ],
        tempDir,
        tempPrefixes: [...tempPrefixes, IDENTITY_TEMP_PREFIX],
      },
      undefined,
      homedir(),
    );

  const markerLeft = (r: EraseResult) =>
    !r.earlierCopy && options.earlierDir !== null && nodeEraseFs.entry(options.earlierDir) !== null;
  let win: BrowserWindow | null = null;
  let result: EraseResult | null = null;
  let running: Promise<EraseResult> | null = null;
  /** What happened so far in this run, for a page that loads after it started. */
  let events: unknown[] = [];
  const send = (data: unknown) => {
    if ((data as { kind?: unknown }).kind !== "result") events.push(data);
    if (win && !win.isDestroyed()) win.webContents.send(CHANNEL_ERASE_PROGRESS, data);
  };
  const erase = (): Promise<EraseResult> => {
    if (running === null) {
      result = null;
      events = [];
    }
    running ??= runErase(options.order, ALL_HOLDINGS, targets, {
      fs: nodeEraseFs,
      keychain,
      guard: guardFor(options.order),
      now: () => Date.now(),
      progress: (event: EraseProgress) =>
        send(
          event.kind === "step"
            ? { kind: "step", step: event.step }
            : {
                kind: "holding",
                group: event.holding.group,
                outcome: event.outcome.kind,
                bytes: event.outcome.kind === "absent" ? 0 : event.outcome.bytes,
              },
        ),
      doneMarker: (earlierDir, atMs) => ({
        name: MARKER,
        text: JSON.stringify({
          version: 1,
          state: "done",
          from: earlierDir,
          at: new Date(atMs).toISOString(),
        }),
      }),
    }).then((r) => {
      result = r;
      running = null;
      send({ kind: "result", report: eraseReport(r, markerLeft(r)) });
      return r;
    });
    return running;
  };

  app.whenReady().then(async () => {
    if (options.smoke) {
      const r = await erase();
      process.stdout.write(
        `${ERASE_RESULT_PREFIX}${JSON.stringify(eraseReport(r, markerLeft(r)))}\n`,
        () => app.exit(0),
      );
      return;
    }
    ipcMain.handle(CHANNEL_ERASE, async (event, action: unknown) => {
      if (!win || event.sender !== win.webContents) return null;
      switch (action) {
        case "state":
          return result
            ? { kind: "result", report: eraseReport(result, markerLeft(result)) }
            : {
                kind: "running",
                earlierCopy: options.order.earlierCopy && !!options.earlierDir,
                events,
              };
        case "pages":
          return { pages: options.order.permissionPages };
        case "retry":
          if (running === null) void erase();
          return { ok: true };
        case "startAgain":
        case "leave":
          // "Leave them" removes the order: the next start opens empty with those things on disk.
          if (action === "leave") dropEraseOrder(options.dataDir);
          app.relaunch();
          app.exit(0);
          return { ok: true };
        case "quit":
          app.exit(0);
          return { ok: true };
        case "keychain":
          // Keychain Access, where the person deletes a key the Keychain refused to.
          if (process.platform === "darwin") {
            void shell.openPath("/System/Applications/Utilities/Keychain Access.app");
          }
          return { ok: true };
        case "show":
          shell.showItemInFolder(options.dataDir);
          return { ok: true };
        case "microsoftWork":
        case "microsoftPersonal":
          if (!options.order.permissionPages.includes(action)) return null;
          await shell.openExternal(permissionPageUrl(action));
          return { ok: true };
        default:
          return null;
      }
    });
    win = new BrowserWindow({
      width: 560,
      height: 440,
      resizable: false,
      fullscreenable: false,
      maximizable: false,
      show: false,
      ...options.titleBar(),
      backgroundColor: options.background(),
      webPreferences: {
        preload: join(import.meta.dirname, "../preload/index.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    options.lockDown(win);
    win.once("ready-to-show", () => win?.show());
    win.on("closed", () => {
      win = null;
      // There is no cancel (rule 10): closing the window leaves the order, and the next start goes on.
      if (running === null) app.exit(0);
      else void running.then(() => app.exit(0));
    });
    const page = process.env.ELECTRON_RENDERER_URL;
    if (page && !app.isPackaged) void win.loadURL(new URL("erase.html", page).href);
    else void win.loadFile(join(import.meta.dirname, "../renderer/erase.html"));
    void erase();
  });
}
