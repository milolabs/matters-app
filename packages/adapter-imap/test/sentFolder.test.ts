import type { Account } from "@matters/core";
import { describe, expect, it } from "vitest";
import { type OpenConnection, providerIdOf } from "../src/index.ts";
import { ImapSentFolder } from "../src/sentFolder.ts";

const account: Account = {
  id: "acc1",
  address: "me@example.com",
  displayName: "Me",
  capabilities: [],
};

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** Just the ImapFlow surface the Sent folder touches, scripted; records every call. */
function fakeClient(options: {
  folders: { path: string; name: string; specialUse?: string }[];
  /** uids a search returns, by kind of query */
  gmrawHits?: number[];
  headerHits?: number[];
  fetched?: { emailId?: string; size?: number; envelope?: { messageId: string; date: Date } };
  appended?: { uid?: number; uidValidity?: bigint } | false;
}) {
  const calls: Call[] = [];
  const note = (method: string, ...args: unknown[]) => calls.push({ method, args });
  let open: string | null = null;
  const client = {
    get mailbox() {
      return open ? { path: open, uidValidity: 42n } : false;
    },
    async list() {
      note("list");
      return options.folders.map((f) => ({ ...f, flags: new Set<string>() }));
    },
    async getMailboxLock(path: string, opts: unknown) {
      note("lock", path, opts);
      open = path;
      return { release: () => note("release", path) };
    },
    async search(query: Record<string, unknown>, opts: unknown) {
      note("search", query, opts);
      return "gmraw" in query ? (options.gmrawHits ?? []) : (options.headerHits ?? []);
    },
    async fetchOne(seq: string, query: unknown, opts: unknown) {
      note("fetchOne", seq, query, opts);
      return options.fetched ?? false;
    },
    async append(path: string, content: Buffer, flags: string[], date: Date) {
      note("append", path, content.length, flags, date instanceof Date);
      return options.appended === false
        ? false
        : { destination: path, uidValidity: 42n, uid: 7, ...options.appended };
    },
  };
  return { client, calls, names: () => calls.map((c) => c.method) };
}

const connection = (client: unknown, gmail: boolean, objectId = false) =>
  ({ client, gmail, objectId, capabilities: new Set() }) as unknown as OpenConnection;

const GMAIL_FOLDERS = [
  { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All" },
  { path: "[Gmail]/Sent Mail", name: "Sent Mail", specialUse: "\\Sent" },
];

describe("ImapSentFolder on Gmail", () => {
  it("finds a message by X-GM-RAW rfc822msgid in All Mail and returns its gm: id", async () => {
    const f = fakeClient({
      folders: GMAIL_FOLDERS,
      gmrawHits: [901],
      fetched: { emailId: "1812345" },
    });
    const sent = new ImapSentFolder(connection(f.client, true));
    const found = await sent.findByMessageId(account, "<abc@example.com>");

    expect(found).toEqual({ providerId: "gm:1812345" });
    const lock = f.calls.find((c) => c.method === "lock");
    expect(lock?.args[0]).toBe("[Gmail]/All Mail");
    expect(lock?.args[1]).toEqual({ readOnly: true });
    const search = f.calls.find((c) => c.method === "search");
    expect(search?.args[0]).toEqual({ gmraw: "rfc822msgid:<abc@example.com>" });
    expect(search?.args[1]).toEqual({ uid: true });
    expect(f.names()).toContain("release");
  });

  it("reports a message that is not there as null", async () => {
    const f = fakeClient({ folders: GMAIL_FOLDERS, gmrawHits: [] });
    const sent = new ImapSentFolder(connection(f.client, true));
    expect(await sent.findByMessageId(account, "<nope@example.com>")).toBeNull();
    expect(f.names()).not.toContain("fetchOne");
    expect(f.names().filter((n) => n === "lock")).toHaveLength(1);
    expect(f.names().filter((n) => n === "release")).toHaveLength(1);
  });

  it("never appends: Gmail files what it accepted", async () => {
    const f = fakeClient({ folders: GMAIL_FOLDERS });
    const sent = new ImapSentFolder(connection(f.client, true));
    await expect(sent.append(account, new Uint8Array([1]))).rejects.toThrow(/own copy/);
    expect(f.names()).not.toContain("append");
  });
});

describe("ImapSentFolder elsewhere", () => {
  const folders = [
    { path: "INBOX", name: "INBOX" },
    { path: "Sent", name: "Sent", specialUse: "\\Sent" },
  ];
  const raw = new TextEncoder().encode(
    "Message-ID: <m1@example.com>\r\nSubject: Hi\r\n\r\nbody\r\n",
  );
  const date = new Date("2026-11-03T12:05:07Z");

  it("appends to the SPECIAL-USE Sent folder as read and returns the id sync will compute", async () => {
    const f = fakeClient({
      folders,
      fetched: { size: raw.length, envelope: { messageId: "<m1@example.com>", date } },
    });
    const sent = new ImapSentFolder(connection(f.client, false));
    const copy = await sent.append(account, raw);

    const append = f.calls.find((c) => c.method === "append");
    expect(append?.args).toEqual(["Sent", raw.length, ["\\Seen"], true]);
    expect(copy.location).toEqual({
      accountId: "acc1",
      folderId: "Sent",
      uidValidity: "42",
      uid: 7,
    });
    expect(copy.providerId).toBe(
      providerIdOf({
        folderId: "Sent",
        uidValidity: "42",
        uid: 7,
        emailId: undefined,
        emailIdKind: "none",
        messageId: "<m1@example.com>",
        dateMs: date.getTime(),
        size: raw.length,
      }),
    );
    expect(copy.providerId).toMatch(/^fp:/);
  });

  it("finds the stored message by Message-ID when the server does not report the UID", async () => {
    const f = fakeClient({
      folders,
      appended: { uid: undefined as unknown as number },
      headerHits: [11],
      fetched: { size: raw.length, envelope: { messageId: "<m1@example.com>", date } },
    });
    const sent = new ImapSentFolder(connection(f.client, false));
    const copy = await sent.append(account, raw);
    expect(copy.location.uid).toBe(11);
    const search = f.calls.find((c) => c.method === "search");
    expect(search?.args[0]).toEqual({ header: { "message-id": "<m1@example.com>" } });
  });

  it("looks in the Sent folder by header, not in All Mail", async () => {
    const f = fakeClient({
      folders,
      headerHits: [5],
      fetched: { size: 10, envelope: { messageId: "<m1@example.com>", date } },
    });
    const sent = new ImapSentFolder(connection(f.client, false));
    const found = await sent.findByMessageId(account, "<m1@example.com>");
    expect(found?.providerId).toMatch(/^fp:/);
    expect(f.calls.find((c) => c.method === "lock")?.args[0]).toBe("Sent");
    expect(f.calls.some((c) => c.method === "search" && "gmraw" in (c.args[0] as object))).toBe(
      false,
    );
  });

  it("says so when there is no Sent folder", async () => {
    const f = fakeClient({ folders: [{ path: "INBOX", name: "INBOX" }] });
    const sent = new ImapSentFolder(connection(f.client, false));
    await expect(sent.append(account, raw)).rejects.toThrow(/No sent folder/);
  });

  it("falls back to the folder name when SPECIAL-USE is missing", async () => {
    const f = fakeClient({
      folders: [
        { path: "INBOX", name: "INBOX" },
        { path: "Wysłane", name: "Wysłane" },
      ],
      fetched: { size: raw.length, envelope: { messageId: "<m1@example.com>", date } },
    });
    const copy = await new ImapSentFolder(connection(f.client, false)).append(account, raw);
    expect(copy.location.folderId).toBe("Wysłane");
  });
});
