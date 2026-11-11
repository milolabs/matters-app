import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bringForward,
  claimDatabase,
  type ForwardWindow,
  nodeOwnerFs,
  nodeProcessFacts,
  type Owner,
  type OwnerFs,
  ownerPath,
  ownerVerdict,
  type ProcessFacts,
  parseElapsed,
  parseOwner,
  START_TOLERANCE_MS,
  YOUNG_FILE_MS,
} from "../src/main/instanceLock.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");

const owner = (over: Partial<Owner> = {}): Owner => ({
  pid: 4242,
  startedAtMs: NOW - 60_000,
  host: "mac",
  token: "t-other",
  userData: "/data/other",
  ...over,
});

const facts = (over: Partial<ProcessFacts> = {}): ProcessFacts => ({
  pid: 100,
  host: "mac",
  nowMs: NOW,
  bootedAtMs: NOW - 3_600_000,
  alive: () => true,
  startedAtMs: () => NOW - 60_000,
  ...over,
});

describe("reading an owner file", () => {
  it("takes a complete record and nothing else", () => {
    expect(parseOwner(JSON.stringify(owner()))).toEqual(owner());
    expect(parseOwner("")).toBeNull();
    expect(parseOwner("{")).toBeNull();
    expect(parseOwner("null")).toBeNull();
    expect(parseOwner(JSON.stringify({ ...owner(), pid: "4242" }))).toBeNull();
    expect(parseOwner(JSON.stringify({ ...owner(), pid: 0 }))).toBeNull();
    expect(parseOwner(JSON.stringify({ ...owner(), pid: 1.5 }))).toBeNull();
    const { host: _host, ...noHost } = owner();
    expect(parseOwner(JSON.stringify(noHost))).toBeNull();
  });

  it("reads ps's elapsed time in every shape it prints", () => {
    expect(parseElapsed("   00:07\n")).toBe(7);
    expect(parseElapsed("12:34")).toBe(754);
    expect(parseElapsed("01:02:03")).toBe(3723);
    expect(parseElapsed("2-01:02:03")).toBe(2 * 86_400 + 3723);
    expect(parseElapsed("")).toBeNull();
    expect(parseElapsed("ELAPSED")).toBeNull();
    expect(parseElapsed("1:2:3:4")).toBeNull();
  });
});

describe("whether the owner still runs", () => {
  it("a live process that started when the file says is the owner", () => {
    expect(ownerVerdict(owner(), 50_000, facts())).toMatchObject({ kind: "held" });
    const near = facts({ startedAtMs: () => NOW - 60_000 + START_TOLERANCE_MS - 1 });
    expect(ownerVerdict(owner(), 50_000, near).kind).toBe("held");
  });

  it("a crashed run's file is stale: the process is gone", () => {
    expect(ownerVerdict(owner(), 50_000, facts({ alive: () => false }))).toEqual({
      kind: "stale",
      why: "process gone",
    });
  });

  it("a pid that now belongs to another process is stale", () => {
    const reused = facts({ startedAtMs: () => NOW - 5_000 });
    expect(ownerVerdict(owner(), 50_000, reused)).toMatchObject({ kind: "stale" });
    // This very process carries the crashed run's pid.
    expect(ownerVerdict(owner({ pid: 100 }), 50_000, facts())).toMatchObject({ kind: "stale" });
  });

  it("without a start time, only a restart since makes it stale", () => {
    const blind = facts({ startedAtMs: () => null });
    expect(ownerVerdict(owner(), 50_000, blind).kind).toBe("held");
    const beforeBoot = owner({ startedAtMs: NOW - 4 * 3_600_000 });
    expect(ownerVerdict(beforeBoot, 50_000, blind).kind).toBe("stale");
  });

  it("a file of another computer is never taken", () => {
    const verdict = ownerVerdict(
      owner({ host: "other-mac" }),
      50_000,
      facts({ alive: () => false }),
    );
    expect(verdict.kind).toBe("held");
  });

  it("an unreadable file is being written when young and left over when old", () => {
    expect(ownerVerdict(null, YOUNG_FILE_MS - 1, facts()).kind).toBe("held");
    expect(ownerVerdict(null, YOUNG_FILE_MS, facts()).kind).toBe("stale");
  });
});

describe("claiming the database", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "matters-owner-"));
    path = ownerPath(join(dir, "matters.db"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Each start is its own process: "a" is pid 100 and so on; `facts()` speaks as pid 100.
  const pids: Record<string, number> = { a: 101, b: 100, c: 102 };
  const me = (token: string): Owner =>
    owner({ pid: pids[token] ?? 100, token, userData: `/data/${token}` });
  const live = (o: Owner | null, age: number) => ownerVerdict(o, age, facts());
  const claim = (token: string, judge = live, fs: OwnerFs = nodeOwnerFs) =>
    claimDatabase({ path, me: me(token), fs, judge, nowMs: () => Date.now() });

  it("writes the owner next to the database and removes only its own file", () => {
    expect(path).toBe(join(dir, "matters.db.owner"));
    const first = claim("a");
    expect(first.kind).toBe("claimed");
    expect(parseOwner(readFileSync(path, "utf8"))?.token).toBe("a");
    // No temporary files stay behind.
    expect(readdirSync(dir)).toEqual(["matters.db.owner"]);
    if (first.kind === "claimed") {
      first.release();
      first.release();
    }
    expect(existsSync(path)).toBe(false);
  });

  it("a second copy is told who has it", () => {
    const first = claim("a");
    const second = claim("b");
    expect(second).toMatchObject({ kind: "held", owner: { token: "a", userData: "/data/a" } });
    expect(parseOwner(readFileSync(path, "utf8"))?.token).toBe("a");
    expect(first.kind).toBe("claimed");
  });

  it("takes over the file of a run that crashed", () => {
    writeFileSync(path, JSON.stringify(owner({ token: "crashed" })));
    const taken = claim("b", (o, age) => ownerVerdict(o, age, facts({ alive: () => false })));
    expect(taken.kind).toBe("claimed");
    expect(parseOwner(readFileSync(path, "utf8"))?.token).toBe("b");
    expect(readdirSync(dir)).toEqual(["matters.db.owner"]);
  });

  it("a release never removes a file a later start wrote", () => {
    const first = claim("a");
    writeFileSync(path, JSON.stringify(owner({ token: "later" })));
    if (first.kind === "claimed") first.release();
    expect(parseOwner(readFileSync(path, "utf8"))?.token).toBe("later");
  });

  it("puts back a live owner that took the file between the look and the move", () => {
    writeFileSync(path, JSON.stringify(owner({ token: "crashed" })));
    let raced = false;
    const racing: OwnerFs = {
      ...nodeOwnerFs,
      rename(from, to) {
        if (!raced) {
          raced = true;
          // Another start judged the same file stale and claimed the database first.
          rmSync(from);
          writeFileSync(from, JSON.stringify(owner({ token: "winner", pid: 777 })));
        }
        nodeOwnerFs.rename(from, to);
      },
    };
    const judge = (o: Owner | null, age: number) =>
      ownerVerdict(o, age, facts({ alive: (pid) => pid === 777, startedAtMs: () => NOW - 60_000 }));
    const result = claim("b", judge, racing);
    expect(result).toMatchObject({ kind: "held", owner: { token: "winner" } });
    expect(parseOwner(readFileSync(path, "utf8"))?.token).toBe("winner");
    expect(readdirSync(dir)).toEqual(["matters.db.owner"]);
  });

  it("of two starts that found the same stale file, one gets the database", () => {
    writeFileSync(path, JSON.stringify(owner({ token: "crashed" })));
    const deadCrash = (o: Owner | null, age: number) =>
      ownerVerdict(
        o,
        age,
        facts({ alive: (pid) => pid !== 4242, startedAtMs: () => NOW - 60_000 }),
      );
    let second: ReturnType<typeof claim> | undefined;
    const interleaved: OwnerFs = {
      ...nodeOwnerFs,
      rename(from, to) {
        nodeOwnerFs.rename(from, to);
        // Right after the first start moved the stale file away, the second one starts.
        if (!second) second = claim("c", deadCrash);
      },
    };
    const first = claim("b", deadCrash, interleaved);
    const results = [first.kind, second?.kind].sort();
    expect(results).toEqual(["claimed", "held"]);
    expect(readdirSync(dir)).toEqual(["matters.db.owner"]);
  });

  it("the real process facts know this process and a pid that is not there", () => {
    const real = nodeProcessFacts({
      pid: 1,
      host: "mac",
      nowMs: Date.now(),
      uptimeS: 100,
      platform: process.platform,
    });
    expect(real.alive(process.pid)).toBe(true);
    expect(real.alive(2 ** 22 + 12345)).toBe(false);
    if (process.platform === "darwin" || process.platform === "linux") {
      const started = real.startedAtMs(process.pid);
      expect(started).not.toBeNull();
      const created = Date.now() - process.uptime() * 1000;
      expect(Math.abs((started ?? 0) - created)).toBeLessThan(START_TOLERANCE_MS);
    }
  });
});

describe("a second start brings the first forward", () => {
  const fake = (state: { minimized?: boolean; visible?: boolean; destroyed?: boolean } = {}) => {
    const calls: string[] = [];
    const win: ForwardWindow = {
      isDestroyed: () => state.destroyed ?? false,
      isMinimized: () => state.minimized ?? false,
      isVisible: () => state.visible ?? true,
      restore: () => calls.push("restore"),
      show: () => calls.push("show"),
      focus: () => calls.push("focus"),
    };
    return { win, calls };
  };

  it("restores a minimised window, shows a hidden one, and focuses", () => {
    const activate = vi.fn();
    const minimised = fake({ minimized: true });
    expect(bringForward(minimised.win, true, activate)).toBe(true);
    expect(minimised.calls).toEqual(["restore", "focus"]);
    const hidden = fake({ visible: false });
    bringForward(hidden.win, true, activate);
    expect(hidden.calls).toEqual(["show", "focus"]);
    const plain = fake();
    bringForward(plain.win, true, activate);
    expect(plain.calls).toEqual(["focus"]);
    expect(activate).toHaveBeenCalledTimes(3);
  });

  it("does nothing before the window's first reveal, or without a window", () => {
    const activate = vi.fn();
    const early = fake({ visible: false });
    expect(bringForward(early.win, false, activate)).toBe(false);
    expect(early.calls).toEqual([]);
    expect(bringForward(null, true, activate)).toBe(false);
    expect(bringForward(fake({ destroyed: true }).win, true, activate)).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });
});
