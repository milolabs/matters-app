import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DownloadLimits,
  INSTALL_IDLE,
  type InstallEvent,
  type InstallFailure,
  nextInstall,
} from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InstallDeps, type RunResult, runInstall } from "../src/main/install.ts";
import {
  type DownloadRequestLike,
  type DownloadResponseLike,
  downloadToFile,
  sha256File,
} from "../src/main/installDownload.ts";
import { Installer, runProgram } from "../src/main/installer.ts";
import {
  clearLeftovers,
  releaseLock,
  SWAP_SCRIPT,
  startSwap,
  takeLock,
} from "../src/main/installSwap.ts";
import { afterCheck, DEFAULT_RELEASE, releaseInfo } from "../src/main/release.ts";
import { readReleaseInfo } from "../src/main/releaseShapes.ts";
import { createReleaseBridge } from "../src/preload/releaseBridge.ts";

// ADR 0140: installing a newer version when the person asks. The downloads and their limits, the
// steps and checks in the order of site/install.sh, the folder's lock and the swap against
// temporary folders with a stand-in bundle, and what crosses to a page.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "matters-install-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LIMITS: DownloadLimits = { bytes: 64, ms: 5_000, idleMs: 5_000 };

class FakeResponse extends EventEmitter implements DownloadResponseLike {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[]>;
  constructor(statusCode: number, headers: Record<string, string | string[]> = {}) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
  }
}
class FakeRequest extends EventEmitter implements DownloadRequestLike {
  headers: Record<string, string> = {};
  aborted = false;
  followed = 0;
  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  followRedirect() {
    this.followed += 1;
  }
  abort() {
    this.aborted = true;
  }
  end() {}
}

describe("a download (rule 3)", () => {
  const run = (
    play: (req: FakeRequest) => void,
    limits: DownloadLimits = LIMITS,
    signal = new AbortController().signal,
  ) => {
    const req = new FakeRequest();
    const path = join(dir, "file");
    const seen: [number, number | null][] = [];
    const done = downloadToFile(
      {
        open: () => {
          setTimeout(() => play(req), 0);
          return req;
        },
      },
      "https://github.com/milolabs/matters-app/releases/download/v0.1.0-alpha.5/x",
      path,
      limits,
      (received, total) => seen.push([received, total]),
      signal,
    );
    return { req, done, path, seen };
  };
  const body = (req: FakeRequest, chunks: string[], headers = {}) => {
    const res = new FakeResponse(200, headers);
    req.emit("response", res);
    for (const c of chunks) res.emit("data", Buffer.from(c));
    res.emit("end");
  };

  it("writes the file, follows a redirect to GitHub's host, and says only `Matters`", async () => {
    const { req, done, path, seen } = run((r) => {
      r.emit(
        "redirect",
        302,
        "GET",
        "https://release-assets.githubusercontent.com/github-production-release-asset/1/x?a=b",
      );
      body(r, ["hello ", "world"], { "content-length": "11" });
    });
    expect(await done).toEqual({ ok: true, bytes: 11 });
    expect(readFileSync(path, "utf8")).toBe("hello world");
    expect(req.followed).toBe(1);
    expect(req.headers).toEqual({ "User-Agent": "Matters" });
    expect(seen.at(-1)).toEqual([11, 11]);
  });

  it("refuses a redirect elsewhere, too many redirects, a status, and too much", async () => {
    const elsewhere = run((r) => r.emit("redirect", 302, "GET", "https://evil.test/x.dmg"));
    expect(await elsewhere.done).toEqual({ ok: false, failure: "redirect" });
    expect(elsewhere.req.followed).toBe(0);
    expect(elsewhere.req.aborted).toBe(true);
    const loop = run((r) => {
      for (let n = 0; n < 4; n++) {
        r.emit("redirect", 302, "GET", "https://release-assets.githubusercontent.com/a");
      }
    });
    expect(await loop.done).toEqual({ ok: false, failure: "redirect" });
    const status = run((r) => r.emit("response", new FakeResponse(404)));
    expect(await status.done).toEqual({ ok: false, failure: "status" });
    const said = run((r) => r.emit("response", new FakeResponse(200, { "content-length": "65" })));
    expect(await said.done).toEqual({ ok: false, failure: "too-big" });
    const grew = run((r) => body(r, ["x".repeat(40), "x".repeat(40)]));
    expect(await grew.done).toEqual({ ok: false, failure: "too-big" });
    expect(existsSync(grew.path)).toBe(false);
  });

  it("removes a file that came short, and stops on silence, on time and on cancel", async () => {
    const short = run((r) => body(r, ["abc"], { "content-length": "10" }));
    expect(await short.done).toEqual({ ok: false, failure: "download" });
    expect(existsSync(short.path)).toBe(false);
    const broken = run((r) => r.emit("error", new Error("net::ERR_CONNECTION_RESET")));
    expect(await broken.done).toEqual({ ok: false, failure: "download" });
    const silent = run(() => {}, { bytes: 64, ms: 5_000, idleMs: 20 });
    expect(await silent.done).toEqual({ ok: false, failure: "timeout" });
    const slow = run(
      (r) => {
        const res = new FakeResponse(200);
        r.emit("response", res);
        const tick = setInterval(() => res.emit("data", Buffer.from("x")), 5);
        setTimeout(() => clearInterval(tick), 200);
      },
      { bytes: 1_000_000, ms: 40, idleMs: 1_000 },
    );
    expect(await slow.done).toEqual({ ok: false, failure: "timeout" });
    const abort = new AbortController();
    const cancelled = run(
      (r) => {
        const res = new FakeResponse(200, { "content-length": "20" });
        r.emit("response", res);
        res.emit("data", Buffer.from("half"));
        abort.abort();
      },
      LIMITS,
      abort.signal,
    );
    expect(await cancelled.done).toEqual({ ok: false, failure: "cancelled" });
    expect(cancelled.req.aborted).toBe(true);
    expect(existsSync(cancelled.path)).toBe(false);
  });

  it("fails, and leaves no file, when the file cannot be written after the last byte came", async () => {
    // The folder is not there, so the file cannot be opened; the body has ended before that is known.
    const req = new FakeRequest();
    const path = join(dir, "missing", "file");
    const done = downloadToFile(
      {
        open: () => {
          setTimeout(() => body(req, ["abc"], { "content-length": "3" }), 0);
          return req;
        },
      },
      "https://github.com/milolabs/matters-app/releases/download/v0.1.0-alpha.5/x",
      path,
      LIMITS,
      () => {},
      new AbortController().signal,
    );
    expect(await done).toEqual({ ok: false, failure: "download" });
    expect(existsSync(path)).toBe(false);
  });

  it("hashes a file on disk", async () => {
    const path = join(dir, "abc");
    writeFileSync(path, "abc");
    expect(await sha256File(path)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

const VERSION = "0.1.0-alpha.5";
const IMAGE = `Matters-${VERSION}-arm64.dmg`;
const SUM = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/** Stand-ins for every side effect of an install, keeping what was asked in order. */
function fakeDeps(over: Partial<InstallDeps> & { gh?: string | null; sums?: string } = {}) {
  const did: string[] = [];
  const events: InstallEvent[] = [];
  const ok: RunResult = { code: 0, stdout: "" };
  const deps: InstallDeps = {
    download: async (url, path) => {
      did.push(`download ${url.split("/").at(-1)}`);
      writeFileSync(
        path,
        url.endsWith("SHA256SUMS.txt") ? (over.sums ?? `${SUM}  ${IMAGE}\n`) : "abc",
      );
      return { ok: true, bytes: 3 };
    },
    sha256: async () => SUM,
    readText: (path) => readFileSync(path, "utf8"),
    run: async (file, args) => {
      const name = file.split("/").at(-1);
      const first = String(args[0]).startsWith("/") ? "" : ` ${args[0]}`;
      did.push(`${name}${first}${file.endsWith("plutil") ? ` ${args[1]}` : ""}`);
      if (file.endsWith("plutil")) {
        return {
          code: 0,
          stdout: args[1] === "CFBundleIdentifier" ? "app.getmatters.Matters\n" : `${VERSION}\n`,
        };
      }
      return ok;
    },
    runGh: async (_file, args) => {
      did.push(`gh ${args.slice(0, 2).join(" ")}`);
      return ok;
    },
    findGh: () => (over.gh === undefined ? null : over.gh),
    isDirectory: () => true,
    makeWork: () => mkdtempSync(join(dir, "work-")),
    removeWork: (path) => {
      did.push("remove work");
      rmSync(path, { recursive: true, force: true });
    },
    takeLock: () => {
      did.push("lock");
      return "taken";
    },
    clearLeftovers: () => {},
    releaseLock: () => did.push("unlock"),
    removeTree: (path) =>
      did.push(
        path.endsWith(".installing") ? "remove incoming" : `remove ${path.split("/").at(-1)}`,
      ),
    startSwap: async () => {
      did.push("swap");
      return true;
    },
    step: (event) => events.push(event),
    ...over,
  };
  return { deps, did, events };
}

const ask = (over: Partial<Parameters<typeof runInstall>[1]> = {}) => ({
  version: VERSION,
  running: "0.1.0-alpha.4",
  folder: join(dir, "Applications"),
  pid: 1,
  signal: new AbortController().signal,
  ...over,
});

describe("an install, in the order of site/install.sh (rules 3 and 4)", () => {
  it("downloads, checks, opens the image, takes the lock, copies, checks the copy, swaps", async () => {
    const { deps, did, events } = fakeDeps({ gh: "/opt/homebrew/bin/gh" });
    expect(await runInstall(deps, ask())).toBeNull();
    expect(did).toEqual([
      `download ${IMAGE}`,
      "download SHA256SUMS.txt",
      `download ${IMAGE}.intoto.jsonl`,
      "gh attestation verify",
      "hdiutil attach",
      "lock",
      "ditto",
      "codesign --verify",
      "plutil -extract CFBundleIdentifier",
      "plutil -extract CFBundleShortVersionString",
      "hdiutil detach",
      "swap",
      "remove work",
    ]);
    // The helper holds the lock now: main neither releases it nor removes the new app.
    expect(did).not.toContain("unlock");
    expect(events.map((e) => e.kind)).toEqual(["check", "check", "install", "restart"]);
    expect(events[2]).toEqual({ kind: "install", recorded: true });
  });

  it("without gh, says the build record was not checked", async () => {
    const { deps, did, events } = fakeDeps({ gh: null });
    expect(await runInstall(deps, ask())).toBeNull();
    expect(did.some((d) => d.startsWith("gh"))).toBe(false);
    expect(events).toContainEqual({ kind: "install", recorded: false });
  });

  const stops = async (
    failure: InstallFailure,
    over: Parameters<typeof fakeDeps>[0],
    asked: Partial<Parameters<typeof runInstall>[1]> = {},
  ) => {
    const { deps, did } = fakeDeps(over);
    expect(await runInstall(deps, ask(asked))).toBe(failure);
    expect(did).not.toContain("swap");
    expect(did.at(-1)).toBe("remove work");
    return did;
  };

  it("refuses a downgrade and the same version before it downloads anything", async () => {
    for (const version of ["0.1.0-alpha.3", "0.1.0-alpha.4", "0.1.0-alpha.5+x"]) {
      const { deps, did } = fakeDeps();
      expect(await runInstall(deps, ask({ version }))).toBe("older");
      expect(did).toEqual([]);
    }
  });

  it("stops at a missing line or a wrong checksum, before the folder is touched", async () => {
    const missing = await stops("sums", { sums: `${SUM}  other.dmg\n` });
    expect(missing).not.toContain("lock");
    expect(missing).not.toContain("hdiutil attach");
    const wrong = await stops("checksum", { sha256: async () => "0".repeat(64) });
    expect(wrong).not.toContain("lock");
  });

  it("stops when gh cannot confirm the build", async () => {
    const did = await stops("build-record", {
      gh: "/usr/local/bin/gh",
      runGh: async () => ({ code: 1, stdout: "" }),
    });
    expect(did).not.toContain("hdiutil attach");
  });

  it("stops at a failed download and passes on why", async () => {
    await stops("redirect", { download: async () => ({ ok: false, failure: "redirect" }) });
    await stops("cancelled", { download: async () => ({ ok: false, failure: "cancelled" }) });
  });

  it("respects another install's lock, and touches nothing of the folder then", async () => {
    const did = await stops("locked", { takeLock: () => "held" });
    expect(did).not.toContain("ditto");
    expect(did).not.toContain("unlock");
    expect(did).toContain("hdiutil detach");
  });

  it("removes the copy and releases the lock when a check of the copy fails", async () => {
    const run = async (file: string, args: readonly string[]): Promise<RunResult> =>
      file.endsWith("codesign") ? { code: 1, stdout: "" } : { code: 0, stdout: String(args[0]) };
    const did = await stops("signature", { run });
    expect(did.slice(-3)).toEqual(["remove incoming", "unlock", "remove work"]);
    const other = await stops("not-matters", {
      run: async (file, args) =>
        file.endsWith("plutil")
          ? { code: 0, stdout: args[1] === "CFBundleIdentifier" ? "com.evil.App" : VERSION }
          : { code: 0, stdout: "" },
    });
    expect(other).toContain("unlock");
    const older = await stops("not-matters", {
      run: async (file, args) =>
        file.endsWith("plutil")
          ? {
              code: 0,
              stdout: args[1] === "CFBundleIdentifier" ? "app.getmatters.Matters" : "0.1.0-alpha.3",
            }
          : { code: 0, stdout: "" },
    });
    expect(older).toContain("unlock");
    const noHelper = await stops("restart", { startSwap: async () => false });
    expect(noHelper).toContain("unlock");
  });

  it("runs every step of the cleanup when one throws, and keeps why it stopped", async () => {
    const did = await stops("signature", {
      run: async (file) => ({ code: file.endsWith("codesign") ? 1 : 0, stdout: "" }),
      removeTree: () => {
        throw new Error("EBUSY");
      },
    });
    expect(did.slice(-2)).toEqual(["unlock", "remove work"]);
    const unlocked = await stops("signature", {
      run: async (file) => ({ code: file.endsWith("codesign") ? 1 : 0, stdout: "" }),
      releaseLock: () => {
        throw new Error("EACCES");
      },
    });
    expect(unlocked.at(-1)).toBe("remove work");
  });

  it("does not start the helper while the image stays open, and leaves its folder alone", async () => {
    const { deps, did } = fakeDeps();
    // The checks of the copy pass; only closing the image fails.
    deps.run = async (file, args) => {
      did.push(`${file.split("/").at(-1)} ${args[0]}`);
      if (file.endsWith("hdiutil")) return { code: args[0] === "detach" ? 1 : 0, stdout: "" };
      if (file.endsWith("plutil")) {
        return {
          code: 0,
          stdout: args[1] === "CFBundleIdentifier" ? "app.getmatters.Matters" : VERSION,
        };
      }
      return { code: 0, stdout: "" };
    };
    expect(await runInstall(deps, ask())).toBe("image");
    expect(did).not.toContain("swap");
    // Tried, then by force, and not again.
    expect(did.filter((d) => d === "hdiutil detach")).toHaveLength(2);
    expect(did).toContain("remove incoming");
    expect(did).toContain("unlock");
    // The downloads go; the folder the image is open in stays.
    expect(did).toContain(`remove ${IMAGE}`);
    expect(did).toContain("remove SHA256SUMS.txt");
    expect(did).not.toContain("remove work");
  });

  it("stops the copy when the app quits, cleans up, and never stops closing the image", async () => {
    const abort = new AbortController();
    const signals: [string, AbortSignal | undefined][] = [];
    const { deps, did } = fakeDeps({
      run: (file, args, _ms, signal) => {
        const name = file.split("/").at(-1) ?? "";
        did.push(`${name} ${String(args[0]).startsWith("/") ? "" : args[0]}`.trim());
        signals.push([`${name} ${args[0]}`, signal]);
        if (name !== "ditto") return Promise.resolve({ code: 0, stdout: "" });
        // A long copy: it ends only when it is stopped.
        setTimeout(() => abort.abort(), 0);
        return new Promise((resolve) =>
          signal?.addEventListener("abort", () => resolve({ code: null, stdout: "" })),
        );
      },
    });
    expect(await runInstall(deps, ask({ signal: abort.signal }))).toBe("cancelled");
    // The app's folder is cleaned before the image is closed, which may take longer than a quit waits.
    expect(did.slice(-4)).toEqual(["remove incoming", "unlock", "hdiutil detach", "remove work"]);
    expect(signals.find(([n]) => n.startsWith("ditto"))?.[1]).toBe(abort.signal);
    for (const [name, signal] of signals) {
      if (name.startsWith("hdiutil")) expect(signal).toBeUndefined();
    }
  });

  it("does not start the helper when the app quit while the image was closing", async () => {
    const abort = new AbortController();
    const { deps, did } = fakeDeps();
    deps.run = async (file, args) => {
      did.push(`${file.split("/").at(-1)} ${args[0]}`);
      if (file.endsWith("hdiutil") && args[0] === "detach") abort.abort();
      if (file.endsWith("plutil")) {
        return {
          code: 0,
          stdout: args[1] === "CFBundleIdentifier" ? "app.getmatters.Matters" : VERSION,
        };
      }
      return { code: 0, stdout: "" };
    };
    expect(await runInstall(deps, ask({ signal: abort.signal }))).toBe("cancelled");
    expect(did).not.toContain("swap");
    expect(did).toContain("remove incoming");
    expect(did).toContain("unlock");
  });

  it("stops a program it runs when asked", async () => {
    const abort = new AbortController();
    const started = Date.now();
    const done = runProgram("/bin/sleep", ["30"], 60_000, { PATH: "/usr/bin:/bin" }, abort.signal);
    setTimeout(() => abort.abort(), 50);
    expect((await done).code).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("says when the image does not open or holds no app", async () => {
    await stops("image", {
      run: async (file) => ({ code: file.endsWith("hdiutil") ? 1 : 0, stdout: "" }),
    });
    const empty = await stops("image", { isDirectory: () => false });
    expect(empty).toContain("hdiutil detach");
  });
});

describe("one install at a time, and Cancel (rules 1 and 5)", () => {
  const newer = {
    version: VERSION,
    stage: "alpha",
    dateMs: null,
    download: null,
    notes: null,
  };

  it("starts only where it can, only for a newer version, and once", async () => {
    let quit = 0;
    let release: () => void = () => {};
    const told: boolean[] = [];
    const installer = new Installer({
      place: () => ({ ok: true, folder: join(dir, "Applications") }),
      deps: (step) =>
        fakeDeps({
          step,
          download: (_u, path) =>
            new Promise((resolve) => {
              writeFileSync(path, `${SUM}  ${IMAGE}\n`);
              release = () => resolve({ ok: true, bytes: 3 });
            }),
        }).deps,
      running: () => "0.1.0-alpha.4",
      pid: () => 1,
      told: (progress) => told.push(progress),
      quit: () => {
        quit += 1;
      },
    });
    // Before Settings opened, where this copy is is not known: nothing starts.
    expect(installer.start(newer)).toBe(false);
    installer.knowPlace();
    expect(installer.start(null)).toBe(false);
    expect(installer.start({ ...newer, version: "0.1.0-alpha.4" })).toBe(false);
    expect(installer.start(newer)).toBe(true);
    expect(installer.view().state.step).toBe("downloading");
    expect(installer.start(newer)).toBe(false);
    release();
    await new Promise((r) => setTimeout(r, 0));
    release();
    for (let n = 0; n < 100 && quit === 0; n++) await new Promise((r) => setTimeout(r, 10));
    expect(installer.view().state.step).toBe("restarting");
    expect(quit).toBe(1);
    expect(told.length).toBeGreaterThan(0);
  });

  it("cancels while it downloads, and nothing is installed", async () => {
    const installer = new Installer({
      place: () => ({ ok: true, folder: join(dir, "Applications") }),
      deps: (step) =>
        fakeDeps({
          step,
          download: (_u, _p, _l, _progress, signal) =>
            new Promise((resolve) =>
              signal.addEventListener("abort", () => resolve({ ok: false, failure: "cancelled" })),
            ),
        }).deps,
      running: () => "0.1.0-alpha.4",
      pid: () => 1,
      told: () => {},
      quit: () => {
        throw new Error("must not quit");
      },
    });
    installer.knowPlace();
    expect(installer.start(newer)).toBe(true);
    installer.cancel();
    await installer.settle(1_000);
    expect(installer.view().state).toEqual({
      step: "failed",
      version: VERSION,
      failure: "cancelled",
    });
    expect(installer.busy()).toBe(false);
  });

  it("starts nothing once the app has begun to quit", async () => {
    const installer = new Installer({
      place: () => ({ ok: true, folder: join(dir, "Applications") }),
      deps: () => fakeDeps().deps,
      running: () => "0.1.0-alpha.4",
      pid: () => 1,
      told: () => {},
      quit: () => {},
    });
    installer.knowPlace();
    await installer.settle(1_000);
    expect(installer.start(newer)).toBe(false);
    expect(installer.view().state).toEqual(INSTALL_IDLE);
  });

  it("installs the version it was started with, whatever is asked while it runs", async () => {
    const urls: string[] = [];
    let release: () => void = () => {};
    const installer = new Installer({
      place: () => ({ ok: true, folder: join(dir, "Applications") }),
      deps: (step) =>
        fakeDeps({
          step,
          download: (url, path) => {
            urls.push(url);
            writeFileSync(path, `${SUM}  ${IMAGE}\n`);
            return new Promise((resolve) => {
              release = () => resolve({ ok: true, bytes: 3 });
            });
          },
        }).deps,
      running: () => "0.1.0-alpha.4",
      pid: () => 1,
      told: () => {},
      quit: () => {},
    });
    installer.knowPlace();
    expect(installer.start(newer)).toBe(true);
    // A check since found another version: it starts nothing, and the one under way stays.
    expect(installer.start({ ...newer, version: "0.1.0-alpha.6" })).toBe(false);
    for (let n = 0; n < 5; n++) {
      release();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toContain(`/v${VERSION}/`);
    expect(installer.view().state).toMatchObject({ version: VERSION });
  });

  it("refuses where this copy cannot be replaced", () => {
    const installer = new Installer({
      place: () => ({ ok: false, why: "translocated" }),
      deps: () => fakeDeps().deps,
      running: () => "0.1.0-alpha.4",
      pid: () => 1,
      told: () => {},
      quit: () => {},
    });
    installer.knowPlace();
    expect(installer.start(newer)).toBe(false);
  });
});

describe("the folder's lock (ADR 0139, rule 5)", () => {
  it("is taken once, and a lock that is there is never taken over", () => {
    expect(takeLock(dir)).toBe("taken");
    expect(takeLock(dir)).toBe("held");
    releaseLock(dir);
    expect(takeLock(dir)).toBe("taken");
    expect(takeLock(join(dir, "missing"))).toBe("failed");
  });

  it("puts back an old app a killed install left aside, and clears the copies beside it", () => {
    mkdirSync(join(dir, ".Matters.app.previous"));
    writeFileSync(join(dir, ".Matters.app.previous", "version"), "old");
    mkdirSync(join(dir, ".Matters.app.installing"));
    clearLeftovers(dir);
    expect(readFileSync(join(dir, "Matters.app", "version"), "utf8")).toBe("old");
    expect(existsSync(join(dir, ".Matters.app.previous"))).toBe(false);
    expect(existsSync(join(dir, ".Matters.app.installing"))).toBe(false);
  });
});

// The helper is plain bash; it runs here as main starts it, with a stand-in bundle and a
// stand-in `open` that only writes down what it was asked to open.
const bash = spawnSync("/bin/bash", ["-c", "true"]).status === 0;
describe.skipIf(!bash)("the swap, after the app has quit (rule 4)", () => {
  /** A folder with an old and a new app, the lock held, and a bin of stand-ins. */
  function folder() {
    const dest = join(dir, "Applications");
    mkdirSync(join(dest, "Matters.app"), { recursive: true });
    writeFileSync(join(dest, "Matters.app", "version"), "old");
    mkdirSync(join(dest, ".Matters.app.installing"));
    writeFileSync(join(dest, ".Matters.app.installing", "version"), "new");
    mkdirSync(join(dest, ".Matters.app.lock"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const opened = join(dir, "opened.txt");
    writeFileSync(join(bin, "open"), `#!/bin/bash\nprintf '%s\\n' "$1" >> "${opened}"\n`);
    chmodSync(join(bin, "open"), 0o755);
    return { dest, bin, opened };
  }
  /** Runs the helper as main does, for a process that has already ended. */
  function swap(dest: string, bin: string, pid = 2_147_483_000): number | null {
    return spawnSync("/bin/bash", ["-c", SWAP_SCRIPT, "matters-swap", String(pid), dest], {
      env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` },
      cwd: "/",
    }).status;
  }
  const version = (dest: string) => readFileSync(join(dest, "Matters.app", "version"), "utf8");

  it("puts the new app in place, removes the old one and the lock, and opens it", () => {
    const { dest, bin, opened } = folder();
    expect(swap(dest, bin)).toBe(0);
    expect(version(dest)).toBe("new");
    expect(existsSync(join(dest, ".Matters.app.previous"))).toBe(false);
    expect(existsSync(join(dest, ".Matters.app.installing"))).toBe(false);
    expect(existsSync(join(dest, ".Matters.app.lock"))).toBe(false);
    expect(readFileSync(opened, "utf8")).toBe(`${join(dest, "Matters.app")}\n`);
  });

  it("moves the old app back and opens it when the new one cannot be put in place", () => {
    const { dest, bin, opened } = folder();
    // A stand-in `mv` that refuses to move the new app; every other move is the real one.
    writeFileSync(
      join(bin, "mv"),
      `#!/bin/bash\ncase "$1" in *.Matters.app.installing) exit 1;; esac\nexec /bin/mv "$@"\n`,
    );
    chmodSync(join(bin, "mv"), 0o755);
    expect(swap(dest, bin)).toBe(7);
    expect(version(dest)).toBe("old");
    expect(existsSync(join(dest, ".Matters.app.previous"))).toBe(false);
    expect(existsSync(join(dest, ".Matters.app.installing"))).toBe(false);
    expect(existsSync(join(dest, ".Matters.app.lock"))).toBe(false);
    expect(readFileSync(opened, "utf8")).toBe(`${join(dest, "Matters.app")}\n`);
  });

  it("leaves the old app as it is when it cannot be moved aside", () => {
    const { dest, bin, opened } = folder();
    writeFileSync(
      join(bin, "mv"),
      `#!/bin/bash\ncase "$2" in *.Matters.app.previous) exit 1;; esac\nexec /bin/mv "$@"\n`,
    );
    chmodSync(join(bin, "mv"), 0o755);
    expect(swap(dest, bin)).toBe(6);
    expect(version(dest)).toBe("old");
    expect(existsSync(join(dest, ".Matters.app.installing"))).toBe(false);
    expect(existsSync(join(dest, ".Matters.app.lock"))).toBe(false);
    expect(readFileSync(opened, "utf8")).toBe(`${join(dest, "Matters.app")}\n`);
  });

  it("waits for the app's process to end before it swaps", async () => {
    const { dest, bin } = folder();
    const app = spawn("/bin/sleep", ["0.6"]);
    const started = Date.now();
    const helper = spawn("/bin/bash", ["-c", SWAP_SCRIPT, "matters-swap", String(app.pid), dest], {
      env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(version(dest)).toBe("old");
    const code = await new Promise<number | null>((r) => helper.once("exit", r));
    expect(code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(version(dest)).toBe("new");
  });

  it("is started detached, with the system's own PATH", async () => {
    const calls: unknown[][] = [];
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    let unref = 0;
    child.unref = () => {
      unref += 1;
    };
    const started = startSwap({ pid: 42, folder: "/Applications" }, ((...args: unknown[]) => {
      calls.push(args);
      setTimeout(() => child.emit("spawn"), 0);
      return child;
    }) as unknown as typeof spawn);
    expect(await started).toBe(true);
    expect(unref).toBe(1);
    expect(calls[0]?.[0]).toBe("/bin/bash");
    expect((calls[0]?.[1] as string[] | undefined)?.slice(2)).toEqual([
      "matters-swap",
      "42",
      "/Applications",
    ]);
    expect(calls[0]?.[2]).toMatchObject({
      detached: true,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
  });
});

describe("what About is told (rules 2 and 5)", () => {
  const FILE = JSON.stringify({
    version: "v0.1.0-alpha.5",
    url: `https://github.com/milolabs/matters-app/releases/download/v0.1.0-alpha.5/${IMAGE}`,
    notes: "https://github.com/milolabs/matters-app/releases/tag/v0.1.0-alpha.5",
  });
  const stored = afterCheck(DEFAULT_RELEASE, { kind: "fresh", text: FILE, etag: null }, 0);

  it("offers Install where this copy can be replaced, and says why not elsewhere", () => {
    const here = releaseInfo(stored, "0.1.0-alpha.4", true, false, {
      place: { ok: true, folder: "/Applications" },
      state: INSTALL_IDLE,
    });
    expect(here.install).toEqual({
      offered: true,
      cannot: null,
      step: "idle",
      line: null,
      note: null,
    });
    const image = releaseInfo(stored, "0.1.0-alpha.4", true, false, {
      place: { ok: false, why: "disk-image" },
      state: INSTALL_IDLE,
    });
    expect(image.install.offered).toBe(false);
    expect(image.install.cannot).toBe(
      "it runs from the disk image. Drag Matters to Applications first",
    );
    // Nothing newer: nothing offered, nothing said.
    const newest = releaseInfo(stored, "0.1.0-alpha.5", true, false, {
      place: { ok: true, folder: "/Applications" },
      state: INSTALL_IDLE,
    });
    expect(newest.install).toMatchObject({ offered: false, cannot: null });
  });

  it("says the step in words, and the page gets it rebuilt", () => {
    const state = nextInstall(nextInstall(INSTALL_IDLE, { kind: "start", version: VERSION }), {
      kind: "progress",
      received: 50e6,
      total: 192e6,
    });
    const info = releaseInfo(stored, "0.1.0-alpha.4", true, false, {
      place: { ok: true, folder: "/Applications" },
      state,
    });
    expect(info.install.line).toBe(`Downloading ${VERSION}: 50 of 192 MB…`);
    expect(readReleaseInfo(info)).toEqual(info);
    expect(readReleaseInfo({ ...info, install: { ...info.install, step: "pwned" } })).toBeNull();
    expect(readReleaseInfo({ ...info, install: { ...info.install, offered: "yes" } })).toBeNull();
    expect(readReleaseInfo({ ...info, install: undefined })).toBeNull();
    // No path ever crosses: the folder stays in main.
    expect(JSON.stringify(info)).not.toContain("/Applications");
  });

  it("asks main to install or cancel by name only", async () => {
    const asked: unknown[][] = [];
    const page = {};
    const bridge = createReleaseBridge(
      {
        invoke: async (_channel, ...args) => {
          asked.push(args);
          return null;
        },
        post: () => {},
      },
      page,
    );
    const send = (a: Record<string, unknown>) =>
      bridge.message({ source: page, data: { mattersRelease: { requestId: "r", ...a } } });
    send({ action: "install", version: "9.9.9", path: "/tmp/x.dmg" });
    send({ action: "cancel" });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([["install"], ["cancel"]]);
  });
});
