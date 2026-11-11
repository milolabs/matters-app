import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MainStorageInfo, StorageReport, StorageSampleInfo } from "@matters/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { StorageService } from "../src/backend/storageService.ts";
import { folderKind, folderUsage, processUsage } from "../src/main/storageUsage.ts";
import { createStorageBridge } from "../src/preload/storageBridge.ts";
import {
  canClearFileText,
  canCompact,
  filesReadLine,
  linePoints,
  measuredAgo,
  overTime,
  storageParts,
  storageSize,
  totalBytes,
} from "../src/renderer/storageView.ts";

// ADR 0089: Settings › Storage.

const DAY = 86_400_000;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sample = (atMs: number, fileBytes: number, messages = 100): StorageSampleInfo => ({
  atMs,
  messages,
  fileBytes,
  freeBytes: 0,
  searchBytes: 1_100_000_000,
  htmlBytes: 800_000_000,
  textBytes: 330_000_000,
  filesTextBytes: 0,
  mailBytes: 450_000_000,
});

const report = (over: Partial<StorageReport> = {}): StorageReport => ({
  messages: 197_231,
  accounts: [],
  fileBytes: 3_600_000_000,
  freeBytes: 916_000_000,
  filesRead: 0,
  repack: { left: 0, listing: false },
  samples: [sample(DAY, 3_600_000_000)],
  ...over,
});

const main: MainStorageInfo = {
  folders: {
    databaseBytes: 3_612_000_000,
    filesBytes: 16_000_000,
    cachesBytes: 320_000_000,
    otherBytes: 2_000_000,
  },
  processes: [],
};

describe("the storage view", () => {
  it("writes sizes as Finder does", () => {
    expect(storageSize(512)).toBe("1 KB");
    expect(storageSize(16_400_000)).toBe("16 MB");
    expect(storageSize(3_912_000_000)).toBe("3.9 GB");
  });

  it("lists the parts largest first, free space last, and totals main's folders", () => {
    const parts = storageParts(report(), main);
    expect(parts.map((p) => p.id)).toEqual([
      "search",
      "html",
      "mail",
      "text",
      "caches",
      "files",
      "other",
      "filesText",
      "free",
    ]);
    expect(parts.at(-1)?.bytes).toBe(916_000_000);
    expect(totalBytes(report(), main)).toBe(3_950_000_000);
    // Without main's answer only the database file is known.
    expect(totalBytes(report(), null)).toBe(3_600_000_000);
    expect(storageParts(report({ samples: [] }), null).map((p) => p.id)).toEqual(["free"]);
  });

  it("shows the text of files as its own part, and words the Files part for the agent too (ADR 0087, rule 11)", () => {
    const withText = report({
      filesRead: 12,
      samples: [{ ...sample(DAY, 3_600_000_000), filesTextBytes: 900_000_000 }],
    });
    const parts = storageParts(withText, main);
    const text = parts.find((p) => p.id === "filesText");
    expect(text).toMatchObject({
      label: "Text of files",
      detail: "What agents read from attachments",
      bytes: 900_000_000,
    });
    // Sorted among the others by size: under the search index, over the messages as sent.
    expect(parts.findIndex((p) => p.id === "filesText")).toBe(1);
    expect(parts.find((p) => p.id === "files")?.detail).toBe(
      "Attachments you or the agent opened, saved or pasted",
    );
    expect(canClearFileText(withText)).toBe(true);
    expect(canClearFileText(report())).toBe(false);
    expect(filesReadLine(1)).toBe("1 file read");
    expect(filesReadLine(1234)).toBe("1,234 files read");
  });

  it("offers Compact from a tenth of the database free", () => {
    expect(canCompact(report())).toBe(true);
    expect(canCompact(report({ freeBytes: 300_000_000 }))).toBe(false);
  });

  it("draws the database over time and the change in 30 days", () => {
    const now = 100 * DAY;
    const samples = [
      sample(now - 60 * DAY, 3_000_000_000, 100),
      sample(now - 31 * DAY, 3_200_000_000, 150),
      sample(now, 3_500_000_000, 400),
    ];
    const history = overTime(samples, now);
    expect(history.change30).toBe(300_000_000);
    expect(history.newMessages30).toBe(250);
    expect(overTime(samples.slice(-1), now).change30).toBeUndefined();
    expect(linePoints(history.points, 100, 20)).toBe("0.0,16.0 48.3,11.2 100.0,4.0");
  });

  it("says how long ago it measured", () => {
    expect(measuredAgo(undefined, 0)).toBe("Not measured yet");
    expect(measuredAgo(0, 20_000)).toBe("Measured just now");
    expect(measuredAgo(0, 2 * 60_000)).toBe("Measured 2 min ago");
    expect(measuredAgo(0, 3 * 3_600_000)).toBe("Measured 3 h ago");
  });
});

describe("main's side", () => {
  it("sorts the user data folder by kind, never naming a path", async () => {
    expect(folderKind("matters.db", "matters.db")).toBe("databaseBytes");
    expect(folderKind("matters.db-wal", "matters.db")).toBe("databaseBytes");
    expect(folderKind("attachments", "matters.db")).toBe("filesBytes");
    expect(folderKind("Code Cache", "matters.db")).toBe("cachesBytes");
    expect(folderKind("window.json", "matters.db")).toBe("otherBytes");

    const dir = mkdtempSync(join(tmpdir(), "matters-userdata-"));
    dirs.push(dir);
    writeFileSync(join(dir, "matters.db"), Buffer.alloc(1000));
    writeFileSync(join(dir, "matters.db-wal"), Buffer.alloc(200));
    mkdirSync(join(dir, "Cache", "deep"), { recursive: true });
    writeFileSync(join(dir, "Cache", "deep", "x"), Buffer.alloc(300));
    mkdirSync(join(dir, "received"));
    writeFileSync(join(dir, "received", "a.pdf"), Buffer.alloc(40));
    writeFileSync(join(dir, "window.json"), Buffer.alloc(5));
    expect(await folderUsage(dir, join(dir, "matters.db"))).toEqual({
      databaseBytes: 1200,
      filesBytes: 40,
      cachesBytes: 300,
      otherBytes: 5,
    });
  });

  it("names each process by what it does, largest first", () => {
    const m = (pid: number, type: string, kb: number, serviceName?: string) => ({
      pid,
      type,
      ...(serviceName ? { serviceName } : {}),
      memory: { workingSetSize: kb },
      cpu: { percentCPUUsage: 1 },
    });
    const usage = processUsage(
      [
        m(1, "Browser", 137_000),
        m(2, "GPU", 70_000),
        m(3, "Utility", 46_000, "network.mojom.NetworkService"),
        m(4, "Utility", 395_000, "node.mojom.NodeService"),
        m(5, "Tab", 151_000),
        m(6, "Tab", 90_000),
      ],
      { backend: 4, mail: 5, settings: 6 },
    );
    expect(usage.map((p) => [p.kind, p.memoryBytes])).toEqual([
      ["backend", 395_000 * 1024],
      ["mail", 151_000 * 1024],
      ["app", 137_000 * 1024],
      ["settings", 90_000 * 1024],
      ["gpu", 70_000 * 1024],
      ["network", 46_000 * 1024],
    ]);
  });

  it("passes on only the two questions, from the page itself", async () => {
    const asked: unknown[] = [];
    const posted: unknown[] = [];
    const page = {};
    const bridge = createStorageBridge(
      {
        invoke: async (channel, ...args) => {
          asked.push([channel, ...args]);
          return { folders: {}, processes: [] };
        },
        post: (message) => posted.push(message),
      },
      page,
    );
    bridge.message({
      source: page,
      data: { mattersStorage: { requestId: "r1", action: "overview" } },
    });
    bridge.message({
      source: page,
      data: { mattersStorage: { requestId: "r2", action: "rm -rf" } },
    });
    bridge.message({
      source: {},
      data: { mattersStorage: { requestId: "r3", action: "overview" } },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([["matters:storage", "overview"]]);
    expect(posted).toEqual([
      { mattersStorageAnswer: { requestId: "r2", answer: null } },
      { mattersStorageAnswer: { requestId: "r1", answer: { folders: {}, processes: [] } } },
    ]);
  });
});

describe("the router's storage service", () => {
  function service(samples: StorageSampleInfo[], now: number) {
    const calls: string[] = [];
    let measured = 0;
    const reads = {
      ask: async (read: { name: string }) => {
        calls.push(read.name);
        if (read.name === "storageMeasure") {
          measured += 1;
          return sample(now, 1);
        }
        return { overview: { ...report(), samples: undefined }, samples };
      },
    };
    const host = {
      command: async (command: { name: string }) => {
        calls.push(command.name);
        if (command.name === "recordStorageSample") samples.push(sample(now, 1));
        return null;
      },
    };
    const s = new StorageService(reads as never, host as never, () => now);
    return { s, calls, measured: () => measured };
  }

  it("measures once for two asks at the same time, and keeps it through the worker", async () => {
    const { s, calls, measured } = service([], 10 * DAY);
    const [a, b] = await Promise.all([s.measure(), s.measure()]);
    expect(measured()).toBe(1);
    expect(a).toEqual(b);
    expect(calls).toEqual(["storageMeasure", "recordStorageSample", "storageOverview"]);
  });

  it("clears the text of files through the sync worker, which is the writer", async () => {
    const calls: string[] = [];
    const host = {
      command: async (command: { name: string }) => {
        calls.push(command.name);
        return 7;
      },
    };
    const s = new StorageService({ ask: async () => null } as never, host as never);
    expect(await s.clearFileText()).toBe(7);
    expect(calls).toEqual(["clearFileText"]);
  });

  it("measures on its own only when a day passed", async () => {
    expect(await service([sample(10 * DAY - 1000, 1)], 10 * DAY).s.measureIfDue()).toBe(false);
    expect(await service([sample(8 * DAY, 1)], 10 * DAY).s.measureIfDue()).toBe(true);
    expect(await service([], 10 * DAY).s.measureIfDue()).toBe(true);
  });
});
