// The moves adapter against a stand-in for the ImapFlow client, so that what it sends can be read.
// This is the only place the Gmail path (labels, [Gmail]/Trash, [Gmail]/Spam) is exercised: Gmail
// cannot run in CI, and this test has NOT been run against Gmail. It shows which commands the
// adapter issues, in which folder, for each action; it cannot show what Gmail does with them.
import type { MessageLocation } from "@matters/core";
import { describe, expect, it } from "vitest";
import type { OpenConnection } from "../src/connection.ts";
import { ImapMoves } from "../src/moves.ts";

interface Entry {
  path: string;
  name: string;
  specialUse?: string;
  flags?: string[];
}

/** What the client was asked, in order, as `command folder args`. */
type Log = string[];

function client(
  entries: readonly Entry[],
  options: { capabilities?: string[]; uidMap?: boolean } = {},
) {
  const log: Log = [];
  let selected = "";
  let nextUid = 100;
  const caps = new Set(options.capabilities ?? ["MOVE", "UIDPLUS"]);
  const present = new Map<string, Set<number>>();
  const have = (path: string) => {
    let set = present.get(path);
    if (!set) {
      set = new Set([1, 2, 3, 4, 5]);
      present.set(path, set);
    }
    return set;
  };
  const stub = {
    capabilities: caps,
    usable: true,
    get mailbox() {
      return { uidValidity: 1n, readOnly: false, path: selected };
    },
    async list() {
      return entries.map((e) => ({
        path: e.path,
        name: e.name,
        specialUse: e.specialUse,
        flags: new Set(e.flags ?? []),
        listed: true,
      }));
    },
    async getMailboxLock(path: string) {
      selected = path;
      return { release() {} };
    },
    async search(query: { uid: string }) {
      const wanted = query.uid.split(",").map(Number);
      return wanted.filter((u) => have(selected).has(u));
    },
    async messageMove(range: string, destination: string) {
      log.push(`MOVE ${selected} ${range} -> ${destination}`);
      const uids = range.split(",").map(Number);
      for (const u of uids) have(selected).delete(u);
      return {
        path: selected,
        destination,
        uidValidity: 7n,
        ...(options.uidMap === false ? {} : { uidMap: new Map(uids.map((u) => [u, nextUid++])) }),
      };
    },
    async messageDelete(range: string) {
      log.push(`EXPUNGE ${selected} ${range}`);
      for (const u of range.split(",").map(Number)) have(selected).delete(u);
      return true;
    },
    async messageFlagsAdd(range: string, flags: string[], opts: { useLabels?: boolean }) {
      log.push(`ADD${opts.useLabels ? " LABELS" : ""} ${selected} ${range} ${flags.join(",")}`);
      return true;
    },
    async messageFlagsRemove(range: string, flags: string[], opts: { useLabels?: boolean }) {
      log.push(`REMOVE${opts.useLabels ? " LABELS" : ""} ${selected} ${range} ${flags.join(",")}`);
      return true;
    },
    async mailboxCreate(path: string) {
      log.push(`CREATE ${path}`);
      entries = [...entries, { path, name: path }];
      return { path, created: true };
    },
  };
  return { stub, log };
}

const at = (uid: number, folderId: string): MessageLocation => ({
  accountId: "acc1",
  folderId,
  uidValidity: "1",
  uid,
});

const gmailFolders: Entry[] = [
  { path: "INBOX", name: "INBOX" },
  { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All" },
  { path: "[Gmail]/Trash", name: "Trash", specialUse: "\\Trash" },
  { path: "[Gmail]/Spam", name: "Spam", specialUse: "\\Junk" },
];

function gmail(options: { capabilities?: string[]; uidMap?: boolean } = {}) {
  const { stub, log } = client(gmailFolders, options);
  const connection = { client: stub, gmail: true } as unknown as OpenConnection;
  return { moves: new ImapMoves(connection), log };
}

describe("Gmail: labels are the places (ADR 0044, rule 13) — not run against Gmail", () => {
  const all = "[Gmail]/All Mail";

  it("archives by taking the inbox label off, and moves no mail", async () => {
    const { moves, log } = gmail();
    const out = await moves.move([at(1, all), at(2, all)], "archive", { role: "archive" });
    expect(log).toEqual(["REMOVE LABELS [Gmail]/All Mail 1,2 \\Inbox"]);
    expect(out.map((r) => r.outcome)).toEqual([{ kind: "moved" }, { kind: "moved" }]);
  });

  it("puts a label on and takes the inbox label off to move to a label", async () => {
    const { moves, log } = gmail();
    const out = await moves.move([at(3, all)], "move", { folderId: "Clients" });
    expect(log).toEqual([
      "ADD LABELS [Gmail]/All Mail 3 Clients",
      "REMOVE LABELS [Gmail]/All Mail 3 \\Inbox",
    ]);
    expect(out[0]?.outcome).toEqual({ kind: "moved" });
  });

  it("puts the inbox label back for the Inbox", async () => {
    const { moves, log } = gmail();
    await moves.move([at(1, all)], "move", { role: "inbox" });
    expect(log).toEqual(["ADD LABELS [Gmail]/All Mail 1 \\Inbox"]);
  });

  it("moves to [Gmail]/Trash for Delete and to [Gmail]/Spam for Spam, and learns the new copy", async () => {
    const { moves, log } = gmail();
    const trash = await moves.move([at(1, all)], "delete", { role: "trash" });
    const spam = await moves.move([at(2, all)], "spam", { role: "spam" });
    expect(log).toEqual([
      "MOVE [Gmail]/All Mail 1 -> [Gmail]/Trash",
      "MOVE [Gmail]/All Mail 2 -> [Gmail]/Spam",
    ]);
    expect(trash[0]?.outcome).toMatchObject({
      kind: "moved",
      location: { folderId: "[Gmail]/Trash", uidValidity: "7" },
    });
    expect(spam[0]?.outcome).toMatchObject({
      kind: "moved",
      location: { folderId: "[Gmail]/Spam" },
    });
  });

  it("brings mail back from Trash by moving it, to All Mail for Archive and to the inbox for Inbox", async () => {
    const { moves, log } = gmail();
    await moves.move([at(1, "[Gmail]/Trash")], "archive", { role: "archive" });
    await moves.move([at(2, "[Gmail]/Spam")], "move", { role: "inbox" });
    expect(log).toEqual([
      "MOVE [Gmail]/Trash 1 -> [Gmail]/All Mail",
      "MOVE [Gmail]/Spam 2 -> INBOX",
    ]);
  });

  it("never expunges anywhere but the Trash", async () => {
    const { moves, log } = gmail();
    const out = await moves.expunge([at(1, all), at(1, "[Gmail]/Trash")]);
    expect(out.map((r) => r.outcome)).toEqual(["rejected", "done"]);
    expect(log).toEqual(["EXPUNGE [Gmail]/Trash 1"]);
  });
});

describe("IMAP without MOVE or UIDPLUS (ADR 0044, rule 13)", () => {
  const folders: Entry[] = [
    { path: "INBOX", name: "INBOX" },
    { path: "Archive", name: "Archive" },
    { path: "Trash", name: "Trash", specialUse: "\\Trash" },
  ];

  it("refuses to move or delete, because the fallback would expunge mail it was not asked to", async () => {
    const { stub, log } = client(folders, { capabilities: [] });
    const moves = new ImapMoves({ client: stub, gmail: false } as unknown as OpenConnection);
    const moved = await moves.move([at(1, "INBOX")], "archive", { role: "archive" });
    expect(moved[0]?.outcome).toEqual({ kind: "rejected" });
    const deleted = await moves.expunge([at(1, "Trash")]);
    expect(deleted[0]?.outcome).toBe("rejected");
    expect(log).toEqual([]);
  });

  it("moves with UIDPLUS alone, since the fallback then expunges only the UIDs it names", async () => {
    const { stub, log } = client(folders, { capabilities: ["UIDPLUS"] });
    const moves = new ImapMoves({ client: stub, gmail: false } as unknown as OpenConnection);
    const out = await moves.move([at(1, "INBOX")], "archive", { role: "archive" });
    expect(out[0]?.outcome.kind).toBe("moved");
    expect(log).toEqual(["MOVE INBOX 1 -> Archive"]);
  });

  it("says moved without a place when the server gives no UID map", async () => {
    const { stub } = client(folders, { uidMap: false });
    const moves = new ImapMoves({ client: stub, gmail: false } as unknown as OpenConnection);
    const out = await moves.move([at(1, "INBOX")], "archive", { role: "archive" });
    expect(out[0]?.outcome).toEqual({ kind: "moved" });
  });

  it("makes a missing folder once, and only for a role", async () => {
    const { stub, log } = client([{ path: "INBOX", name: "INBOX" }]);
    const moves = new ImapMoves({ client: stub, gmail: false } as unknown as OpenConnection);
    await moves.move([at(1, "INBOX"), at(2, "INBOX")], "delete", { role: "trash" });
    expect(log).toEqual(["CREATE Trash", "MOVE INBOX 1,2 -> Trash"]);
  });
});
