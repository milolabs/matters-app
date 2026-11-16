import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialPort } from "@matters/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  listSetAside,
  nodeSwapFs,
  readPendingNotes,
  removeSetAside,
  restorePaths,
  type SwapFs,
  setAsidePath,
  swapPendingRestore,
} from "../src/main/restore.ts";
import { holdRestoredAccounts } from "../src/main/restoreHold.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dataFolder() {
  const dir = mkdtempSync(join(tmpdir(), "matters-restore-"));
  dirs.push(dir);
  const db = join(dir, "matters.db");
  return { dir, db, paths: restorePaths(db) };
}

const NOTES = {
  version: 1,
  setAside: "20261116T153000Z",
  holdAccounts: ["a2"],
  preparedAtMs: 1,
  messages: 3,
  accounts: 2,
  heldSends: 1,
};

/** The database in use with its log and shared memory, and a restore waiting. */
function withPending(t: ReturnType<typeof dataFolder>, notes: object = NOTES) {
  writeFileSync(t.db, "current");
  writeFileSync(`${t.db}-wal`, "current log");
  writeFileSync(`${t.db}-shm`, "current shm");
  writeFileSync(`${t.db}.owner`, "this run");
  mkdirSync(t.paths.dir, { recursive: true });
  writeFileSync(t.paths.pending, "restored");
  writeFileSync(t.paths.notes, JSON.stringify(notes));
}

/** Counts every call, and fails the one named. */
function counting(failOn?: (call: string, a: string, b?: string) => boolean) {
  const calls: string[] = [];
  const fs: SwapFs = {
    exists: (p) => {
      calls.push(`exists ${p}`);
      return nodeSwapFs.exists(p);
    },
    read: (p) => {
      calls.push(`read ${p}`);
      return nodeSwapFs.read(p);
    },
    write: (p, text) => {
      calls.push(`write ${p}`);
      nodeSwapFs.write(p, text);
    },
    rename: (a, b) => {
      calls.push(`rename ${a}`);
      if (failOn?.("rename", a, b)) throw Object.assign(new Error("refused"), { code: "EACCES" });
      nodeSwapFs.rename(a, b);
    },
    mkdir: (p) => {
      calls.push(`mkdir ${p}`);
      nodeSwapFs.mkdir(p);
    },
    remove: (p) => {
      calls.push(`remove ${p}`);
      nodeSwapFs.remove(p);
    },
  };
  return { fs, calls };
}

describe("the swap at start (ADR 0145, rule 9)", () => {
  it("costs one look when no restore waits, and touches nothing", () => {
    const t = dataFolder();
    writeFileSync(t.db, "current");
    const c = counting();
    expect(swapPendingRestore(t.db, c.fs)).toEqual({ kind: "none" });
    expect(c.calls).toEqual([`exists ${t.paths.pending}`]);
    expect(readdirSync(t.dir)).toEqual(["matters.db"]);
  });

  it("moves the database's set aside together, puts the backup in place, and holds the accounts first", () => {
    const t = dataFolder();
    withPending(t);
    const c = counting();
    expect(swapPendingRestore(t.db, c.fs)).toEqual({
      kind: "swapped",
      setAside: "20261116T153000Z",
      held: ["a2"],
    });
    expect(readFileSync(t.db, "utf8")).toBe("restored");
    // Nothing of the database before is left beside the restored one.
    expect(existsSync(`${t.db}-wal`)).toBe(false);
    expect(existsSync(`${t.db}-shm`)).toBe(false);
    // The claim of this run stays where it is.
    expect(readFileSync(`${t.db}.owner`, "utf8")).toBe("this run");
    const aside = join(t.paths.setAside, "20261116T153000Z");
    expect(readFileSync(join(aside, "matters.db"), "utf8")).toBe("current");
    expect(readFileSync(join(aside, "matters.db-wal"), "utf8")).toBe("current log");
    expect(readFileSync(join(aside, "matters.db-shm"), "utf8")).toBe("current shm");
    expect(JSON.parse(readFileSync(t.paths.held, "utf8"))).toEqual(["a2"]);
    expect(existsSync(t.paths.pending)).toBe(false);
    expect(existsSync(t.paths.notes)).toBe(false);
    // The held list is written before the first rename.
    const write = c.calls.findIndex((x) => x.startsWith(`write ${t.paths.held}`));
    const firstRename = c.calls.findIndex((x) => x.startsWith("rename"));
    expect(write).toBeGreaterThanOrEqual(0);
    expect(write).toBeLessThan(firstRename);
  });

  it("leaves the database in use as it was when the swap fails, and the restore still waits", () => {
    const t = dataFolder();
    withPending(t);
    writeFileSync(t.paths.held, JSON.stringify(["older"]));
    const c = counting((call, from) => call === "rename" && from === t.paths.pending);
    const outcome = swapPendingRestore(t.db, c.fs);
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(readFileSync(t.db, "utf8")).toBe("current");
    expect(readFileSync(`${t.db}-wal`, "utf8")).toBe("current log");
    expect(readFileSync(`${t.db}-shm`, "utf8")).toBe("current shm");
    expect(readFileSync(t.paths.pending, "utf8")).toBe("restored");
    expect(JSON.parse(readFileSync(t.paths.held, "utf8"))).toEqual(["older"]);
    expect(readdirSync(join(t.paths.setAside, "20261116T153000Z"))).toEqual([]);
  });

  it("continues a swap a start broke off, into the same folder", () => {
    const t = dataFolder();
    withPending(t);
    // The last start moved the log and stopped.
    const aside = join(t.paths.setAside, "20261116T153000Z");
    mkdirSync(aside, { recursive: true });
    nodeSwapFs.rename(`${t.db}-wal`, join(aside, "matters.db-wal"));
    expect(swapPendingRestore(t.db)).toMatchObject({ kind: "swapped" });
    expect(readFileSync(t.db, "utf8")).toBe("restored");
    expect(readdirSync(aside).sort()).toEqual(["matters.db", "matters.db-shm", "matters.db-wal"]);
  });

  it("does not run on notes it cannot read", () => {
    const t = dataFolder();
    withPending(t, { version: 1, setAside: "../../escape", holdAccounts: [] });
    expect(swapPendingRestore(t.db)).toMatchObject({ kind: "failed" });
    expect(readFileSync(t.db, "utf8")).toBe("current");
    expect(readPendingNotes("not json")).toBeNull();
    expect(readPendingNotes(JSON.stringify(NOTES))).toEqual(NOTES);
  });
});

describe("set-aside databases (ADR 0145, rule 9)", () => {
  it("are listed newest first with their size, and removed by a name of ours only", async () => {
    const t = dataFolder();
    for (const name of ["20261110T100000Z", "20261116T153000Z"]) {
      mkdirSync(join(t.paths.setAside, name), { recursive: true });
      writeFileSync(join(t.paths.setAside, name, "matters.db"), "12345");
      writeFileSync(join(t.paths.setAside, name, "matters.db-wal"), "678");
    }
    mkdirSync(join(t.paths.setAside, "not-ours"), { recursive: true });
    expect(await listSetAside(t.db)).toEqual([
      { name: "20261116T153000Z", atMs: Date.UTC(2026, 10, 16, 15, 30), bytes: 8 },
      { name: "20261110T100000Z", atMs: Date.UTC(2026, 10, 10, 10), bytes: 8 },
    ]);
    expect(setAsidePath(t.db, "../../etc")).toBeNull();
    expect(await removeSetAside(t.db, "../..")).toBe(false);
    expect(await removeSetAside(t.db, "20261110T100000Z")).toBe(true);
    expect((await listSetAside(t.db)).map((s) => s.name)).toEqual(["20261116T153000Z"]);
    expect(existsSync(t.db)).toBe(false);
  });
});

describe("credentials held back after a restore (ADR 0145, rule 9)", () => {
  const credential: Credential = { kind: "password", username: "me", password: "pw" };
  function vault(): CredentialPort & { entries: Map<string, Credential> } {
    const entries = new Map<string, Credential>([
      ["a1", credential],
      ["a2", credential],
    ]);
    return {
      entries,
      availability: async () => ({ available: true }) as never,
      get: async (id) => entries.get(id) ?? null,
      set: async (id, c) => void entries.set(id, c),
      delete: async (id) => void entries.delete(id),
      move: async (from, to) => {
        const c = entries.get(from);
        if (c) entries.set(to, c);
        entries.delete(from);
      },
    };
  }

  it("answers a held account as having nothing saved, until a new one is saved for it", async () => {
    let list: readonly string[] = ["a2"];
    let reads = 0;
    const held = holdRestoredAccounts(vault(), {
      read: async () => {
        reads++;
        return list;
      },
      write: async (ids) => {
        list = ids;
      },
    });
    expect(await held.get("a1")).toEqual(credential);
    expect(await held.get("a2")).toBeNull();
    await held.set("a2", { ...credential, password: "new" });
    expect(await held.get("a2")).toMatchObject({ password: "new" });
    expect(list).toEqual([]);
    // Read once, when first asked.
    expect(reads).toBe(1);
  });

  it("lets a removed account or a sign-in moved onto it go free too", async () => {
    let list: readonly string[] = ["a1", "a2"];
    const held = holdRestoredAccounts(vault(), {
      read: async () => list,
      write: async (ids) => {
        list = ids;
      },
    });
    await held.delete("a1");
    await held.move("a1", "a2");
    expect(list).toEqual([]);
  });
});
