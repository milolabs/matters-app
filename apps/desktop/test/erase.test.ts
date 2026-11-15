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
import { type Holding, undeclaredEntries } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dropEraseOrder,
  type EraseFs,
  type EraseOrder,
  type EraseTargets,
  eraseGuard,
  type KeychainPort,
  leaveErase,
  macKeychain,
  nodeEraseFs,
  parseEraseOrder,
  readEraseOrder,
  runErase,
  startFor,
  writeEraseOrder,
} from "../src/main/erase.ts";
import { eraseReport } from "../src/main/eraseReport.ts";
import { ALL_HOLDINGS, ERASE_ORDER_FILE } from "../src/main/holdings.ts";
import { claimDatabase, nodeOwnerFs, type Owner, ownerPath } from "../src/main/instanceLock.ts";

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
    removeEmptyDir(path) {
      removed.push(path);
      nodeEraseFs.removeEmptyDir(path);
    },
  };
}

describe("the erase order", () => {
  it("is written whole and read back; a broken one still erases, without the earlier copy", () => {
    expect(readEraseOrder(dataDir)).toEqual({ kind: "none" });
    writeEraseOrder(dataDir, order(true));
    expect(readEraseOrder(dataDir)).toEqual({ kind: "order", order: order(true) });
    expect(readdirSync(dataDir)).toEqual([ERASE_ORDER_FILE]);
    // There but not an order: the person confirmed something; the earlier copy stays.
    writeFileSync(join(dataDir, ERASE_ORDER_FILE), "{not json");
    const broken = readEraseOrder(dataDir);
    expect(broken.kind === "order" && broken.order.earlierCopy).toBe(false);
    dropEraseOrder(dataDir);
    expect(readEraseOrder(dataDir)).toEqual({ kind: "none" });
  });

  it("tells three cases apart: none, an order, and a read that proves neither", () => {
    expect(readEraseOrder(join(root, "no such folder"))).toEqual({ kind: "none" });
    expect(readEraseOrder(join(dataDir, "window.json", "below a file"))).toEqual({ kind: "none" });
    writeEraseOrder(dataDir, order(false));
    expect(readEraseOrder(dataDir).kind).toBe("order");
    const failing = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    for (const code of ["EACCES", "EIO", "EPERM"]) {
      expect(readEraseOrder(dataDir, failing(code))).toEqual({ kind: "unreadable", code });
    }
    expect(
      readEraseOrder(dataDir, () => {
        throw new Error("no code");
      }),
    ).toEqual({ kind: "unreadable", code: null });
    // A folder where the file should be: the read fails with EISDIR.
    dropEraseOrder(dataDir);
    mkdirSync(join(dataDir, ERASE_ORDER_FILE));
    expect(readEraseOrder(dataDir)).toEqual({ kind: "unreadable", code: "EISDIR" });
  });

  it("erases nothing when the order could not be read: no path, no key", async () => {
    fill();
    const before = readdirSync(dataDir).sort();
    const keychain = new FakeKeychain();
    const touched: string[] = [];
    const fs: EraseFs = {
      ...nodeEraseFs,
      remove(path) {
        touched.push(`remove ${path}`);
      },
      writeAtomic(path) {
        touched.push(`write ${path}`);
      },
    };
    const read = readEraseOrder(dataDir, () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    const started = await startFor(read, {
      none: async () => "normal",
      order: async (o) => {
        await runErase(o, ALL_HOLDINGS, targets(), {
          fs,
          keychain,
          guard: guardFor(o),
          now: () => 0,
          doneMarker: marker,
        });
        return "erase";
      },
      unreadable: async (code) => `unreadable ${code}`,
    });
    expect(started).toBe("unreadable EACCES");
    expect(touched).toEqual([]);
    expect(keychain.calls).toEqual([]);
    expect(keychain.held).toEqual(new Set(["current-key", "earlier-key"]));
    expect(readdirSync(dataDir).sort()).toEqual(before);
    expect(readFileSync(join(dataDir, "credentials.json"), "utf8")).toBe("vault");
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

  it("does not take what was written into the folder after it was seen empty", async () => {
    fill();
    writeEraseOrder(dataDir, order(true));
    const late = join(dataDir, "written-since.txt");
    const fs: EraseFs = {
      ...nodeEraseFs,
      // A run started since the claim was released writes just before the folder is removed.
      removeEmptyDir(path) {
        if (path === dataDir) file(late, "new mail");
        nodeEraseFs.removeEmptyDir(path);
      },
    };
    const result = await runErase(order(true), ALL_HOLDINGS, targets(), {
      fs,
      keychain: new FakeKeychain(),
      guard: guardFor(order(true)),
      now: () => 0,
      doneMarker: marker,
    });
    expect(eraseReport(result).ok).toBe(true);
    expect(readFileSync(late, "utf8")).toBe("new mail");
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
    expect(readEraseOrder(dataDir).kind).toBe("order");
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
    expect(readEraseOrder(dataDir).kind).toBe("order");
  });

  it("reads a look that fails as something left, never as absent, and keeps the order", async () => {
    fill();
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const fs: EraseFs = {
      ...nodeEraseFs,
      entry(path) {
        if (path === join(dataDir, "attachments")) throw denied;
        return nodeEraseFs.entry(path);
      },
      list(dir) {
        if (dir === tempDir) throw denied;
        return nodeEraseFs.list(dir);
      },
    };
    const result = await runErase(order(false), ALL_HOLDINGS, targets(), {
      fs,
      keychain: new FakeKeychain(),
      guard: guardFor(order(false)),
      now: () => 0,
      doneMarker: marker,
    });
    const report = eraseReport(result);
    expect(report.ok).toBe(false);
    expect(report.left).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "refused", where: join(dataDir, "attachments") }),
        expect.objectContaining({ reason: "refused", where: tempDir }),
      ]),
    );
    expect(existsSync(join(dataDir, "attachments", "a1", "file.pdf"))).toBe(true);
    expect(readEraseOrder(dataDir).kind).toBe("order");
  });

  it("asks for a key again before the order is decided: one said gone but still there keeps it", async () => {
    fill();
    // The store says it deleted the key, and still has it.
    const keychain = new FakeKeychain();
    keychain.remove = async (service: string) => {
      keychain.calls.push(`remove ${service}`);
      return "deleted" as const;
    };
    const result = await runErase(order(false), ALL_HOLDINGS, targets(), {
      fs: nodeEraseFs,
      keychain,
      guard: guardFor(order(false)),
      now: () => 0,
      doneMarker: marker,
    });
    expect(eraseReport(result).left).toEqual([
      expect.objectContaining({ kind: "key", reason: "keychainRefused", where: "current-key" }),
    ]);
    expect(readEraseOrder(dataDir).kind).toBe("order");
  });

  it("keeps the order when the marker cannot be written, and does not throw", async () => {
    fill();
    const result = await runErase(order(false), ALL_HOLDINGS, targets(), {
      fs: {
        ...nodeEraseFs,
        writeAtomic: () => {
          throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        },
      },
      keychain: new FakeKeychain(),
      guard: guardFor(order(false)),
      now: () => 0,
      doneMarker: marker,
    });
    expect(eraseReport(result).ok).toBe(false);
    expect(readEraseOrder(dataDir).kind).toBe("order");
  });

  it("leaving a partial erase writes the marker before the order goes (rule 4)", async () => {
    fill();
    const keychain = new FakeKeychain();
    keychain.refuse = true;
    const deps = { fs: nodeEraseFs, now: () => 0, doneMarker: marker };
    const result = await runErase(order(false), ALL_HOLDINGS, targets(), {
      ...deps,
      keychain,
      guard: guardFor(order(false)),
    });
    expect(eraseReport(result).ok).toBe(false);
    // Partial: no marker yet, and the order stays for Try again.
    expect(existsSync(join(dataDir, "identity-migration.json"))).toBe(false);

    // When the marker cannot be written, the order stays: the next start erases again.
    const failing = {
      ...deps,
      fs: {
        ...nodeEraseFs,
        writeAtomic: () => {
          throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        },
      },
    };
    expect(leaveErase({ dataDir, earlierDir }, failing)).toBe(false);
    expect(readEraseOrder(dataDir).kind).toBe("order");

    expect(leaveErase({ dataDir, earlierDir }, deps)).toBe(true);
    expect(readEraseOrder(dataDir).kind).toBe("none");
    expect(JSON.parse(readFileSync(join(dataDir, "identity-migration.json"), "utf8")).state).toBe(
      "done",
    );
  });

  describe("a database another run owns (ADR 0110)", () => {
    const me = (token: string): Owner => ({
      pid: 4242,
      startedAtMs: 1,
      host: "this-mac",
      token,
      userData: dataDir,
    });
    const claimWith = (verdict: "held" | "stale") => () =>
      claimDatabase({
        path: ownerPath(join(dataDir, "matters.db")),
        me: me("erase"),
        fs: nodeOwnerFs,
        judge: () =>
          verdict === "held"
            ? { kind: "held", owner: null, why: "process 99" }
            : { kind: "stale", why: "process gone" },
        nowMs: () => Date.now(),
      });

    it("is left untouched with a plain reason, and the order stays", async () => {
      fill();
      writeFileSync(ownerPath(join(dataDir, "matters.db")), JSON.stringify(me("other")));
      const result = await runErase(order(false), ALL_HOLDINGS, targets(), {
        fs: nodeEraseFs,
        keychain: new FakeKeychain(),
        guard: guardFor(order(false)),
        now: () => 0,
        doneMarker: marker,
        claimDatabase: claimWith("held"),
      });
      const report = eraseReport(result);
      expect(report.left).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: "inUse", where: join(dataDir, "matters.db") }),
          expect.objectContaining({ reason: "inUse", where: join(dataDir, "matters.db-wal") }),
        ]),
      );
      expect(report.left.every((l) => l.reason === "inUse")).toBe(true);
      expect(readFileSync(join(dataDir, "matters.db"), "utf8")).toBe("database pages");
      expect(JSON.parse(readFileSync(ownerPath(join(dataDir, "matters.db")), "utf8")).token).toBe(
        "other",
      );
      expect(readEraseOrder(dataDir).kind).toBe("order");
    });

    it("is erased under the erase's own claim, which goes last", async () => {
      fill();
      writeFileSync(ownerPath(join(dataDir, "matters.db")), JSON.stringify(me("crashed")));
      const result = await runErase(order(false), ALL_HOLDINGS, targets(), {
        fs: nodeEraseFs,
        keychain: new FakeKeychain(),
        guard: guardFor(order(false)),
        now: () => 0,
        doneMarker: marker,
        claimDatabase: claimWith("stale"),
      });
      expect(eraseReport(result).ok).toBe(true);
      expect(readdirSync(dataDir)).toEqual(["identity-migration.json"]);
    });

    /** A claim judged as ADR 0110 judges it: the erase's own file is a live run's. */
    const claimAs = (token: string, database: string, removed?: string[]) => () =>
      claimDatabase({
        path: ownerPath(database),
        me: me(token),
        fs: removed
          ? {
              ...nodeOwnerFs,
              remove(path) {
                removed.push(path);
                nodeOwnerFs.remove(path);
              },
            }
          : nodeOwnerFs,
        judge: (owner) =>
          owner?.token === "erase"
            ? { kind: "held", owner, why: "the erase" }
            : { kind: "stale", why: "process gone" },
        nowMs: () => Date.now(),
      });

    it("is held until the sweep: a second claim in between is refused", async () => {
      fill();
      const database = join(dataDir, "matters.db");
      const second: string[] = [];
      const result = await runErase(order(false), ALL_HOLDINGS, targets(), {
        fs: nodeEraseFs,
        keychain: new FakeKeychain(),
        guard: guardFor(order(false)),
        now: () => 0,
        doneMarker: marker,
        claimDatabase: claimAs("erase", database),
        progress: (e) => {
          if (
            e.kind !== "step" ||
            !["files", "settings", "caches", "temp", "order"].includes(e.step)
          )
            return;
          const c = claimAs("second", database)();
          second.push(`${e.step} ${c.kind}`);
          if (c.kind === "claimed") c.release();
        },
      });
      expect(second).toEqual([
        "files held",
        "settings held",
        "caches held",
        "temp held",
        "order held",
      ]);
      expect(eraseReport(result).ok).toBe(true);
      expect(readdirSync(dataDir)).toEqual(["identity-migration.json"]);
    });

    it("lets its owner file go last of all it deletes, before the order", async () => {
      fill();
      const database = join(dataDir, "matters.db");
      const fs = recordingFs();
      const result = await runErase(order(false), ALL_HOLDINGS, targets(), {
        fs,
        keychain: new FakeKeychain(),
        guard: guardFor(order(false)),
        now: () => 0,
        doneMarker: marker,
        claimDatabase: claimAs("erase", database, fs.removed),
      });
      expect(eraseReport(result).ok).toBe(true);
      const owner = ownerPath(database);
      // Swept with the rest it would be taken while held; it goes once, by the release.
      expect(fs.removed.filter((p) => p === owner)).toHaveLength(1);
      expect(fs.removed.slice(-2)).toEqual([owner, join(dataDir, ERASE_ORDER_FILE)]);
      expect(fs.removed.indexOf(owner)).toBeGreaterThan(
        fs.removed.indexOf(join(dataDir, "Mystery Store")),
      );
      expect(
        result.outcomes.find(
          (o) => o.holding.place.kind === "database" && o.holding.place.suffix === ".owner",
        )?.outcome,
      ).toEqual({ kind: "gone", bytes: 0 });
    });

    it("outside the data folder (MATTERS_DB_PATH) is held, then released and looked for", async () => {
      fill();
      rmSync(join(dataDir, "matters.db"));
      rmSync(join(dataDir, "matters.db-wal"));
      const database = join(outside, "shared.db");
      file(database, "shared pages");
      const t = { ...targets(), databasePath: database };
      const second: string[] = [];
      const result = await runErase(order(false), ALL_HOLDINGS, t, {
        fs: nodeEraseFs,
        keychain: new FakeKeychain(),
        guard: eraseGuard({
          folders: [dataDir],
          files: ["", "-wal", "-shm", "-journal", ".owner"].map((s) => database + s),
          tempDir,
          tempPrefixes: ["matters-agent-"],
        }),
        now: () => 0,
        doneMarker: marker,
        claimDatabase: claimAs("erase", database),
        progress: (e) => {
          if (e.kind === "step" && e.step === "order")
            second.push(claimAs("second", database)().kind);
        },
      });
      expect(second).toEqual(["held"]);
      expect(eraseReport(result).ok).toBe(true);
      expect(existsSync(database)).toBe(false);
      expect(existsSync(ownerPath(database))).toBe(false);
      expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("the person's own file");
      expect(readEraseOrder(dataDir).kind).toBe("none");
    });

    /**
     * A database in a folder of the data folder (MATTERS_DB_PATH = <data>/shared/mail.db): the
     * sweep, or a declared folder, would take the folder and with it the held owner file.
     */
    async function nested(o: {
      readonly extra?: readonly Holding[];
      readonly dataDir?: string;
      readonly databasePath?: string;
    }) {
      fill();
      const data = o.dataDir ?? dataDir;
      const database = o.databasePath ?? join(dataDir, "shared", "mail.db");
      file(database, "shared pages");
      file(join(dataDir, "shared", "notes.txt"), "notes");
      file(join(dataDir, "shared", "deeper", "x.txt"), "x");
      const owner = ownerPath(database);
      const base = recordingFs();
      // Before every delete from the database step to the release, the sweep's included: a
      // second claim is refused.
      let claimed = false;
      const unheld: string[] = [];
      const fs = {
        ...base,
        remove(path: string) {
          if (claimed && path !== owner && !base.removed.includes(owner)) {
            const c = claimAs("second", database)();
            if (c.kind === "claimed") {
              unheld.push(path);
              c.release();
            }
          }
          base.remove(path);
        },
      };
      const second: string[] = [];
      const result = await runErase(
        order(false),
        [...ALL_HOLDINGS, ...(o.extra ?? [])],
        { ...targets(), dataDir: data, databasePath: database, earlierDir: null },
        {
          fs,
          keychain: new FakeKeychain(),
          guard: eraseGuard({
            folders: [data],
            files: ["", "-wal", "-shm", "-journal", ".owner"].map((s) => database + s),
            tempDir,
            tempPrefixes: ["matters-agent-"],
          }),
          now: () => 0,
          claimDatabase: claimAs("erase", database, fs.removed),
          progress: (e) => {
            if (e.kind === "step" && e.step === "database") claimed = true;
            if (e.kind !== "step" || !["files", "caches", "order"].includes(e.step)) return;
            const c = claimAs("second", database)();
            second.push(`${e.step} ${c.kind} ${existsSync(owner)}`);
            if (c.kind === "claimed") c.release();
          },
        },
      );
      expect(unheld).toEqual([]);
      return { result, owner, fs, second };
    }

    it("nested in the data folder keeps its owner file and the folders above it until the release", async () => {
      const { result, owner, fs, second } = await nested({});
      expect(second).toEqual(["files held true", "caches held true", "order held true"]);
      expect(eraseReport(result).ok).toBe(true);
      // The owner file once, by the release; its folder after it, emptied, then the order.
      expect(fs.removed.filter((p) => p === owner)).toHaveLength(1);
      expect(fs.removed.slice(-4)).toEqual([
        owner,
        join(dataDir, "shared"),
        join(dataDir, ERASE_ORDER_FILE),
        dataDir,
      ]);
      expect(fs.removed).toContain(join(dataDir, "shared", "deeper"));
      expect(existsSync(dataDir)).toBe(false);
      expect(readEraseOrder(dataDir).kind).toBe("none");
    });

    it("nested in a declared folder: the folder is emptied around the owner file, not left", async () => {
      const shared: Holding = {
        id: "test.shared",
        group: "files",
        step: "files",
        place: { kind: "data", name: "shared", match: "exact" },
      };
      const { result, owner, fs, second } = await nested({ extra: [shared] });
      expect(second).toEqual(["files held true", "caches held true", "order held true"]);
      expect(eraseReport(result).ok).toBe(true);
      // Its database files went in the database step; what it held besides is counted gone.
      expect(result.outcomes.find((o) => o.holding.id === "test.shared")?.outcome).toEqual({
        kind: "gone",
        bytes: "notes".length + "x".length,
      });
      expect(fs.removed.indexOf(join(dataDir, "shared"))).toBe(fs.removed.indexOf(owner) + 1);
      expect(existsSync(dataDir)).toBe(false);
      expect(readEraseOrder(dataDir).kind).toBe("none");
    });

    it("nested, through a linked data folder: the owner file is still known by its real path", async () => {
      const link = join(root, "linked data");
      symlinkSync(dataDir, link);
      const { result, owner, fs, second } = await nested({
        dataDir: link,
        databasePath: join(dataDir, "shared", "mail.db"),
      });
      expect(second).toEqual(["files held true", "caches held true", "order held true"]);
      expect(eraseReport(result).ok).toBe(true);
      expect(fs.removed.filter((p) => p === owner)).toHaveLength(1);
      // The link itself is not the data folder's to remove; the folder it leads to ends empty.
      expect(fs.removed.slice(-3)).toEqual([
        owner,
        join(link, "shared"),
        join(link, ERASE_ORDER_FILE),
      ]);
      expect(readdirSync(dataDir)).toEqual([]);
      expect(readEraseOrder(dataDir).kind).toBe("none");
    });

    /** A database in a declared folder of the data folder: <data>/attachments/mail.db. */
    function inAttachments() {
      fill();
      const database = join(dataDir, "attachments", "mail.db");
      file(database, "shared pages");
      file(`${database}-wal`, "shared log");
      file(`${database}-shm`, "shared memory");
      const t = { ...targets(), databasePath: database, earlierDir: null };
      const guard = eraseGuard({
        folders: [dataDir],
        files: ["", "-wal", "-shm", "-journal", ".owner"].map((s) => database + s),
        tempDir,
        tempPrefixes: ["matters-agent-"],
      });
      return { database, t, guard };
    }

    it("held by another live run, in a declared folder: its files and folder are kept all run", async () => {
      const { database, t, guard } = inAttachments();
      const owner = ownerPath(database);
      writeFileSync(owner, JSON.stringify(me("other")));
      const result = await runErase(order(false), ALL_HOLDINGS, t, {
        fs: nodeEraseFs,
        keychain: new FakeKeychain(),
        guard,
        now: () => 0,
        claimDatabase: () =>
          claimDatabase({
            path: owner,
            me: me("erase"),
            fs: nodeOwnerFs,
            judge: (o) =>
              o?.token === "other"
                ? { kind: "held", owner: o, why: "process 99" }
                : { kind: "stale", why: "process gone" },
            nowMs: () => Date.now(),
          }),
      });
      expect(readFileSync(database, "utf8")).toBe("shared pages");
      expect(readFileSync(`${database}-wal`, "utf8")).toBe("shared log");
      expect(readFileSync(`${database}-shm`, "utf8")).toBe("shared memory");
      expect(JSON.parse(readFileSync(owner, "utf8")).token).toBe("other");
      expect(existsSync(join(dataDir, "attachments", "a1"))).toBe(false);
      expect(readdirSync(join(dataDir, "attachments")).sort()).toEqual(
        ["mail.db", "mail.db-shm", "mail.db-wal", "mail.db.owner"].sort(),
      );
      expect(readEraseOrder(dataDir).kind).toBe("order");
      const left = eraseReport(result).left;
      expect(left.every((l) => l.reason === "inUse")).toBe(true);
      for (const path of [database, `${database}-wal`, `${database}-shm`, owner]) {
        expect(left.filter((l) => l.where === path)).toHaveLength(1);
      }
      // The folder kept only around them is not left; what it held besides is gone.
      expect(result.outcomes.find((o) => o.holding.id === "desktop.attachments")?.outcome).toEqual({
        kind: "gone",
        bytes: "pdf".length,
      });
    });

    it("no folder to claim in at the start: a run that makes it meanwhile keeps its database", async () => {
      fill();
      const database = join(dataDir, "shared", "mail.db");
      const owner = ownerPath(database);
      const t = { ...targets(), databasePath: database, earlierDir: null };
      const guard = eraseGuard({
        folders: [dataDir],
        files: ["", "-wal", "-shm", "-journal", ".owner"].map((s) => database + s),
        tempDir,
        tempPrefixes: ["matters-agent-"],
      });
      let arrived = false;
      const fs: EraseFs = {
        ...nodeEraseFs,
        // Another run, with its own data folder, makes the folder and claims the database
        // just before the erase's first deletion.
        remove(path) {
          if (!arrived) {
            arrived = true;
            file(database, "their pages");
            writeFileSync(owner, JSON.stringify(me("other")));
          }
          nodeEraseFs.remove(path);
        },
      };
      const result = await runErase(order(false), ALL_HOLDINGS, t, {
        fs,
        keychain: new FakeKeychain(),
        guard,
        now: () => 0,
        claimDatabase: () =>
          claimDatabase({
            path: owner,
            me: me("erase"),
            fs: nodeOwnerFs,
            judge: (o) =>
              o?.token === "other"
                ? { kind: "held", owner: o, why: "process 99" }
                : { kind: "stale", why: "process gone" },
            nowMs: () => Date.now(),
          }),
      });
      expect(arrived).toBe(true);
      expect(readFileSync(database, "utf8")).toBe("their pages");
      expect(JSON.parse(readFileSync(owner, "utf8")).token).toBe("other");
      expect(readEraseOrder(dataDir).kind).toBe("order");
      const left = eraseReport(result).left;
      expect(left.filter((l) => l.where === database)).toHaveLength(1);
      expect(left.every((l) => l.reason === "inUse")).toBe(true);
    });

    it("not held, in a declared folder: claimed before the first deletion, then all of it goes", async () => {
      const { database, t, guard } = inAttachments();
      const base = recordingFs();
      const attempts: string[] = [];
      let released = false;
      const compete = () => {
        if (released) return;
        const c = claimAs("second", database)();
        attempts.push(c.kind);
        if (c.kind === "claimed") c.release();
      };
      const fs: EraseFs = {
        ...base,
        remove(path) {
          compete();
          base.remove(path);
        },
        removeEmptyDir(path) {
          compete();
          base.removeEmptyDir(path);
        },
      };
      const result = await runErase(order(false), ALL_HOLDINGS, t, {
        fs,
        keychain: new FakeKeychain(),
        guard,
        now: () => 0,
        claimDatabase: () =>
          claimDatabase({
            path: ownerPath(database),
            me: me("erase"),
            fs: {
              ...nodeOwnerFs,
              remove(path) {
                released = true;
                nodeOwnerFs.remove(path);
              },
            },
            judge: (o) =>
              o?.token === "erase"
                ? { kind: "held", owner: o, why: "the erase" }
                : { kind: "stale", why: "process gone" },
            nowMs: () => Date.now(),
          }),
      });
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts.every((a) => a === "held")).toBe(true);
      expect(eraseReport(result).ok).toBe(true);
      expect(existsSync(dataDir)).toBe(false);
    });

    it("in a folder a sign-ins holding names: that step does not take it", async () => {
      fill();
      const database = join(dataDir, "vault", "mail.db");
      file(database, "shared pages");
      file(join(dataDir, "vault", "other.txt"), "other");
      const vault: Holding = {
        id: "test.vault",
        group: "signIns",
        step: "signIns",
        place: { kind: "data", name: "vault", match: "exact" },
      };
      const seen: string[] = [];
      const result = await runErase(
        order(false),
        [...ALL_HOLDINGS, vault],
        { ...targets(), databasePath: database, earlierDir: null },
        {
          fs: nodeEraseFs,
          keychain: new FakeKeychain(),
          guard: eraseGuard({
            folders: [dataDir],
            files: ["", "-wal", "-shm", "-journal", ".owner"].map((s) => database + s),
            tempDir,
            tempPrefixes: ["matters-agent-"],
          }),
          now: () => 0,
          claimDatabase: claimAs("erase", database),
          progress: (e) => {
            if (e.kind === "step" && e.step === "database") {
              seen.push(
                `${existsSync(database) && readFileSync(database, "utf8")} ${existsSync(ownerPath(database))} ${existsSync(join(dataDir, "vault", "other.txt"))}`,
              );
            }
          },
        },
      );
      expect(seen).toEqual(["shared pages true false"]);
      expect(eraseReport(result).ok).toBe(true);
      expect(existsSync(dataDir)).toBe(false);
    });

    it("is released when something is left; an owner file that cannot be looked for is left", async () => {
      fill();
      const database = join(dataDir, "matters.db");
      const left = await runErase(order(false), ALL_HOLDINGS, targets(), {
        fs: recordingFs("window.json"),
        keychain: new FakeKeychain(),
        guard: guardFor(order(false)),
        now: () => 0,
        doneMarker: marker,
        claimDatabase: claimAs("erase", database),
      });
      expect(eraseReport(left).ok).toBe(false);
      expect(existsSync(ownerPath(database))).toBe(false);
      expect(existsSync(join(dataDir, "Mystery Store"))).toBe(true);
      expect(readEraseOrder(dataDir).kind).toBe("order");

      const owner = ownerPath(database);
      const blind: EraseFs = {
        ...nodeEraseFs,
        entry(path) {
          if (path === owner) throw Object.assign(new Error("i/o"), { code: "EIO" });
          return nodeEraseFs.entry(path);
        },
      };
      const unseen = await runErase(order(false), ALL_HOLDINGS, targets(), {
        fs: blind,
        keychain: new FakeKeychain(),
        guard: guardFor(order(false)),
        now: () => 0,
        doneMarker: marker,
        claimDatabase: claimAs("erase", database),
      });
      expect(eraseReport(unseen).left).toEqual([
        expect.objectContaining({ reason: "failed", where: owner }),
      ]);
      expect(existsSync(owner)).toBe(false);
      expect(readEraseOrder(dataDir).kind).toBe("order");
    });
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
