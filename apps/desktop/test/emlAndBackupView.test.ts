import { describe, expect, it } from "vitest";
import { createEmlBridge } from "../src/preload/emlBridge.ts";
import {
  BACKUP_LEAVES,
  BACKUP_NOT_ENCRYPTED,
  backupLine,
  jobLine,
  pendingLines,
  restoreLine,
} from "../src/renderer/backupView.ts";
import { emlLetters, emlProgressText } from "../src/renderer/emlSave.ts";

describe("Save as .eml… in the reader (ADR 0145, rules 1 and 5)", () => {
  it("asks for every letter of the thread, oldest first", () => {
    expect(
      emlLetters([
        { key: 3, subject: "Re: Lunch", dateMs: 30 },
        { key: 1, subject: "Lunch", dateMs: 10 },
      ]),
    ).toEqual([
      { messageKey: 1, subject: "Lunch", dateMs: 10 },
      { messageKey: 3, subject: "Re: Lunch", dateMs: 30 },
    ]);
  });

  it("says how far a save is", () => {
    expect(emlProgressText({ index: 0, count: 1, bytes: 0, totalBytes: 0 })).toBe(
      "Saving the message…",
    );
    expect(emlProgressText({ index: 1, count: 5, bytes: 14e6, totalBytes: 34e6 })).toBe(
      "Saving letter 2 of 5 · 14 of 34 MB",
    );
  });

  it("passes the page's letters to main only in their shape, and never a path", async () => {
    const invoked: unknown[][] = [];
    const posted: unknown[] = [];
    const page = {};
    const bridge = createEmlBridge(
      {
        invoke: async (...args) => {
          invoked.push(args);
          return { kind: "done", saved: 1, problem: null, path: "/etc/passwd" };
        },
        post: (m) => posted.push(m),
      },
      page,
    );
    bridge.message({
      source: page,
      data: {
        mattersEml: {
          requestId: "r1",
          action: "save",
          letters: [{ messageKey: 1, subject: "Hi", dateMs: 5, target: "/tmp/x" }],
        },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(invoked).toEqual([
      ["matters:eml", "save", [{ messageKey: 1, subject: "Hi", dateMs: 5 }]],
    ]);
    expect(posted).toEqual([
      { mattersEmlAnswer: { requestId: "r1", answer: { kind: "done", saved: 1, problem: null } } },
    ]);
    bridge.message({
      source: {},
      data: { mattersEml: { requestId: "r2", action: "save", letters: [] } },
    });
    bridge.message({
      source: page,
      data: { mattersEml: { requestId: "r3", action: "save", letters: "x" } },
    });
    expect(posted.at(-1)).toEqual({
      mattersEmlAnswer: { requestId: "r3", answer: { kind: "invalid" } },
    });
    bridge.progress({ index: 0, count: 1, bytes: 1, totalBytes: 2, extra: "x" });
    expect(posted.at(-1)).toEqual({
      mattersEmlProgress: { index: 0, count: 1, bytes: 1, totalBytes: 2 },
    });
  });
});

describe("Settings › Storage › Backups (ADR 0145, rules 6 to 10)", () => {
  it("says before a backup what it leaves out, and that it is not encrypted", () => {
    expect(BACKUP_LEAVES).toMatch(/passwords, sign-ins or API keys/);
    expect(BACKUP_LEAVES).toMatch(/downloaded attachments/);
    expect(BACKUP_NOT_ENCRYPTED).toMatch(/not encrypted/);
  });

  it("names what runs, and how each job ended", () => {
    expect(jobLine({ kind: "idle" })).toBeNull();
    expect(jobLine({ kind: "backingUp", writtenBytes: 812e6, databaseBytes: 1e9 })).toMatch(
      /^Backing up… .* written$/,
    );
    expect(jobLine({ kind: "checking" })).toBe("Checking the backup…");
    expect(backupLine({ kind: "cancelled" })).toBeNull();
    expect(backupLine({ kind: "failed", text: "No." })).toEqual({ text: "No.", failure: true });
    expect(restoreLine({ kind: "refused", reason: "schema", text: "Refused." })).toEqual({
      text: "Refused.",
      failure: true,
    });
  });

  it("says what a waiting restore will do, held mail and accounts included", () => {
    const lines = pendingLines({
      version: 1,
      setAside: "20261116T153000Z",
      holdAccounts: ["a1"],
      preparedAtMs: 1,
      messages: 12345,
      accounts: 2,
      heldSends: 3,
    });
    expect(lines[0]).toMatch(/^The backup holds 12,345 messages of 2 accounts\./);
    expect(lines.some((l) => /3 messages were waiting to be sent/.test(l))).toBe(true);
    expect(lines.some((l) => /1 account of the backup uses another server/.test(l))).toBe(true);
  });
});
