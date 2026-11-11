import { join } from "node:path";
import type { FetchReceivedOutcome } from "@matters/contracts";
import { describe, expect, it, vi } from "vitest";
import { BackendLink, type LinkPort } from "../src/main/backendLink.ts";
import { createQuarantine, quarantineValue } from "../src/main/quarantine.ts";
import {
  type DirEntry,
  isInside,
  MAX_SAVE_ALL,
  numberedName,
  ReceivedFiles,
} from "../src/main/received.ts";
import { createReceivedBridge } from "../src/preload/receivedBridge.ts";

const CACHE = "/data/received";
const file = (name: string): DirEntry => ({ name, isFile: true, isSymlink: false });

/** Main's module over a cache that is a map of directory to entries, and recorders for every effect. */
function setup(
  over: {
    cache?: Record<string, DirEntry[]>;
    outcome?: FetchReceivedOutcome;
    outcomes?: Record<string, FetchReceivedOutcome>;
    quarantineFails?: boolean | ((path: string) => boolean);
    openResult?: string;
    savePath?: string | undefined;
    folder?: string | undefined;
    taken?: string[];
    preview?: boolean;
    previewFails?: boolean;
  } = {},
) {
  const cache: Record<string, DirEntry[]> = over.cache ?? {
    [join(CACHE, "7", "2")]: [file("Faktura.pdf")],
  };
  const events: string[] = [];
  const taken = new Set(over.taken ?? []);
  const deps = {
    cacheDir: CACHE,
    fetch: vi.fn(async (key: number, part: string) => {
      events.push(`fetch ${key}/${part}`);
      return over.outcomes?.[`${key}/${part}`] ?? over.outcome ?? { kind: "done" as const };
    }),
    list: vi.fn(async (dir: string) => cache[dir] ?? []),
    copy: vi.fn(async (from: string, to: string, overwrite: boolean) => {
      events.push(`copy ${from} -> ${to}${overwrite ? " overwrite" : ""}`);
      if (!overwrite && taken.has(to)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      taken.add(to);
    }),
    quarantine: vi.fn(async (path: string) => {
      events.push(`quarantine ${path}`);
      const fails = over.quarantineFails;
      if (typeof fails === "function" ? fails(path) : fails) throw new Error("xattr failed");
    }),
    openPath: vi.fn(async (path: string) => {
      events.push(`open ${path}`);
      return over.openResult ?? "";
    }),
    ...(over.preview === false
      ? {}
      : {
          preview: vi.fn((path: string) => {
            events.push(`preview ${path}`);
            if (over.previewFails) throw new Error("no quick look");
          }),
        }),
    chooseSavePath: vi.fn(async (name: string) => {
      events.push(`dialog ${name}`);
      return "savePath" in over ? over.savePath : "/Users/me/Downloads/Faktura.pdf";
    }),
    chooseFolder: vi.fn(async () => {
      events.push("folder");
      return "folder" in over ? over.folder : "/Users/me/Downloads";
    }),
    log: vi.fn(),
  };
  return { received: new ReceivedFiles(deps), deps, events };
}

describe("Open (ADR 0043, rule 12, 14)", () => {
  it("makes the copy exist, marks it as downloaded, then opens it", async () => {
    const t = setup();
    expect(await t.received.open(7, "2")).toEqual({ kind: "opened" });
    const path = join(CACHE, "7", "2", "Faktura.pdf");
    expect(t.events).toEqual(["fetch 7/2", `quarantine ${path}`, `open ${path}`]);
  });

  it("refuses a file that can run programs, and never marks, opens or hands it on", async () => {
    const t = setup({ cache: { [join(CACHE, "7", "2")]: [file("Installer.command")] } });
    expect(await t.received.open(7, "2")).toEqual({ kind: "refused", reason: "runnable" });
    expect(t.deps.openPath).not.toHaveBeenCalled();
    expect(t.deps.quarantine).not.toHaveBeenCalled();
  });

  it("checks the file on disk, whatever name the page believes", async () => {
    const t = setup({ cache: { [join(CACHE, "7", "2")]: [file("run.sh")] } });
    expect((await t.received.open(7, "2")).kind).toBe("refused");
  });

  it("does not open a file whose mark could not be set", async () => {
    const t = setup({ quarantineFails: true });
    expect(await t.received.open(7, "2")).toEqual({ kind: "refused", reason: "quarantine" });
    expect(t.deps.openPath).not.toHaveBeenCalled();
    expect(t.deps.log).toHaveBeenCalled();
  });

  it("says failed when no app takes the file", async () => {
    const t = setup({ openResult: "No application knows how to open this" });
    expect(await t.received.open(7, "2")).toEqual({ kind: "failed" });
  });

  it("passes on how the download ended without touching the file", async () => {
    for (const kind of ["gone", "offline", "failed"] as const) {
      const t = setup({ outcome: { kind } });
      expect(await t.received.open(7, "2")).toEqual({ kind });
      expect(t.deps.openPath).not.toHaveBeenCalled();
      expect(t.deps.list).not.toHaveBeenCalled();
    }
  });
});

describe("what the page may name (rule 10)", () => {
  it("refuses a bad key or part id before it asks the backend anything", async () => {
    const badKeys: unknown[] = [0, -1, 1.5, "7", null, undefined, {}, [], Number.NaN, 2 ** 60];
    const badParts: unknown[] = ["", "..", "../2", "2/..", "2 ", "a", "1..2", ".2", "2.", 2, null];
    for (const action of ["open", "preview"] as const) {
      for (const key of badKeys) {
        const t = setup();
        expect(await t.received[action](key, "2")).toEqual({ kind: "refused", reason: "invalid" });
        expect(t.deps.fetch).not.toHaveBeenCalled();
      }
      for (const part of badParts) {
        const t = setup();
        expect(await t.received[action](7, part)).toEqual({ kind: "refused", reason: "invalid" });
        expect(t.deps.fetch).not.toHaveBeenCalled();
      }
    }
  });

  it("refuses a bad key or part id for a save before the dialog, too", async () => {
    const t = setup();
    expect(await t.received.save("7", "2", "x")).toEqual({ kind: "refused", reason: "invalid" });
    expect(await t.received.save(7, "../2", "x")).toEqual({ kind: "refused", reason: "invalid" });
    expect(t.deps.chooseSavePath).not.toHaveBeenCalled();
    expect(t.deps.fetch).not.toHaveBeenCalled();
  });

  it("looks only inside the directory of that key and part, never at a path of the page's", async () => {
    const t = setup();
    await t.received.open(7, "2");
    expect(t.deps.list).toHaveBeenCalledWith(join(CACHE, "7", "2"));
    const dirs = t.deps.list.mock.calls.map((c) => c[0] as string);
    expect(dirs.every((d) => isInside(CACHE, d))).toBe(true);
  });

  it("refuses a directory that holds more than one file, or none", async () => {
    const two = setup({ cache: { [join(CACHE, "7", "2")]: [file("a.pdf"), file("b.pdf")] } });
    expect(await two.received.open(7, "2")).toEqual({ kind: "failed" });
    const none = setup({ cache: {} });
    expect(await none.received.open(7, "2")).toEqual({ kind: "failed" });
    expect(two.deps.openPath).not.toHaveBeenCalled();
    expect(none.deps.openPath).not.toHaveBeenCalled();
  });

  it("ignores temporary files, folders and links in the directory", async () => {
    const t = setup({
      cache: {
        [join(CACHE, "7", "2")]: [
          { name: ".part-123", isFile: true, isSymlink: false },
          { name: "dir", isFile: false, isSymlink: false },
          { name: "link.pdf", isFile: true, isSymlink: true },
          file("Faktura.pdf"),
        ],
      },
    });
    expect(await t.received.open(7, "2")).toEqual({ kind: "opened" });
    expect(t.events.at(-1)).toBe(`open ${join(CACHE, "7", "2", "Faktura.pdf")}`);
  });

  it("refuses a link as the only file, since it could point anywhere", async () => {
    const t = setup({
      cache: { [join(CACHE, "7", "2")]: [{ name: "x.pdf", isFile: true, isSymlink: true }] },
    });
    expect(await t.received.open(7, "2")).toEqual({ kind: "failed" });
  });

  it("refuses a name that is not just a name", async () => {
    const t = setup({ cache: { [join(CACHE, "7", "2")]: [file("../../../etc/passwd")] } });
    expect((await t.received.open(7, "2")).kind).not.toBe("opened");
    expect(t.deps.openPath).not.toHaveBeenCalled();
  });

  it("tells a path inside the cache from one outside, however it climbs", () => {
    expect(isInside(CACHE, join(CACHE, "7", "2", "a"))).toBe(true);
    expect(isInside(CACHE, CACHE)).toBe(false);
    expect(isInside(CACHE, "/data/received-evil/7")).toBe(false);
    expect(isInside(CACHE, `${CACHE}/../secrets/x`)).toBe(false);
    expect(isInside(CACHE, "/etc/passwd")).toBe(false);
  });
});

describe("Preview (rule 11)", () => {
  it("shows even a file that cannot be opened, and runs nothing", async () => {
    const t = setup({ cache: { [join(CACHE, "7", "2")]: [file("Installer.command")] } });
    expect(await t.received.preview(7, "2")).toEqual({ kind: "previewed" });
    expect(t.events).toEqual([
      "fetch 7/2",
      `preview ${join(CACHE, "7", "2", "Installer.command")}`,
    ]);
    expect(t.deps.openPath).not.toHaveBeenCalled();
  });

  it("is unsupported where there is no Quick Look, and downloads nothing for it", async () => {
    const t = setup({ preview: false });
    expect(await t.received.preview(7, "2")).toEqual({ kind: "refused", reason: "unsupported" });
    expect(t.deps.fetch).not.toHaveBeenCalled();
  });

  it("says failed when Quick Look throws", async () => {
    const t = setup({ previewFails: true });
    expect(await t.received.preview(7, "2")).toEqual({ kind: "failed" });
  });
});

describe("Save (rule 13)", () => {
  it("asks where first, then downloads, copies there and marks the copy", async () => {
    const t = setup();
    expect(await t.received.save(7, "2", "Faktura.pdf")).toEqual({
      kind: "saved",
      count: 1,
      skipped: 0,
    });
    expect(t.events).toEqual([
      "dialog Faktura.pdf",
      "fetch 7/2",
      `copy ${join(CACHE, "7", "2", "Faktura.pdf")} -> /Users/me/Downloads/Faktura.pdf overwrite`,
      "quarantine /Users/me/Downloads/Faktura.pdf",
    ]);
  });

  it("downloads nothing when the dialog is cancelled", async () => {
    const t = setup({ savePath: undefined });
    expect(await t.received.save(7, "2", "x.pdf")).toEqual({ kind: "cancelled" });
    expect(t.deps.fetch).not.toHaveBeenCalled();
  });

  it("offers a cleaned name, and a plain one when the page sends none", async () => {
    const t = setup();
    await t.received.save(7, "2", "../../.zshrc");
    await t.received.save(7, "2", 42);
    expect(t.deps.chooseSavePath).toHaveBeenNthCalledWith(1, "zshrc");
    expect(t.deps.chooseSavePath).toHaveBeenNthCalledWith(2, "attachment");
  });

  it("saves a file that cannot be opened: that is what Save is for", async () => {
    const t = setup({ cache: { [join(CACHE, "7", "2")]: [file("Installer.command")] } });
    expect((await t.received.save(7, "2", "Installer.command")).kind).toBe("saved");
  });

  it("is still a save when the mark could not be set, and says so only in the log", async () => {
    const t = setup({ quarantineFails: true });
    expect((await t.received.save(7, "2", "x.pdf")).kind).toBe("saved");
    expect(t.deps.log).toHaveBeenCalled();
  });

  it("says failed when the copy fails", async () => {
    const t = setup();
    t.deps.copy.mockRejectedValueOnce(new Error("disk full"));
    expect(await t.received.save(7, "2", "x.pdf")).toEqual({ kind: "failed" });
  });

  it("passes on a download that did not work", async () => {
    const t = setup({ outcome: { kind: "offline" } });
    expect(await t.received.save(7, "2", "x.pdf")).toEqual({ kind: "offline" });
    expect(t.deps.copy).not.toHaveBeenCalled();
  });
});

describe("Save all (rule 13)", () => {
  const items = (...parts: [number, string][]) =>
    parts.map(([messageKey, partId]) => ({ messageKey, partId }));
  const twoReports = {
    [join(CACHE, "7", "2")]: [file("report.pdf")],
    [join(CACHE, "7", "3")]: [file("report.pdf")],
    [join(CACHE, "7", "4")]: [file("report.pdf")],
    [join(CACHE, "8", "2")]: [file("other.pdf")],
  };

  it("asks for a folder once and saves every file into it", async () => {
    const t = setup({ cache: twoReports });
    const answer = await t.received.saveAll(items([7, "2"], [8, "2"]));
    expect(answer).toEqual({ kind: "saved", count: 2, skipped: 0 });
    expect(t.deps.chooseFolder).toHaveBeenCalledTimes(1);
    expect(t.deps.chooseSavePath).not.toHaveBeenCalled();
    const targets = t.deps.copy.mock.calls.map((c) => c[1]);
    expect(targets).toEqual(["/Users/me/Downloads/report.pdf", "/Users/me/Downloads/other.pdf"]);
  });

  it("adds 2 and 3 to names that collide with each other", async () => {
    const t = setup({ cache: twoReports });
    await t.received.saveAll(items([7, "2"], [7, "3"], [7, "4"]));
    // Each name is tried in turn until one is free, so the same name is asked for more than once.
    const tried = [...new Set(t.deps.copy.mock.calls.map((c) => c[1]))];
    expect(tried).toEqual([
      "/Users/me/Downloads/report.pdf",
      "/Users/me/Downloads/report 2.pdf",
      "/Users/me/Downloads/report 3.pdf",
    ]);
    expect(t.events.filter((e) => e.startsWith("quarantine"))).toEqual(
      tried.map((path) => `quarantine ${path}`),
    );
  });

  it("adds a number to names already in the folder, and never overwrites", async () => {
    const t = setup({
      cache: twoReports,
      taken: ["/Users/me/Downloads/report.pdf", "/Users/me/Downloads/report 2.pdf"],
    });
    await t.received.saveAll(items([7, "2"]));
    const attempts = t.deps.copy.mock.calls.map((c) => [c[1], c[2]]);
    expect(attempts).toEqual([
      ["/Users/me/Downloads/report.pdf", false],
      ["/Users/me/Downloads/report 2.pdf", false],
      ["/Users/me/Downloads/report 3.pdf", false],
    ]);
    expect(t.deps.copy.mock.calls.every((c) => c[2] === false)).toBe(true);
  });

  it("marks every copy it makes", async () => {
    const t = setup({ cache: twoReports });
    await t.received.saveAll(items([7, "2"], [8, "2"]));
    expect(t.deps.quarantine.mock.calls.map((c) => c[0])).toEqual([
      "/Users/me/Downloads/report.pdf",
      "/Users/me/Downloads/other.pdf",
    ]);
  });

  it("counts the files that could not be saved and saves the rest", async () => {
    const t = setup({
      cache: twoReports,
      outcomes: { "7/3": { kind: "gone" } },
    });
    expect(await t.received.saveAll(items([7, "2"], [7, "3"], [8, "2"]))).toEqual({
      kind: "saved",
      count: 2,
      skipped: 1,
    });
  });

  it("answers with the failure when nothing could be saved", async () => {
    const t = setup({ cache: twoReports, outcome: { kind: "offline" } });
    expect(await t.received.saveAll(items([7, "2"], [7, "3"]))).toEqual({ kind: "offline" });
  });

  it("is cancelled with the dialog and downloads nothing", async () => {
    const t = setup({ cache: twoReports, folder: undefined });
    expect(await t.received.saveAll(items([7, "2"]))).toEqual({ kind: "cancelled" });
    expect(t.deps.fetch).not.toHaveBeenCalled();
  });

  it("refuses a list that is not one, or has a bad file in it, before any dialog", async () => {
    const t = setup({ cache: twoReports });
    for (const bad of [
      null,
      undefined,
      "7/2",
      [],
      [{ messageKey: 7 }],
      [{ messageKey: "7", partId: "2" }],
      [{ messageKey: 7, partId: "../2" }],
      [null],
      [
        { messageKey: 7, partId: "2" },
        { messageKey: 0, partId: "2" },
      ],
      Array.from({ length: MAX_SAVE_ALL + 1 }, () => ({ messageKey: 7, partId: "2" })),
    ]) {
      expect(await t.received.saveAll(bad)).toEqual({ kind: "refused", reason: "invalid" });
    }
    expect(t.deps.chooseFolder).not.toHaveBeenCalled();
    expect(t.deps.fetch).not.toHaveBeenCalled();
  });
});

describe("numberedName", () => {
  it("puts the number before the extension", () => {
    expect(numberedName("report.pdf", 1)).toBe("report.pdf");
    expect(numberedName("report.pdf", 2)).toBe("report 2.pdf");
    expect(numberedName("a.tar.gz", 3)).toBe("a.tar 3.gz");
  });

  it("puts it at the end of a name with no extension, and after a leading dot", () => {
    expect(numberedName("README", 2)).toBe("README 2");
    expect(numberedName(".profile", 2)).toBe(".profile 2");
  });
});

describe("the quarantine mark (rule 14)", () => {
  it("has the standard format: flags, hex seconds, the app's name", () => {
    expect(quarantineValue(1_730_000_000_000)).toBe(
      `0081;${(1_730_000_000).toString(16)};Matters;`,
    );
    expect(quarantineValue(1_999)).toBe("0081;1;Matters;");
    expect(quarantineValue(0)).toBe("0081;0;Matters;");
  });

  it("is set with xattr on macOS", async () => {
    const run = vi.fn(async () => {});
    await createQuarantine({ platform: "darwin", run, now: () => 4000 })("/a/b.pdf");
    expect(run).toHaveBeenCalledWith("xattr", [
      "-w",
      "com.apple.quarantine",
      "0081;4;Matters;",
      "/a/b.pdf",
    ]);
  });

  it("is not attempted elsewhere: the platform decides, not the code", async () => {
    for (const platform of ["win32", "linux"]) {
      const run = vi.fn(async () => {});
      await createQuarantine({ platform, run, now: () => 1 })("/a/b.pdf");
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("rejects when the program fails, so an open can refuse", async () => {
    const run = vi.fn(async () => {
      throw new Error("xattr: no such file");
    });
    await expect(
      createQuarantine({ platform: "darwin", run, now: () => 1 })("/gone"),
    ).rejects.toThrow("no such file");
  });
});

describe("main's line to the backend", () => {
  function port() {
    let listener: (e: { data: unknown }) => void = () => {};
    const sent: unknown[] = [];
    const p: LinkPort = {
      postMessage: (m) => sent.push(m),
      on: (_event, l) => {
        listener = l;
      },
      start: () => {},
    };
    return { p, sent, reply: (data: unknown) => listener({ data }) };
  }

  it("sends a request and resolves with the outcome that carries its id", async () => {
    const { p, sent, reply } = port();
    const link = new BackendLink(p);
    const pending = link.fetchReceived(7, "2");
    const request = sent[0] as { requestId: string; type: string };
    expect(request).toMatchObject({ type: "fetchReceived", messageKey: 7, partId: "2" });
    reply({
      type: "fetchReceived",
      requestId: request.requestId,
      ok: true,
      outcome: { kind: "gone" },
    });
    expect(await pending).toEqual({ kind: "gone" });
  });

  it("keeps requests apart by id and ignores answers it did not ask for", async () => {
    const { p, sent, reply } = port();
    const link = new BackendLink(p);
    const a = link.fetchReceived(1, "2");
    const b = link.fetchReceived(2, "2");
    const [ra, rb] = sent as { requestId: string }[];
    reply({ type: "attachments", draftId: "x" });
    reply({ requestId: "unknown", ok: true, outcome: { kind: "done" } });
    reply({ requestId: rb?.requestId, ok: true, outcome: { kind: "offline" } });
    reply({ requestId: ra?.requestId, ok: true, outcome: { kind: "done" } });
    expect(await a).toEqual({ kind: "done" });
    expect(await b).toEqual({ kind: "offline" });
  });

  it("takes an error or an odd answer for a failure and carries nothing else", async () => {
    const { p, sent, reply } = port();
    const link = new BackendLink(p);
    const a = link.fetchReceived(1, "2");
    reply({ requestId: (sent[0] as { requestId: string }).requestId, ok: false, code: "internal" });
    expect(await a).toEqual({ kind: "failed" });
    const b = link.fetchReceived(1, "2");
    reply({
      requestId: (sent[1] as { requestId: string }).requestId,
      ok: true,
      outcome: { kind: "done", path: "/etc/passwd" },
    });
    expect(await b).toEqual({ kind: "done" });
  });
});

describe("the page's way to ask (rule 10, 16)", () => {
  const pageWindow = {};
  function bridge(answer: unknown = { kind: "opened" }) {
    const posted: unknown[] = [];
    const invoke = vi.fn(async () => answer);
    const b = createReceivedBridge({ invoke, post: (m) => posted.push(m) }, pageWindow);
    return { b, invoke, posted };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("hands main the action, the key and the part, and posts the answer back", async () => {
    const { b, invoke, posted } = bridge();
    b.message({
      source: pageWindow,
      data: { mattersReceived: { requestId: "r1", action: "open", messageKey: 7, partId: "2" } },
    });
    await flush();
    expect(invoke).toHaveBeenCalledWith("matters:received", "open", 7, "2", undefined, undefined);
    expect(posted).toEqual([
      { mattersReceivedAnswer: { requestId: "r1", answer: { kind: "opened" } } },
    ]);
  });

  it("passes the items of a Save all and the name hint of a Save", async () => {
    const { b, invoke } = bridge();
    const items = [{ messageKey: 7, partId: "2" }];
    b.message({
      source: pageWindow,
      data: { mattersReceived: { requestId: "r2", action: "saveAll", items } },
    });
    b.message({
      source: pageWindow,
      data: {
        mattersReceived: {
          requestId: "r3",
          action: "save",
          messageKey: 7,
          partId: "2",
          name: "a",
        },
      },
    });
    await flush();
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      "matters:received",
      "saveAll",
      undefined,
      undefined,
      undefined,
      items,
    );
    expect(invoke).toHaveBeenNthCalledWith(2, "matters:received", "save", 7, "2", "a", undefined);
  });

  it("ignores messages that are not from the page itself", async () => {
    const { b, invoke, posted } = bridge();
    b.message({
      source: {},
      data: { mattersReceived: { requestId: "r1", action: "open", messageKey: 7, partId: "2" } },
    });
    b.message({ source: pageWindow, data: "open" });
    b.message({ source: pageWindow, data: { mattersReceived: { action: "open" } } });
    b.message({ source: pageWindow, data: { mattersReceived: { requestId: 5, action: "open" } } });
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("answers failed to an action it does not know, without asking main", async () => {
    const { b, invoke, posted } = bridge();
    b.message({
      source: pageWindow,
      data: { mattersReceived: { requestId: "r1", action: "delete-everything" } },
    });
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(posted).toEqual([
      { mattersReceivedAnswer: { requestId: "r1", answer: { kind: "failed" } } },
    ]);
  });

  it("answers failed when main throws or says something it should not", async () => {
    const throwing = createReceivedBridge(
      {
        invoke: async () => {
          throw new Error("closed");
        },
        post: (m) => posted.push(m),
      },
      pageWindow,
    );
    const posted: unknown[] = [];
    throwing.message({
      source: pageWindow,
      data: { mattersReceived: { requestId: "r1", action: "open", messageKey: 7, partId: "2" } },
    });
    await flush();
    expect(posted).toEqual([
      { mattersReceivedAnswer: { requestId: "r1", answer: { kind: "failed" } } },
    ]);

    const odd = bridge("/etc/passwd");
    odd.b.message({
      source: pageWindow,
      data: { mattersReceived: { requestId: "r2", action: "open", messageKey: 7, partId: "2" } },
    });
    await flush();
    expect(odd.posted).toEqual([
      { mattersReceivedAnswer: { requestId: "r2", answer: { kind: "failed" } } },
    ]);
  });
});
