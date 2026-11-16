import { EventEmitter } from "node:events";
import type { ReleaseInfo } from "@matters/contracts";
import { RELEASE_DOWNLOAD_PAGE } from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  afterCheck,
  DEFAULT_RELEASE,
  etagToSend,
  markSeen,
  parseStoredRelease,
  releaseInfo,
  releaseLinkFor,
  releaseMenuLabel,
  type StoredRelease,
  serializeStoredRelease,
} from "../src/main/release.ts";
import { type RequestLike, requestReleaseFile } from "../src/main/releaseRequest.ts";
import { readReleaseInfo } from "../src/main/releaseShapes.ts";
import { createReleaseBridge } from "../src/preload/releaseBridge.ts";
import { aboutState, checkedLine, gearLabel, versionLine } from "../src/renderer/newerVersion.ts";

// ADR 0137: what main keeps of newer versions, the one request, what crosses to a page, and the
// words the gear and About say.

const FILE = JSON.stringify({
  repo: "milolabs/matters-app",
  version: "v0.1.0-alpha.5",
  date: "2026-11-14T08:00:00Z",
  url: "https://github.com/milolabs/matters-app/releases/download/v0.1.0-alpha.5/Matters-0.1.0-alpha.5-arm64.dmg",
  notes: "https://github.com/milolabs/matters-app/releases/tag/v0.1.0-alpha.5",
  stage: "alpha",
  stars: 3,
});
const NOW = Date.UTC(2026, 10, 14, 9, 14);
const RUNNING = "0.1.0-alpha.4";

const fresh = (text = FILE, etag: string | null = '"abc"') =>
  afterCheck(DEFAULT_RELEASE, { kind: "fresh", text, etag }, NOW);

describe("the kept state", () => {
  it("is on by default, and a damaged file cannot turn it off", () => {
    expect(parseStoredRelease(null)).toEqual(DEFAULT_RELEASE);
    expect(parseStoredRelease("{nope")).toEqual(DEFAULT_RELEASE);
    expect(parseStoredRelease('{"enabled":"no"}').enabled).toBe(true);
    expect(parseStoredRelease('{"enabled":false}').enabled).toBe(false);
  });

  it("round-trips, and checks a kept answer again as if it had just come", () => {
    const kept = fresh();
    expect(parseStoredRelease(serializeStoredRelease(kept))).toEqual(kept);
    const tampered = JSON.parse(serializeStoredRelease(kept));
    tampered.answer.download = "https://evil.test/x.dmg";
    tampered.answer.version = "0.1.0-alpha.5";
    expect(parseStoredRelease(JSON.stringify(tampered)).answer?.download).toBeNull();
    tampered.answer.version = "soon";
    const gone = parseStoredRelease(JSON.stringify(tampered));
    // No answer, so no ETag to send for it either.
    expect(gone.answer).toBeNull();
    expect(etagToSend(gone)).toBeNull();
  });

  it("keeps the last answer through a 304 and through a failure", () => {
    const kept = fresh();
    expect(etagToSend(kept)).toBe('"abc"');
    const same = afterCheck(kept, { kind: "same" }, NOW + 1000);
    expect(same).toMatchObject({ answer: kept.answer, checkedMs: NOW + 1000, failure: null });
    const failed = afterCheck(kept, { kind: "failed", failure: "no-answer" }, NOW + 2000);
    expect(failed).toMatchObject({ answer: kept.answer, checkedMs: NOW, failure: "no-answer" });
    // A 304 with nothing kept cannot be: it is not "newest".
    expect(afterCheck(DEFAULT_RELEASE, { kind: "same" }, NOW).failure).toBe("not-json");
  });

  it("refuses a file without a version as a failed check", () => {
    const none = JSON.stringify({ version: null, url: null });
    expect(afterCheck(DEFAULT_RELEASE, { kind: "fresh", text: none, etag: null }, NOW)).toEqual({
      ...DEFAULT_RELEASE,
      failure: "no-version",
    });
  });
});

describe("what main says", () => {
  it("says a newer version, with the dot, until About is seen", () => {
    const kept = fresh();
    const info = releaseInfo(kept, RUNNING, true, false);
    expect(info).toEqual({
      version: RUNNING,
      stage: "alpha",
      asks: true,
      enabled: true,
      checking: false,
      newer: {
        version: "0.1.0-alpha.5",
        dateMs: Date.UTC(2026, 10, 14, 8),
        preRelease: true,
        download: true,
        notes: true,
      },
      dot: true,
      checkedMs: NOW,
      failure: null,
      // Before Settings has opened, where this copy is is not known: no Install yet (ADR 0140).
      install: { offered: false, cannot: null, step: "idle", line: null, note: null },
    });
    expect(releaseMenuLabel(info)).toBe("New Version: 0.1.0-alpha.5…");
    const seen = markSeen(kept, RUNNING, true);
    expect(seen.seen).toBe("0.1.0-alpha.5");
    expect(releaseInfo(seen, RUNNING, true, false)).toMatchObject({ dot: false, newer: {} });
  });

  it("says nothing newer when the running version is the same or newer", () => {
    expect(releaseInfo(fresh(), "0.1.0-alpha.5", true, false)).toMatchObject({
      newer: null,
      dot: false,
    });
    expect(releaseInfo(fresh(), "0.1.0", true, false).newer).toBeNull();
    expect(releaseMenuLabel(releaseInfo(fresh(), "0.1.0", true, false))).toBe(
      "Check for a Newer Version…",
    );
  });

  it("says nothing with the switch off or in a build that does not ask", () => {
    const off: StoredRelease = { ...fresh(), enabled: false };
    expect(releaseInfo(off, RUNNING, true, false)).toMatchObject({
      enabled: false,
      newer: null,
      dot: false,
    });
    expect(releaseInfo(fresh(), RUNNING, false, false)).toMatchObject({ newer: null, dot: false });
    expect(markSeen(fresh(), RUNNING, false).seen).toBeNull();
  });

  it("opens only the file's checked links, or the download page when none passed", () => {
    expect(releaseLinkFor(fresh(), RUNNING, "download")).toMatch(
      /^https:\/\/github\.com\/milolabs\/matters-app\/releases\/download\//,
    );
    const bad = fresh(
      JSON.stringify({ version: "0.1.0-alpha.5", url: "https://evil.test/a", notes: "x" }),
    );
    expect(releaseLinkFor(bad, RUNNING, "download")).toBe(RELEASE_DOWNLOAD_PAGE);
    expect(releaseLinkFor(bad, RUNNING, "notes")).toBeNull();
    expect(releaseInfo(bad, RUNNING, true, false).newer).toMatchObject({
      download: true,
      notes: false,
    });
    // Nothing newer: nothing to open.
    expect(releaseLinkFor(fresh(), "0.2.0", "download")).toBeNull();
  });
});

describe("the request (rules 3, 4 and 8)", () => {
  class FakeResponse extends EventEmitter {
    readonly statusCode: number;
    readonly headers: Record<string, string | string[]>;
    constructor(statusCode: number, headers: Record<string, string | string[]> = {}) {
      super();
      this.statusCode = statusCode;
      this.headers = headers;
    }
  }
  class FakeRequest extends EventEmitter implements RequestLike {
    headers: Record<string, string> = {};
    aborted = false;
    ended = false;
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    abort() {
      this.aborted = true;
    }
    end() {
      this.ended = true;
    }
  }
  const run = (
    etag: string | null,
    play: (req: FakeRequest) => void,
    options: { limitBytes?: number; timeoutMs?: number } = {},
  ) => {
    const req = new FakeRequest();
    const done = requestReleaseFile(
      {
        open: () => {
          setTimeout(() => play(req), 0);
          return req;
        },
        ...options,
      },
      "https://getmatters.app/release.json",
      etag,
    );
    return { req, done };
  };

  it("says only `Matters`, and sends the ETag it knows", async () => {
    const { req, done } = run('"abc"', (r) => {
      const res = new FakeResponse(200, { etag: '"def"' });
      r.emit("response", res);
      res.emit("data", Buffer.from(FILE));
      res.emit("end");
    });
    expect(await done).toEqual({ kind: "fresh", text: FILE, etag: '"def"' });
    expect(req.headers).toEqual({ "User-Agent": "Matters", "If-None-Match": '"abc"' });
    expect(req.ended).toBe(true);
  });

  it("sends no If-None-Match without an ETag, and reads a 304 as the same", async () => {
    const { req, done } = run(null, (r) => r.emit("response", new FakeResponse(304)));
    expect(await done).toEqual({ kind: "same" });
    expect(req.headers).toEqual({ "User-Agent": "Matters" });
  });

  it("fails on a body over the limit, a status, a redirect, an error and a timeout", async () => {
    const big = run(
      null,
      (r) => {
        const res = new FakeResponse(200);
        r.emit("response", res);
        res.emit("data", Buffer.alloc(10));
        res.emit("data", Buffer.alloc(10));
      },
      { limitBytes: 16 },
    );
    expect(await big.done).toEqual({ kind: "failed", failure: "too-big" });
    expect(big.req.aborted).toBe(true);
    const said = run(null, (r) =>
      r.emit("response", new FakeResponse(200, { "content-length": "20000" })),
    );
    expect(await said.done).toEqual({ kind: "failed", failure: "too-big" });
    const status = run(null, (r) => r.emit("response", new FakeResponse(404)));
    expect(await status.done).toEqual({ kind: "failed", failure: "status" });
    const moved = run(null, (r) => r.emit("redirect"));
    expect(await moved.done).toEqual({ kind: "failed", failure: "redirect" });
    const broken = run(null, (r) => r.emit("error", new Error("net::ERR_NAME_NOT_RESOLVED")));
    expect(await broken.done).toEqual({ kind: "failed", failure: "no-answer" });
    const slow = run(null, () => {}, { timeoutMs: 20 });
    expect(await slow.done).toEqual({ kind: "failed", failure: "no-answer" });
    expect(slow.req.aborted).toBe(true);
  });
});

describe("what crosses to a page", () => {
  const info = releaseInfo(fresh(), RUNNING, true, false);

  it("passes main's state through, rebuilt, and refuses anything else", () => {
    expect(readReleaseInfo(info)).toEqual(info);
    expect(readReleaseInfo({ ...info, extra: "x" })).toEqual(info);
    expect(readReleaseInfo({ ...info, enabled: "yes" })).toBeNull();
    expect(readReleaseInfo({ ...info, newer: { ...info.newer, version: "<b>" } })).toBeNull();
    // No link ever crosses: a URL in the answer is dropped.
    const withUrl = readReleaseInfo({ ...info, newer: { ...info.newer, url: "https://x" } });
    expect(JSON.stringify(withUrl)).not.toContain("https://");
  });

  it("asks main only in known shapes, and names a link, never gives one", async () => {
    const asked: unknown[][] = [];
    const posted: unknown[] = [];
    const page = {};
    const bridge = createReleaseBridge(
      {
        invoke: async (_channel, ...args) => {
          asked.push(args);
          return info;
        },
        post: (m) => posted.push(m),
      },
      page,
    );
    const send = (ask: Record<string, unknown>) =>
      bridge.message({ source: page, data: { mattersRelease: { requestId: "r", ...ask } } });
    send({ action: "open", which: "download" });
    send({ action: "open", which: "https://evil.test" });
    send({ action: "enable", on: "yes" });
    send({ action: "enable", on: false });
    send({ action: "nuke" });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([
      ["open", "download"],
      ["enable", false],
    ]);
    expect(posted.filter((m) => JSON.stringify(m).includes('"answer":null'))).toHaveLength(3);
    bridge.section("about");
    bridge.section("../x");
    expect(posted.at(-1)).toEqual({ mattersSettingsSection: "about" });
  });
});

describe("the words", () => {
  const base: ReleaseInfo = releaseInfo(fresh(), RUNNING, true, false);

  it("names the gear and the version as the design does", () => {
    expect(gearLabel(base)).toBe("Settings · Matters 0.1.0-alpha.5 is out");
    expect(gearLabel({ ...base, dot: false })).toBe("Settings");
    expect(gearLabel(null)).toBe("Settings");
    expect(versionLine(base)).toBe("Version 0.1.0-alpha.4 · an alpha");
    expect(versionLine({ ...base, version: "0.1.0", stage: null })).toBe("Version 0.1.0");
  });

  it("says where the check stands, in each state", () => {
    expect(aboutState(base, NOW).kind).toBe("newer");
    expect(aboutState({ ...base, asks: false }, NOW).kind).toBe("source");
    expect(aboutState({ ...base, enabled: false }, NOW).kind).toBe("off");
    expect(aboutState({ ...base, newer: null, dot: false }, NOW).kind).toBe("newest");
    expect(
      aboutState(
        {
          ...base,
          newer: null,
          checkedMs: Date.UTC(2026, 10, 12, 10),
          failure: "getmatters.app did not answer.",
        },
        NOW,
      ),
    ).toEqual({
      kind: "failed",
      line: "Could not check: getmatters.app did not answer.",
      sub: "Last checked on 12 November. Matters tries again when it next starts.",
    });
    expect(checkedLine(base, NOW)).toMatch(/^Checked today at \d\d:\d\d\.$/);
    expect(checkedLine({ ...base, checking: true }, NOW)).toBe("Checking…");
    expect(checkedLine({ ...base, enabled: false }, NOW)).toBe("");
  });
});
