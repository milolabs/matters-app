import type { MessageLocation } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImapFlags, type OpenConnection } from "../src/index.ts";
import { Admin } from "./support/admin.ts";
import { ACCOUNT, Mailbox, Teardown } from "./support/harness.ts";
import { startHoodiecrow } from "./support/hoodiecrow.ts";
import { mail } from "./support/mail.ts";

const at = (uid: number, folderId = "INBOX", uidValidity = "1"): MessageLocation => ({
  accountId: "acc1",
  folderId,
  uidValidity,
  uid,
});

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** Just the ImapFlow surface the flag writes touch, scripted; records every call. */
function fakeClient(
  options: {
    uidValidity?: bigint;
    readOnly?: boolean;
    /** What a STORE answers: ImapFlow says `false` for a refusal and for a broken connection. */
    store?: (range: string) => boolean;
    usable?: boolean;
    lockError?: unknown;
  } = {},
) {
  const calls: Call[] = [];
  const note = (method: string, ...args: unknown[]) => calls.push({ method, args });
  let open: string | null = null;
  const client = {
    get usable() {
      return options.usable ?? true;
    },
    get mailbox() {
      return open
        ? {
            path: open,
            uidValidity: options.uidValidity ?? 1n,
            readOnly: options.readOnly ?? false,
          }
        : false;
    },
    async getMailboxLock(path: string, opts: unknown) {
      note("lock", path, opts);
      if (options.lockError) throw options.lockError;
      open = path;
      return { release: () => note("release", path) };
    },
    async messageFlagsAdd(range: string, flags: string[], opts: unknown) {
      note("add", range, flags, opts);
      return options.store ? options.store(range) : true;
    },
    async messageFlagsRemove(range: string, flags: string[], opts: unknown) {
      note("remove", range, flags, opts);
      return options.store ? options.store(range) : true;
    },
  };
  const flags = new ImapFlags({ client } as unknown as OpenConnection, ["hunter2"]);
  return { flags, calls, names: () => calls.map((c) => c.method) };
}

describe("ImapFlags with a scripted client", () => {
  it("opens the folder read-write, stores by UID and releases the lock", async () => {
    const c = fakeClient();
    const out = await c.flags.setSeen([at(7), at(3), at(7)], true);
    expect(out.map((r) => r.outcome)).toEqual(["done", "done", "done"]);
    expect(c.calls).toEqual([
      { method: "lock", args: ["INBOX", { readOnly: false }] },
      { method: "add", args: ["3,7", ["\\Seen"], { uid: true, silent: true }] },
      { method: "release", args: ["INBOX"] },
    ]);
  });

  it("removes the flag for unread", async () => {
    const c = fakeClient();
    await c.flags.setSeen([at(1)], false);
    expect(c.names()).toEqual(["lock", "remove", "release"]);
  });

  it("goes folder by folder, and answers in input order", async () => {
    const c = fakeClient({ store: (range) => range !== "9" });
    const out = await c.flags.setSeen([at(1, "A"), at(9, "B"), at(2, "A")], true);
    expect(out.map((r) => [r.location.folderId, r.outcome])).toEqual([
      ["A", "done"],
      ["B", "rejected"],
      ["A", "done"],
    ]);
    expect(c.names()).toEqual(["lock", "add", "release", "lock", "add", "release"]);
  });

  it("skips a copy whose UIDVALIDITY changed, without a STORE", async () => {
    const c = fakeClient({ uidValidity: 5n });
    const out = await c.flags.setSeen([at(1, "INBOX", "4"), at(2, "INBOX", "5")], true);
    expect(out.map((r) => r.outcome)).toEqual(["stale", "done"]);
    expect(c.calls.filter((x) => x.method === "add")[0]?.args[0]).toBe("2");

    const none = fakeClient({ uidValidity: 5n });
    expect((await none.flags.setSeen([at(1, "INBOX", "4")], true)).map((r) => r.outcome)).toEqual([
      "stale",
    ]);
    expect(none.names()).toEqual(["lock", "release"]);
  });

  it("refuses a read-only folder without asking the server to store anything", async () => {
    const c = fakeClient({ readOnly: true });
    expect((await c.flags.setSeen([at(1)], true)).map((r) => r.outcome)).toEqual(["rejected"]);
    expect(c.names()).toEqual(["lock", "release"]);
  });

  it("calls a refusal by a connection that is still up definite, and a dead one an error to retry", async () => {
    const refused = fakeClient({ store: () => false });
    expect((await refused.flags.setSeen([at(1)], true)).map((r) => r.outcome)).toEqual([
      "rejected",
    ]);

    const dead = fakeClient({ store: () => false, usable: false });
    await expect(dead.flags.setSeen([at(1)], true)).rejects.toMatchObject({ kind: "unreachable" });
    expect(dead.names()).toEqual(["lock", "add", "release"]);
  });

  it("splits a long list of UIDs into commands of 500", async () => {
    const c = fakeClient();
    const many = Array.from({ length: 1200 }, (_, i) => at(i + 1));
    await c.flags.setSeen(many, true);
    const stores = c.calls
      .filter((x) => x.method === "add")
      .map((x) => String(x.args[0]).split(",").length);
    expect(stores).toEqual([500, 500, 200]);
  });

  it("treats a folder that no longer exists as holding nothing", async () => {
    const c = fakeClient({
      lockError: Object.assign(new Error("no such folder"), { mailboxMissing: true }),
    });
    expect((await c.flags.setSeen([at(1)], true)).map((r) => r.outcome)).toEqual(["stale"]);
  });

  it("types other trouble like the rest of the adapter and scrubs the password", async () => {
    const c = fakeClient({
      lockError: Object.assign(new Error("read ECONNRESET while logged in with hunter2"), {
        code: "ECONNRESET",
      }),
    });
    const error = await c.flags.setSeen([at(1)], true).catch((e: Error) => e);
    expect(error).toMatchObject({ kind: "unreachable", name: "ImapUnreachableError" });
    expect((error as Error).message).not.toContain("hunter2");
    expect((error as Error).message).toContain("***");
  });
});

/** Whether the folder the connection has selected was opened read-only; undefined with none. */
const readOnly = (client: { mailbox: false | { readOnly?: boolean } }) =>
  client.mailbox ? client.mailbox.readOnly : undefined;

describe("ImapFlags against the in-process server", () => {
  const teardown = new Teardown();
  let admin: Admin;
  let box: Mailbox;

  beforeEach(async () => {
    const started = await startHoodiecrow([]);
    teardown.add(() => started.stop());
    const connected = await Admin.connect(started.credentials);
    admin = connected;
    teardown.add(() => connected.close());
    const opened = new Mailbox(started.credentials);
    box = opened;
    teardown.add(() => opened.close());
  });
  afterEach(() => teardown.run());

  const flagsOf = async (folder: string, uid: number) =>
    (await admin.messages(folder)).find((m) => m.uid === uid)?.flags ?? [];

  it("sets and clears \\Seen on the copies it is given, and on nothing else", async () => {
    const one = await admin.append("INBOX", mail({ id: "f1", subject: "jeden" }));
    const two = await admin.append("INBOX", mail({ id: "f2", subject: "dwa" }));
    await admin.createFolder("Archive");
    const copy = await admin.append("Archive", mail({ id: "f1", subject: "jeden" }));
    const validity = await admin.uidValidity("INBOX");
    const archiveValidity = await admin.uidValidity("Archive");

    const imap = await box.connect();
    try {
      const out = await imap.flags.setSeen(
        [at(one, "INBOX", validity), at(copy, "Archive", archiveValidity)],
        true,
      );
      expect(out.map((r) => r.outcome)).toEqual(["done", "done"]);
      expect(await flagsOf("INBOX", one)).toContain("\\Seen");
      expect(await flagsOf("Archive", copy)).toContain("\\Seen");
      expect(await flagsOf("INBOX", two)).not.toContain("\\Seen");

      await imap.flags.setSeen([at(one, "INBOX", validity)], false);
      expect(await flagsOf("INBOX", one)).not.toContain("\\Seen");
      expect(await flagsOf("Archive", copy)).toContain("\\Seen");
    } finally {
      await imap.close();
    }
  });

  it("leaves other flags alone", async () => {
    const uid = await admin.append("INBOX", mail({ id: "f3", subject: "trzy" }), ["\\Flagged"]);
    const validity = await admin.uidValidity("INBOX");
    const imap = await box.connect();
    try {
      await imap.flags.setSeen([at(uid, "INBOX", validity)], true);
      expect(await flagsOf("INBOX", uid)).toEqual(expect.arrayContaining(["\\Seen", "\\Flagged"]));
      await imap.flags.setSeen([at(uid, "INBOX", validity)], false);
      expect(await flagsOf("INBOX", uid)).toEqual(["\\Flagged"]);
    } finally {
      await imap.close();
    }
  });

  it("skips a copy of another UIDVALIDITY and a folder that is gone", async () => {
    const uid = await admin.append("INBOX", mail({ id: "f4", subject: "cztery" }));
    const imap = await box.connect();
    try {
      const out = await imap.flags.setSeen(
        [at(uid, "INBOX", "999999"), at(1, "Nigdzie", "1")],
        true,
      );
      expect(out.map((r) => r.outcome)).toEqual(["stale", "stale"]);
      expect(await flagsOf("INBOX", uid)).not.toContain("\\Seen");
    } finally {
      await imap.close();
    }
  });

  it("does not leave a sync on the same connection with a read-write folder", async () => {
    const uid = await admin.append("INBOX", mail({ id: "f5", subject: "pięć" }));
    const validity = await admin.uidValidity("INBOX");
    const imap = await box.connect();
    try {
      await imap.flags.setSeen([at(uid, "INBOX", validity)], true);
      const client = (imap as unknown as { connection: OpenConnection }).connection.client;
      expect(readOnly(client)).toBe(false);

      const folder = {
        id: "INBOX",
        accountId: "acc1",
        name: "INBOX",
        role: "inbox",
        exclusive: true,
      } as const;
      const batches = [];
      for await (const b of imap.syncFolder(ACCOUNT, folder, null, {
        knownProviderIds: async () => new Set(),
        storedUids: async () => [],
        unknownReplyToUids: async () => [],
        unknownAutomatedUids: async () => [],
        unknownAttachmentUids: async () => [],
      })) {
        batches.push(b);
      }
      expect(batches.length).toBeGreaterThan(0);
      expect(readOnly(client)).toBe(true);
      // Reading it for the sync did not flag anything beyond what we set.
      expect(await flagsOf("INBOX", uid)).toContain("\\Seen");
    } finally {
      await imap.close();
    }
  });
});
