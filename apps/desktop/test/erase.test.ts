// ADR 0138, rules 2, 3, 4, 7 and 11: the erase on temporary folders with a fake key store. Nothing
// here resolves the real data folder, the real earlier copy or a real Keychain item.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { undeclaredEntries } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dropEraseOrder,
  type EraseFs,
  type EraseOrder,
  type EraseTargets,
  eraseGuard,
  type KeychainPort,
  macKeychain,
  nodeEraseFs,
  parseEraseOrder,
  readEraseOrder,
  runErase,
  writeEraseOrder,
} from "../src/main/erase.ts";
import { eraseReport } from "../src/main/eraseReport.ts";
import { ALL_HOLDINGS, ERASE_ORDER_FILE } from "../src/main/holdings.ts";

let root: string;
let dataDir: string;
let tempDir: string;
let earlierDir: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "matters-erase-test-")));
  dataDir = join(root, "Matters");
  tempDir = join(root, "tmp");
  earlierDir = join(root, "@unclosed", "desktop");
  outside = join(root, "outside");
  for (const d of [dataDir, tempDir, earlierDir, outside]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const order = (earlierCopy: boolean): EraseOrder => ({
  version: 1,
  at: "2026-11-14T00:00:00.000Z",
  earlierCopy,
  permissionPages: [],
});

function file(path: string, text = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** A data folder as a run leaves it, with one entry no holding claims. */
function fill(): void {
  file(join(dataDir, "credentials.json"), "vault");
  file(join(dataDir, "matters.db"), "database pages");
  file(join(dataDir, "matters.db-wal"), "log");
  file(join(dataDir, "attachments", "a1", "file.pdf"), "pdf");
  file(join(dataDir, "window.json"), "{}");
  file(join(dataDir, "notifications-state.json"), "{}");
  file(join(dataDir, "Local Storage", "leveldb", "000003.log"), "matters.colors");
  file(join(dataDir, "Cache", "data_0"), "cache");
  file(join(dataDir, "Mystery Store", "x"), "undeclared");
  file(join(tempDir, "matters-agent-abc", "prompt.txt"), "turn");
  file(join(tempDir, "someone-else", "keep.txt"), "not ours");
  file(join(earlierDir, "unclosed.db"), "old mailbox");
  file(join(outside, "precious.txt"), "the person's own file");
  writeEraseOrder(dataDir, order(false));
}

class FakeKeychain implements KeychainPort {
  readonly held = new Set(["current-key", "earlier-key"]);
  readonly calls: string[] = [];
  refuse = false;
  async remove(service: string) {
    this.calls.push(`remove ${service}`);
    if (this.refuse) return "refused" as const;
    return this.held.delete(service) ? ("deleted" as const) : ("absent" as const);
  }
  async exists(service: string) {
    return this.held.has(service);
  }
}

const targets = (): EraseTargets => ({
  dataDir,
  databasePath: join(dataDir, "matters.db"),
  tempDir,
  earlierDir,
  keychain: { current: "current-key", earlier: "earlier-key" },
});

function guardFor(o: EraseOrder) {
  const t = targets();
  return eraseGuard({
    folders: [t.dataDir, ...(o.earlierCopy && t.earlierDir ? [t.earlierDir] : [])],
    files: [t.databasePath, `${t.databasePath}-wal`],
    tempDir,
    tempPrefixes: ["matters-agent-", "matters-codex-", "matters-identity-"],
  });
}

const marker = (earlier: string, atMs: number) => ({
  name: "identity-migration.json",
  text: JSON.stringify({
    version: 1,
    state: "done",
    from: earlier,
    at: new Date(atMs).toISOString(),
  }),
});

/** Records the order of deletions; can fail one path, once, like an interrupted run. */
function recordingFs(failOn?: string): EraseFs & { removed: string[] } {
  const removed: string[] = [];
  let failed = false;
  return {
    ...nodeEraseFs,
    removed,
    remove(path) {
      if (failOn && !failed && path.endsWith(failOn)) {
        failed = true;
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }
      removed.push(path);
      nodeEraseFs.remove(path);
    },
  };
}

describe("the erase order", () => {
  it("is written whole and read back; a broken one still erases, without the earlier copy", () => {
    expect(readEraseOrder(dataDir)).toBeNull();
    writeEraseOrder(dataDir, order(true));
    expect(readEraseOrder(dataDir)?.earlierCopy).toBe(true);
    expect(readdirSync(dataDir)).toEqual([ERASE_ORDER_FILE]);
    writeFileSync(join(dataDir, ERASE_ORDER_FILE), "{not json");
    expect(readEraseOrder(dataDir)?.earlierCopy).toBe(false);
    dropEraseOrder(dataDir);
    expect(readEraseOrder(dataDir)).toBeNull();
  });

  it("keeps only known provider pages", () => {
    const parsed = parseEraseOrder(
      JSON.stringify({ ...order(false), permissionPages: ["microsoftWork", "https://evil"] }),
    );
    expect(parsed?.permissionPages).toEqual(["microsoftWork"]);
  });
});

describe("the guard", () => {
  it("allows the data folder, the database's own files and the app's temp folders", () => {
    const allows = guardFor(order(false));
    expect(allows(join(dataDir, "attachments"))).toBe(true);
    expect(allows(dataDir)).toBe(true);
    expect(allows(join(dataDir, "matters.db"))).toBe(true);
    expect(allows(join(tempDir, "matters-agent-abc"))).toBe(true);
  });

  it("refuses what `..` leads out to, other temp folders and the earlier copy unless asked", () => {
    const allows = guardFor(order(false));
    expect(allows(join(dataDir, "..", "outside", "precious.txt"))).toBe(false);
    expect(allows(join(dataDir, "attachments", "..", "..", "outside"))).toBe(false);
    expect(allows(join(tempDir, "someone-else"))).toBe(false);
    expect(allows(join(tempDir, "matters-agent-abc", "..", "..", "outside"))).toBe(false);
    expect(allows(join(tempDir, "nested", "matters-agent-x"))).toBe(false);
    expect(allows(earlierDir)).toBe(false);
    expect(guardFor(order(true))(earlierDir)).toBe(true);
    expect(allows("/")).toBe(false);
    expect(allows("")).toBe(false);
  });

  it("follows a link on the way, but deletes a link itself as a link", () => {
    symlinkSync(outside, join(dataDir, "elsewhere"));
    const allows = guardFor(order(false));
    // Through the link is outside.
    expect(allows(join(dataDir, "elsewhere", "precious.txt"))).toBe(false);
    // The link is in the data folder.
    expect(allows(join(dataDir, "elsewhere"))).toBe(true);
  });

  it("refuses a root of / or the home folder", () => {
    const allows = eraseGuard(
      { folders: ["/", root], files: [], tempDir: "/", tempPrefixes: [""] },
      undefined,
      root,
    );
    expect(allows("/etc/hosts")).toBe(false);
    expect(allows(join(root, "anything"))).toBe(false);
  });
});

describe("running the erase", () => {
  it("erases in order, keeps the earlier copy and leaves the marker, then drops the order", async () => {
    fill();
    symlinkSync(outside, join(dataDir, "a link out"));
    const keychain = new FakeKeychain();
    const fs = recordingFs();
    let clock = 1000;
    const result = await runErase(order(false), ALL_HOLDINGS, targets(), {
      fs,
      keychain,
      guard: guardFor(order(false)),
      now: () => (clock += 500),
      doneMarker: marker,
    });
    const report = eraseReport(result, true);
    expect(report.ok).toBe(true);
    // Credentials and the key first, then the database, files, settings, caches, temp.
    const at = (end: string) => fs.removed.findIndex((p) => p.endsWith(end));
    expect(at("credentials.json")).toBe(0);
    expect(keychain.calls[0]).toBe("remove current-key");
    expect(at("credentials.json")).toBeLessThan(at("matters.db"));
    expect(at("matters.db")).toBeLessThan(at("attachments"));
    expect(at("attachments")).toBeLessThan(at("window.json"));
    expect(at("window.json")).toBeLessThan(at("Cache"));
    expect(at("Cache")).toBeLessThan(at("matters-agent-abc"));
    expect(at("matters-agent-abc")).toBeLessThan(at("Mystery Store"));
    expect(at("Mystery Store")).toBeLessThan(at(ERASE_ORDER_FILE));
    // What is left: the marker alone, so the identity move never copies the earlier one in.
    expect(readdirSync(dataDir)).toEqual(["identity-migration.json"]);
    expect(JSON.parse(readFileSync(join(dataDir, "identity-migration.json"), "utf8")).state).toBe(
      "done",
    );
    expect(existsSync(join(earlierDir, "unclosed.db"))).toBe(true);
    expect(keychain.held.has("earlier-key")).toBe(true);
    // Untouched: another program's temp folder, and what a link pointed to.
    expect(existsSync(join(tempDir, "someone-else", "keep.txt"))).toBe(true);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("the person's own file");
    expect(report.keys).toBe(1);
    expect(report.bytes).toBeGreaterThan(0);
  });

  it("with the earlier copy takes its folder and key too and leaves no folder at all", async () => {
    fill();
    writeEraseOrder(dataDir, order(true));
    const keychain = new FakeKeychain();
    const result = await runErase(order(true), ALL_HOLDINGS, targets(), {
      fs: nodeEraseFs,
      keychain,
      guard: guardFor(order(true)),
      now: () => 0,
      doneMarker: marker,
    });
    expect(eraseReport(result).ok).toBe(true);
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(earlierDir)).toBe(false);
    expect(keychain.held.size).toBe(0);
    expect(result.earlierCopy).toBe(true);
  });

  it("is continued after an interruption, and repeating a finished erase changes nothing", async () => {
    fill();
    const keychain = new FakeKeychain();
    const deps = {
      keychain,
      guard: guardFor(order(false)),
      now: () => 0,
      doneMarker: marker,
    };
    const first = await runErase(order(false), ALL_HOLDINGS, targets(), {
      ...deps,
      fs: recordingFs("attachments"),
    });
    const report = eraseReport(first);
    expect(report.ok).toBe(false);
    expect(report.left).toEqual([
      expect.objectContaining({ group: "files", kind: "path", reason: "busy" }),
    ]);
    // The order stays: the next start continues it.
    expect(readEraseOrder(dataDir)).not.toBeNull();
    expect(existsSync(join(dataDir, "credentials.json"))).toBe(false);

    const second = await runErase(order(false), ALL_HOLDINGS, targets(), {
      ...deps,
      fs: nodeEraseFs,
    });
    expect(eraseReport(second).ok).toBe(true);
    expect(readdirSync(dataDir)).toEqual(["identity-migration.json"]);

    const third = await runErase(order(false), ALL_HOLDINGS, targets(), {
      ...deps,
      fs: nodeEraseFs,
    });
    expect(eraseReport(third).ok).toBe(true);
    expect(eraseReport(third).bytes).toBeLessThan(200);
  });

  it("reports a key the store refused, and keeps the order", async () => {
    fill();
    const keychain = new FakeKeychain();
    keychain.refuse = true;
    const result = await runErase(order(false), ALL_HOLDINGS, targets(), {
      fs: nodeEraseFs,
      keychain,
      guard: guardFor(order(false)),
      now: () => 0,
    });
    const report = eraseReport(result);
    expect(report.left).toEqual([
      expect.objectContaining({ kind: "key", reason: "keychainRefused", where: "current-key" }),
    ]);
    // Everything else went; the vault is gone, so the key protects nothing.
    expect(existsSync(join(dataDir, "credentials.json"))).toBe(false);
    expect(readEraseOrder(dataDir)).not.toBeNull();
  });

  it("deletes nothing the guard refuses, whatever the list says", async () => {
    fill();
    const result = await runErase(order(false), ALL_HOLDINGS, targets(), {
      fs: nodeEraseFs,
      keychain: new FakeKeychain(),
      guard: () => false,
      now: () => 0,
    });
    expect(eraseReport(result).left.every((l) => l.reason === "outsideReach")).toBe(true);
    expect(existsSync(join(dataDir, "credentials.json"))).toBe(true);
    expect(existsSync(join(tempDir, "matters-agent-abc"))).toBe(true);
  });
});

describe("the Keychain on macOS (rule 7)", () => {
  it("runs `security` with the service only, and reads its answers; nothing real is called", async () => {
    const calls: string[][] = [];
    const answers = [0, 44, 0, 44];
    const keychain = macKeychain(async (file, args) => {
      calls.push([file, ...args]);
      return { code: answers.shift() ?? 1 };
    });
    expect(await keychain.remove("fake service")).toBe("deleted");
    expect(await keychain.exists("fake service")).toBe(true);
    expect(await keychain.exists("fake service")).toBe(false);
    expect(calls[0]).toEqual([
      "/usr/bin/security",
      "delete-generic-password",
      "-s",
      "fake service",
    ]);
    const refused = macKeychain(async () => ({ code: 51 }));
    expect(await refused.remove("fake service")).toBe("refused");
  });
});

describe("nothing undeclared (rule 2)", () => {
  it("claims every entry a seeded build left in its data folder", () => {
    // What a seeded smoke build (Electron 45) wrote, listed on 2026-11-14; tools/smoke-erase.ts
    // checks a fresh one.
    const seeded = [
      "Cache",
      "Code Cache",
      "Cookies",
      "Cookies-journal",
      "DIPS",
      "DawnGraphiteCache",
      "DawnWebGPUCache",
      "Extension State",
      "GPUCache",
      "GPUPersistentCache",
      "GraphiteDawnCache",
      "Local State",
      "Local Storage",
      "Network Persistent State",
      "Preferences",
      "Session Storage",
      "Shared Dictionary",
      "Trust Tokens",
      "Trust Tokens-journal",
      "attachments",
      "blob_storage",
      "compile-cache",
      "declarative_performance_observer.db",
      "declarative_performance_observer.db-journal",
      "matters.db",
      "matters.db-shm",
      "matters.db-wal",
      "notifications-state.json",
      "paste",
      // Written by a run with accounts, a window and themes.
      "credentials.json",
      "window.json",
      "appearance.json",
      "themes",
      "spool",
      "received",
      "identity-migration.json",
      "SingletonLock",
      ERASE_ORDER_FILE,
    ];
    expect(undeclaredEntries(ALL_HOLDINGS, seeded, "matters.db")).toEqual([]);
  });
});
