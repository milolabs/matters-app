import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseCredential } from "@matters/adapter-secrets";
import type { Credential } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CredentialsStep,
  copiedName,
  type DataStep,
  holdsMailbox,
  identityPlan,
  MARKER,
  type MigrationFs,
  moveIdentityCredentials,
  moveIdentityData,
  nodeFs,
  type OldPlainVault,
  parseMarker,
  type RunningProbe,
  SET_ASIDE_INFIX,
  STAGED_CREDENTIALS,
  STAGING_SUFFIX,
  staysBehind,
} from "../src/main/identityMigration.ts";

const NOW = new Date("2026-11-10T12:00:00Z");
const free: RunningProbe = () => ({ state: "free" });

/** Every path under `dir` with its kind and content: two equal snapshots mean nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string) => {
    const s = lstatSync(path);
    const key = relative(dir, path) || ".";
    if (s.isSymbolicLink()) out[key] = `link:${readlinkSync(path)}`;
    else if (s.isDirectory()) {
      out[key] = `dir:${s.mode}`;
      for (const name of readdirSync(path)) walk(join(path, name));
    } else {
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      out[key] = `file:${s.mode}:${s.mtimeMs}:${hash}`;
    }
  };
  walk(dir);
  return out;
}

function put(path: string, content = "x") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** An old identity folder as the old app leaves it, caches and locks included. */
function oldFolder(dir: string, opts: { credentials?: boolean } = {}) {
  put(join(dir, "unclosed.db"), "database pages");
  put(join(dir, "unclosed.db-wal"), "write-ahead log");
  put(join(dir, "unclosed.db-shm"), "shared memory");
  if (opts.credentials !== false) {
    put(join(dir, "credentials.json"), JSON.stringify({ version: 1, entries: { a: "b2xk" } }));
  }
  put(join(dir, "window.json"), "{}");
  put(join(dir, "notifications.json"), "{}");
  put(join(dir, "Local Storage", "leveldb", "000003.log"), "unclosed.listWidth");
  put(join(dir, "received", "7", "2", "Faktura.pdf"), "pdf");
  put(join(dir, "attachments", "1"), "file");
  put(join(dir, "Cookies"), "c");
  put(join(dir, "Cache", "Cache_Data", "index"), "cache");
  put(join(dir, "Code Cache", "js", "index"), "cache");
  put(join(dir, "GPUCache", "data_0"), "cache");
  put(join(dir, "blob_storage", "x", "y"), "blob");
  put(join(dir, "Session Storage", "LOG"), "session");
  put(join(dir, "compile-cache", "v1", "a"), "cache");
  symlinkSync("host-12345", join(dir, "SingletonLock"));
}

describe("what is copied", () => {
  it("leaves the regenerable caches and locks behind and keeps everything else", () => {
    for (const name of ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "blob_storage"]) {
      expect(staysBehind(name)).toBe(true);
    }
    for (const name of ["Session Storage", "SingletonLock", "compile-cache", MARKER]) {
      expect(staysBehind(name)).toBe(true);
    }
    for (const name of ["Local Storage", "credentials.json", "window.json", "notifications.json"]) {
      expect(staysBehind(name)).toBe(false);
    }
    for (const name of ["received", "paste", "attachments", "spool", "Cookies", "Preferences"]) {
      expect(staysBehind(name)).toBe(false);
    }
  });

  it("renames the three database files together and stages the vault under another name", () => {
    expect(copiedName("unclosed.db")).toBe("matters.db");
    expect(copiedName("unclosed.db-wal")).toBe("matters.db-wal");
    expect(copiedName("unclosed.db-shm")).toBe("matters.db-shm");
    expect(copiedName("unclosed.dbx")).toBe("unclosed.dbx");
    expect(copiedName("credentials.json")).toBe(STAGED_CREDENTIALS);
    expect(STAGED_CREDENTIALS).not.toBe("credentials.json");
    expect(copiedName("window.json")).toBe("window.json");
  });
});

describe("which runs move anything", () => {
  const base = { appData: "/AppData", userData: "/AppData/Matters" };

  it("moves from the old folder next to the new one in a normal run", () => {
    expect(identityPlan({ ...base, devBuild: false, env: {} })).toEqual({
      oldDir: "/AppData/@unclosed/desktop",
      newDir: "/AppData/Matters",
    });
    expect(identityPlan({ ...base, devBuild: true, env: {} })).not.toBeNull();
  });

  it("never touches the real old folder when the run has data of its own", () => {
    const ownData = { MATTERS_USER_DATA: "/tmp/run" };
    expect(identityPlan({ ...base, devBuild: true, env: ownData })).toBeNull();
    expect(identityPlan({ ...base, devBuild: true, env: { MATTERS_DB_PATH: "/tmp/x.db" } })).toBe(
      null,
    );
    expect(identityPlan({ ...base, devBuild: false, env: { MATTERS_DB_PATH: "/tmp/x" } })).toBe(
      null,
    );
  });

  it("lets a dev build point the move at its own pair of folders, and only a dev build", () => {
    const env = { MATTERS_USER_DATA: "/tmp/new", MATTERS_OLD_USER_DATA: "/tmp/old" };
    expect(identityPlan({ ...base, userData: "/tmp/new", devBuild: true, env })).toEqual({
      oldDir: "/tmp/old",
      newDir: "/tmp/new",
    });
    // Without a new folder of its own it would move into the real one: refused.
    const oldOnly = { MATTERS_OLD_USER_DATA: "/tmp/old" };
    expect(identityPlan({ ...base, devBuild: true, env: oldOnly })).toBeNull();
    // A packaged app ignores both variables and moves the real folders.
    expect(identityPlan({ ...base, devBuild: false, env })).toEqual({
      oldDir: "/AppData/@unclosed/desktop",
      newDir: "/AppData/Matters",
    });
  });
});

describe("moving the data", () => {
  let root: string;
  let oldDir: string;
  let newDir: string;
  const step = (over: Partial<DataStep> = {}): DataStep => ({
    oldDir,
    newDir,
    fs: nodeFs,
    probe: free,
    now: () => NOW,
    ...over,
  });
  const marker = () => parseMarker(readFileSync(join(newDir, MARKER), "utf8"));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "matters-identity-"));
    oldDir = join(root, "@unclosed", "desktop");
    newDir = join(root, "Matters");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a fresh install: nothing to move, and it is remembered", () => {
    expect(moveIdentityData(step())).toEqual({ kind: "settled", state: "fresh" });
    expect(readdirSync(newDir)).toEqual([MARKER]);
    expect(marker()?.state).toBe("fresh");
    expect(existsSync(oldDir)).toBe(false);
    const probe = vi.fn(free);
    expect(moveIdentityData(step({ probe }))).toEqual({ kind: "settled", state: "fresh" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("copies the data, renames the database, and waits for the passwords", () => {
    oldFolder(oldDir);
    const before = snapshot(oldDir);
    // `app.getPath("userData")` has made the new folder already, empty.
    mkdirSync(newDir);

    const outcome = moveIdentityData(step());
    expect(outcome).toMatchObject({ kind: "copied", state: "credentials-pending" });
    expect(snapshot(oldDir)).toEqual(before);

    const names = readdirSync(newDir).sort();
    expect(names).toEqual(
      [
        "Cookies",
        "Local Storage",
        MARKER,
        STAGED_CREDENTIALS,
        "attachments",
        "matters.db",
        "matters.db-shm",
        "matters.db-wal",
        "notifications.json",
        "received",
        "window.json",
      ].sort(),
    );
    expect(readFileSync(join(newDir, "matters.db"), "utf8")).toBe("database pages");
    expect(readFileSync(join(newDir, "matters.db-wal"), "utf8")).toBe("write-ahead log");
    expect(readFileSync(join(newDir, "received", "7", "2", "Faktura.pdf"), "utf8")).toBe("pdf");
    expect(readFileSync(join(newDir, STAGED_CREDENTIALS), "utf8")).toBe(
      readFileSync(join(oldDir, "credentials.json"), "utf8"),
    );
    expect(existsSync(join(newDir, "credentials.json"))).toBe(false);
    expect(marker()).toEqual({
      version: 1,
      state: "credentials-pending",
      from: oldDir,
      at: NOW.toISOString(),
    });
    expect(existsSync(newDir + STAGING_SUFFIX)).toBe(false);
  });

  it("is done at once when the old app saved no passwords", () => {
    oldFolder(oldDir, { credentials: false });
    expect(moveIdentityData(step())).toMatchObject({ kind: "copied", state: "done" });
    expect(marker()?.state).toBe("done");
  });

  it("a crash in the middle of the copy leaves no new folder, and the next start copies again", () => {
    oldFolder(oldDir);
    const before = snapshot(oldDir);
    let copies = 0;
    const failing: MigrationFs = {
      ...nodeFs,
      copyFile(from, to) {
        if (++copies === 4) throw new Error("disk full");
        nodeFs.copyFile(from, to);
      },
    };
    expect(moveIdentityData(step({ fs: failing }))).toEqual({
      kind: "failed",
      message: "disk full",
    });
    expect(existsSync(newDir + STAGING_SUFFIX)).toBe(false);
    expect(existsSync(join(newDir, MARKER))).toBe(false);
    expect(snapshot(oldDir)).toEqual(before);

    expect(moveIdentityData(step())).toMatchObject({ kind: "copied" });
    expect(snapshot(oldDir)).toEqual(before);
  });

  it("a staging copy a killed process left behind is thrown away and made again", () => {
    oldFolder(oldDir);
    put(join(newDir + STAGING_SUFFIX, "matters.db"), "half a database");
    put(join(newDir + STAGING_SUFFIX, MARKER), JSON.stringify({ broken: true }));
    expect(moveIdentityData(step())).toMatchObject({ kind: "copied" });
    expect(readFileSync(join(newDir, "matters.db"), "utf8")).toBe("database pages");
    expect(existsSync(newDir + STAGING_SUFFIX)).toBe(false);
  });

  it("a failure at the last rename publishes nothing", () => {
    oldFolder(oldDir);
    const failing: MigrationFs = {
      ...nodeFs,
      rename() {
        throw new Error("EXDEV");
      },
    };
    expect(moveIdentityData(step({ fs: failing }))).toMatchObject({ kind: "failed" });
    expect(existsSync(newDir)).toBe(false);
    expect(existsSync(newDir + STAGING_SUFFIX)).toBe(false);
  });

  it("refuses while the old app has its database open, and changes nothing", () => {
    oldFolder(oldDir);
    const before = snapshot(oldDir);
    const probe = vi.fn<RunningProbe>(() => ({ state: "running", pids: [4242] }));
    expect(moveIdentityData(step({ probe }))).toEqual({
      kind: "refused",
      reason: "running",
      detail: "process 4242",
    });
    // Only the database files are probed: they are what an open old app holds.
    expect(probe.mock.calls[0]?.[0].map((p) => p.slice(oldDir.length + 1)).sort()).toEqual([
      "unclosed.db",
      "unclosed.db-shm",
      "unclosed.db-wal",
    ]);
    expect(existsSync(newDir)).toBe(false);
    expect(existsSync(newDir + STAGING_SUFFIX)).toBe(false);
    expect(snapshot(oldDir)).toEqual(before);
    // Quit, start again: it moves.
    expect(moveIdentityData(step())).toMatchObject({ kind: "copied" });
  });

  it("refuses a copy the old app wrote into while it was taken", () => {
    oldFolder(oldDir);
    let copies = 0;
    const racing: MigrationFs = {
      ...nodeFs,
      copyFile(from, to) {
        // The old app, still running unseen, appends to its log in the middle of the copy.
        if (++copies === 2)
          writeFileSync(join(oldDir, "unclosed.db-wal"), "write-ahead log, longer");
        nodeFs.copyFile(from, to);
      },
    };
    expect(moveIdentityData(step({ fs: racing }))).toMatchObject({
      kind: "refused",
      reason: "changed",
    });
    expect(existsSync(newDir)).toBe(false);
    expect(existsSync(newDir + STAGING_SUFFIX)).toBe(false);
  });

  it("never copies over a new folder that already holds data", () => {
    oldFolder(oldDir);
    put(join(newDir, "matters.db"), "the new app's own mail");
    const before = snapshot(newDir);
    const oldBefore = snapshot(oldDir);
    expect(moveIdentityData(step())).toEqual({ kind: "kept-existing" });
    expect(readFileSync(join(newDir, "matters.db"), "utf8")).toBe("the new app's own mail");
    expect(snapshot(oldDir)).toEqual(oldBefore);
    const { [MARKER]: added, ...rest } = snapshot(newDir);
    expect(rest).toEqual(before);
    expect(added).toBeDefined();
    // Said once: the next start is settled.
    expect(moveIdentityData(step())).toEqual({ kind: "settled", state: "kept-existing" });
  });

  it("sets aside what an earlier start left in the new folder, then moves", () => {
    oldFolder(oldDir);
    put(join(newDir, "Local State"), "{}");
    put(join(newDir, "Preferences"), "{}");
    put(join(newDir, "Crashpad", "settings.dat"), "x");
    const debris = snapshot(newDir);
    const outcome = moveIdentityData(step());
    const aside = `${newDir}${SET_ASIDE_INFIX}2026-11-10T12-00-00-000Z`;
    expect(outcome).toMatchObject({
      kind: "copied",
      state: "credentials-pending",
      setAside: aside,
    });
    expect(snapshot(aside)).toEqual(debris);
    expect(readFileSync(join(newDir, "matters.db"), "utf8")).toBe("database pages");
    expect(existsSync(join(newDir, "Preferences"))).toBe(false);
    expect(marker()?.state).toBe("credentials-pending");
  });

  it("leaves the leftovers exactly as they were while the old app is open", () => {
    oldFolder(oldDir);
    put(join(newDir, "Local State"), "{}");
    const debris = snapshot(newDir);
    const running: RunningProbe = () => ({ state: "running", pids: [4242] });
    expect(moveIdentityData(step({ probe: running }))).toMatchObject({ kind: "refused" });
    expect(snapshot(newDir)).toEqual(debris);
    expect(readdirSync(root).some((n) => n.includes(SET_ASIDE_INFIX))).toBe(false);
    // Quit, start again: set aside and moved.
    expect(moveIdentityData(step())).toMatchObject({ kind: "copied" });
  });

  it("a failed set-aside is a loud failure that leaves both folders as they were", () => {
    oldFolder(oldDir);
    put(join(newDir, "Local State"), "{}");
    const debris = snapshot(newDir);
    const failing: MigrationFs = {
      ...nodeFs,
      rename(from, to) {
        if (from === newDir) throw new Error("EPERM");
        nodeFs.rename(from, to);
      },
    };
    expect(moveIdentityData(step({ fs: failing }))).toEqual({ kind: "failed", message: "EPERM" });
    expect(snapshot(newDir)).toEqual(debris);
    expect(existsSync(newDir + STAGING_SUFFIX)).toBe(false);
  });

  it("keeps this start's single-instance lock in the folder that ends up in place (ADR 0110)", () => {
    oldFolder(oldDir);
    mkdirSync(newDir, { recursive: true });
    symlinkSync("mac-100", join(newDir, "SingletonLock"));
    symlinkSync("/tmp/x/SingletonSocket", join(newDir, "SingletonSocket"));
    symlinkSync("cookie", join(newDir, "SingletonCookie"));
    // Only the lock: not debris, so nothing is set aside.
    expect(moveIdentityData(step())).toMatchObject({ kind: "copied" });
    expect(readlinkSync(join(newDir, "SingletonLock"))).toBe("mac-100");
    expect(readlinkSync(join(newDir, "SingletonSocket"))).toBe("/tmp/x/SingletonSocket");
    expect(readdirSync(root).some((n) => n.includes(SET_ASIDE_INFIX))).toBe(false);
    expect(readFileSync(join(newDir, "matters.db"), "utf8")).toBe("database pages");
  });

  it("with debris too, the lock moves into the copy and the debris aside", () => {
    oldFolder(oldDir);
    put(join(newDir, "Local State"), "{}");
    symlinkSync("mac-100", join(newDir, "SingletonLock"));
    const outcome = moveIdentityData(step());
    expect(outcome).toMatchObject({ kind: "copied", setAside: expect.any(String) });
    const aside = (outcome as { setAside: string }).setAside;
    expect(readdirSync(aside)).toEqual(["Local State"]);
    expect(readlinkSync(join(newDir, "SingletonLock"))).toBe("mac-100");
  });

  it("a failed move puts the lock back where it was", () => {
    oldFolder(oldDir);
    put(join(newDir, "Local State"), "{}");
    symlinkSync("mac-100", join(newDir, "SingletonLock"));
    const before = snapshot(newDir);
    const failing: MigrationFs = {
      ...nodeFs,
      rename(from, to) {
        if (from === newDir) throw new Error("EPERM");
        nodeFs.rename(from, to);
      },
    };
    expect(moveIdentityData(step({ fs: failing }))).toEqual({ kind: "failed", message: "EPERM" });
    expect(snapshot(newDir)).toEqual(before);
    expect(existsSync(newDir + STAGING_SUFFIX)).toBe(false);
  });

  it("never copies the old folder's database owner file", () => {
    expect(staysBehind("unclosed.db.owner")).toBe(true);
    expect(staysBehind("matters.db.owner")).toBe(true);
  });

  it("counts only a database or saved passwords as a mailbox", () => {
    for (const name of ["matters.db", "matters.db-wal", "credentials.json", STAGED_CREDENTIALS]) {
      expect(holdsMailbox(name)).toBe(true);
    }
    for (const name of ["Local State", "Preferences", "Cache", "window.json", "unclosed.db"]) {
      expect(holdsMailbox(name)).toBe(false);
    }
  });

  it("does nothing once done, and writes nothing", () => {
    oldFolder(oldDir, { credentials: false });
    moveIdentityData(step());
    const before = snapshot(newDir);
    const watch = vi.fn();
    const spying: MigrationFs = {
      ...nodeFs,
      mkdir: watch,
      copyFile: watch,
      rename: watch,
      remove: watch,
      writeTextAtomic: watch,
    };
    const probe = vi.fn(free);
    expect(moveIdentityData(step({ fs: spying, probe }))).toEqual({
      kind: "settled",
      state: "done",
    });
    expect(watch).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(snapshot(newDir)).toEqual(before);
  });

  it("stops at a damaged marker instead of guessing", () => {
    put(join(newDir, MARKER), "{ not json");
    oldFolder(oldDir);
    expect(moveIdentityData(step())).toMatchObject({ kind: "failed" });
    expect(readFileSync(join(newDir, MARKER), "utf8")).toBe("{ not json");
  });
});

describe("moving the passwords", () => {
  let root: string;
  let oldDir: string;
  let newDir: string;
  const alice: Credential = { kind: "password", username: "alice", password: "s3cret-alice" };
  const bob: Credential = { kind: "password", username: "bob", password: "s3cret-bob" };

  /** The vault as the new store would hold it; the real store is tested in adapter-secrets. */
  function credentialsStep(readOld: CredentialsStep["readOld"]) {
    const saved = new Map<string, Credential>();
    const replaceAll = vi.fn(async (all: Readonly<Record<string, Credential>>) => {
      saved.clear();
      for (const [id, c] of Object.entries(all)) saved.set(id, c);
    });
    const s: CredentialsStep = {
      newDir,
      fs: nodeFs,
      readOld,
      replaceAll,
      readBack: async (id) => saved.get(id) ?? null,
      parse: parseCredential,
      now: () => NOW,
    };
    return { s, saved, replaceAll };
  }
  const plain = (entries: OldPlainVault) => vi.fn(async () => entries);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "matters-identity-"));
    oldDir = join(root, "old");
    newDir = join(root, "new");
    oldFolder(oldDir, { credentials: false });
    put(
      join(oldDir, "credentials.json"),
      JSON.stringify({ version: 1, entries: { a: "ZW5jLWE=", b: "ZW5jLWI=" } }),
    );
    expect(
      moveIdentityData({ oldDir, newDir, fs: nodeFs, probe: free, now: () => NOW }),
    ).toMatchObject({ state: "credentials-pending" });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const marker = () => parseMarker(readFileSync(join(newDir, MARKER), "utf8"));

  it("decrypts under the old name, saves under the new one, then marks the move done", async () => {
    const before = snapshot(oldDir);
    const readOld = plain({ a: JSON.stringify(alice), b: JSON.stringify(bob) });
    const { s, saved } = credentialsStep(readOld);
    expect(await moveIdentityCredentials(s)).toEqual({ kind: "done", moved: 2, dropped: 0 });
    expect(readOld).toHaveBeenCalledWith(join(newDir, STAGED_CREDENTIALS), ["a", "b"]);
    expect(saved.get("a")).toEqual(alice);
    expect(saved.get("b")).toEqual(bob);
    expect(marker()?.state).toBe("done");
    expect(marker()?.from).toBe(oldDir);
    expect(existsSync(join(newDir, STAGED_CREDENTIALS))).toBe(false);
    expect(snapshot(oldDir)).toEqual(before);
    // The plain values went nowhere near the disk.
    for (const name of readdirSync(newDir)) {
      const path = join(newDir, name);
      if (lstatSync(path).isFile()) expect(readFileSync(path, "utf8")).not.toContain("s3cret");
    }
  });

  it("a crash between the data and the passwords: the app retries the passwords, never empty", async () => {
    const helperDied = vi.fn(async () => {
      throw new Error("the helper could not read the old passwords (exit 70)");
    });
    const { s, replaceAll } = credentialsStep(helperDied);
    expect(await moveIdentityCredentials(s)).toMatchObject({ kind: "failed" });
    expect(replaceAll).not.toHaveBeenCalled();
    expect(marker()?.state).toBe("credentials-pending");
    expect(existsSync(join(newDir, "credentials.json"))).toBe(false);
    expect(existsSync(join(newDir, STAGED_CREDENTIALS))).toBe(true);

    // The next start: the data step sees the marker and says the passwords are still pending.
    expect(moveIdentityData({ oldDir, newDir, fs: nodeFs, probe: free, now: () => NOW })).toEqual({
      kind: "settled",
      state: "credentials-pending",
    });
    const again = credentialsStep(plain({ a: JSON.stringify(alice), b: JSON.stringify(bob) }));
    expect(await moveIdentityCredentials(again.s)).toMatchObject({ kind: "done", moved: 2 });
  });

  it("a crash after the new vault was written but before the marker: written again, same content", async () => {
    const { s, replaceAll } = credentialsStep(
      plain({ a: JSON.stringify(alice), b: JSON.stringify(bob) }),
    );
    const failing: MigrationFs = {
      ...nodeFs,
      writeTextAtomic() {
        throw new Error("power cut");
      },
    };
    expect(await moveIdentityCredentials({ ...s, fs: failing })).toMatchObject({ kind: "failed" });
    expect(replaceAll).toHaveBeenCalledTimes(1);
    expect(marker()?.state).toBe("credentials-pending");
    expect(await moveIdentityCredentials(s)).toMatchObject({ kind: "done", moved: 2 });
    expect(replaceAll).toHaveBeenCalledTimes(2);
  });

  it("fails without writing when not one password can be read under the old name", async () => {
    const { s, replaceAll } = credentialsStep(plain({ a: null, b: null }));
    expect(await moveIdentityCredentials(s)).toEqual({
      kind: "failed",
      message: "none of the 2 saved passwords could be decrypted under the old name",
    });
    expect(replaceAll).not.toHaveBeenCalled();
    expect(marker()?.state).toBe("credentials-pending");
  });

  it("drops only a password the old app could not decrypt either", async () => {
    const { s, saved } = credentialsStep(plain({ a: JSON.stringify(alice), b: null }));
    expect(await moveIdentityCredentials(s)).toEqual({ kind: "done", moved: 1, dropped: 1 });
    expect([...saved.keys()]).toEqual(["a"]);
  });

  it("refuses a value that is not a credential", async () => {
    const { s } = credentialsStep(plain({ a: JSON.stringify({ kind: "nope" }), b: "{oops" }));
    expect(await moveIdentityCredentials(s)).toMatchObject({ kind: "failed" });
  });

  it("fails when what was saved does not read back", async () => {
    const { s } = credentialsStep(plain({ a: JSON.stringify(alice), b: JSON.stringify(bob) }));
    expect(await moveIdentityCredentials({ ...s, readBack: async () => null })).toMatchObject({
      kind: "failed",
      message: "a password did not read back after it was saved again",
    });
    expect(marker()?.state).toBe("credentials-pending");
  });

  it("an empty vault needs no helper", async () => {
    writeFileSync(join(newDir, STAGED_CREDENTIALS), JSON.stringify({ version: 1, entries: {} }));
    const readOld = plain({});
    const { s, replaceAll } = credentialsStep(readOld);
    expect(await moveIdentityCredentials(s)).toEqual({ kind: "done", moved: 0, dropped: 0 });
    expect(readOld).not.toHaveBeenCalled();
    expect(replaceAll).toHaveBeenCalledWith({});
  });

  it("runs only while the marker says the passwords are pending", async () => {
    const readOld = plain({ a: JSON.stringify(alice), b: JSON.stringify(bob) });
    const { s } = credentialsStep(readOld);
    await moveIdentityCredentials(s);
    readOld.mockClear();
    expect(await moveIdentityCredentials(s)).toMatchObject({ kind: "failed" });
    expect(readOld).not.toHaveBeenCalled();
  });
});
