// Received files through the sync runtime (ADR 0043): a real database and cache directory, fakes
// for the network. Progress throttling, joined downloads, two at a time, the start-up sweep and
// the demo server being used for the seed's account and nothing else.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileWork, createReceivedFiles } from "@matters/adapter-files";
import { registrableDomain } from "@matters/adapter-publicsuffix";
import { type RpcPort, serveCredentials } from "@matters/adapter-secrets";
import { NodemailerComposer } from "@matters/adapter-smtp";
import { createSqliteStorage, type SqliteStorage } from "@matters/adapter-sqlite";
import type {
  CachedFile,
  FileWorkPort,
  MailAttachmentPort,
  MailConnectorPort,
  MessageLocation,
  PartDownload,
  ReceivedFilesPort,
  StoredAccount,
} from "@matters/core";
import { approve, newSendOperation } from "@matters/core";
import {
  FakeComposeRenderer,
  FakeFileWork,
  FakeMailFlags,
  FakeMailMoves,
  FakeMailSubmit,
  FakeMessageComposer,
  FakeSentFolder,
  InMemoryCredentialStore,
  ManualClock,
  makeDocument,
  settle,
} from "@matters/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_HOST,
  DEMO_MESSAGES,
  DemoMail,
  demoLocation,
  demoStoredName,
  FIRST_FILE_PART,
} from "../src/backend/demoMail.ts";
import type {
  CommandResult,
  FromWorker,
  ToWorker,
  WorkerChannel,
  WorkerCommand,
} from "../src/backend/protocol.ts";
import { seedAttachmentDemo } from "../src/backend/seed.ts";
import { type SyncRuntime, startSyncRuntime, systemClock } from "../src/backend/syncRuntime.ts";

/** Separators and every override, embedding and isolate, built from code points. */
const BIDI_OR_SEPARATOR = new RegExp(
  `[/\\\\${String.fromCodePoint(0x202a)}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2066)}-${String.fromCodePoint(0x2069)}]`,
);

const ACCOUNT = "acc-1";
const account: StoredAccount = {
  id: ACCOUNT,
  address: "me@example.test",
  displayName: "Me",
  imap: { host: "127.0.0.1", port: 1, security: "none", username: "me" },
  createdAtMs: 1,
};

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A server whose parts arrive one chunk each time the test says so. */
class SteppedServer implements MailAttachmentPort {
  readonly requests: string[] = [];
  active = 0;
  peak = 0;
  private readonly steps: (() => void)[] = [];
  private readonly parts = new Map<string, Uint8Array[]>();

  put(uid: number, partId: string, ...chunks: Uint8Array[]): void {
    this.parts.set(`${uid}/${partId}`, chunks);
  }

  /** Lets one waiting chunk through. */
  next(): void {
    this.steps.shift()?.();
  }

  get waiting(): number {
    return this.steps.length;
  }

  async download(location: MessageLocation, partId: string): Promise<PartDownload> {
    this.requests.push(`${location.uid}/${partId}`);
    const chunks = this.parts.get(`${location.uid}/${partId}`);
    if (!chunks) return { kind: "gone" };
    const server = this;
    return {
      kind: "found",
      content: (async function* () {
        server.active++;
        server.peak = Math.max(server.peak, server.active);
        try {
          for (const chunk of chunks) {
            await new Promise<void>((resolve) => server.steps.push(resolve));
            yield chunk;
          }
        } finally {
          server.active--;
        }
      })(),
    };
  }
}

interface Rig {
  readonly storage: SqliteStorage;
  readonly server: SteppedServer;
  readonly messages: FromWorker[];
  readonly cacheDir: string;
  readonly clock: ManualClock;
  call<C extends WorkerCommand>(command: C): Promise<CommandResult<C>>;
  progress(): { messageKey: number; partId: string; bytes: number; totalBytes: number }[];
  stop(): Promise<void>;
}

async function open(
  options: {
    received?: (dir: string) => ReceivedFilesPort;
    demo?: DemoMail;
    seed?: (storage: SqliteStorage, dir: string) => Promise<void>;
    account?: StoredAccount;
    dir?: string;
    /** File work for the draft's own copies; a fake that reads nothing by default. */
    files?: (dir: string) => FileWorkPort;
    /** What the server holds, put there before the runtime starts and asks for it. */
    serve?: (server: SteppedServer) => void;
    /** Time as it is, for what depends on the age of files. */
    realTime?: boolean;
  } = {},
): Promise<Rig & { runtime: SyncRuntime }> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "matters-received-runtime-"));
  if (!options.dir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const cacheDir = join(dir, "received");
  const storage = createSqliteStorage(join(dir, "matters.db"), { reader: false });
  await storage.accounts.add(options.account ?? account);
  await options.seed?.(storage, cacheDir);
  const vault = new InMemoryCredentialStore();
  await vault.set(ACCOUNT, { kind: "password", username: "me", password: "pw" });

  const handlers: ((m: ToWorker) => void)[] = [];
  const messages: FromWorker[] = [];
  const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  let nextId = 0;
  let vaultHandler: (data: unknown) => void = () => {};
  const rpc: RpcPort = {
    postMessage: (data) => {
      for (const h of handlers) h({ type: "credentials", data });
    },
    onMessage: (h) => {
      vaultHandler = h;
    },
  };
  serveCredentials(rpc, vault);
  const channel: WorkerChannel = {
    post(message) {
      messages.push(message);
      if (message.type === "credentials") vaultHandler(message.data);
      if (message.type === "result") {
        const w = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.ok) w?.ok(message.value);
        else w?.fail(Object.assign(new Error(message.error.message), { name: message.error.name }));
      }
    },
    onMessage: (h) => handlers.push(h),
  };
  const server = new SteppedServer();
  options.serve?.(server);
  const connector: MailConnectorPort = {
    connect: async () => ({
      sync: {
        capabilities: new Set(),
        listFolders: async () => [],
        async *syncFolder() {},
      },
      sent: new FakeSentFolder(),
      flags: new FakeMailFlags(),
      moves: new FakeMailMoves(),
      attachments: server,
      close: async () => {},
      abort: () => {},
    }),
    watchInbox: async () => ({ close: async () => {} }),
  };
  const clock = new ManualClock();
  const runtime = await startSyncRuntime({
    storage,
    connector,
    channel,
    discovery: { discover: async () => null },
    registrableDomain,
    files: options.files ? options.files(dir) : new FakeFileWork(),
    clock: options.realTime ? systemClock : clock,
    received: (options.received ?? createReceivedFiles)(cacheDir),
    ...(options.demo ? { demo: options.demo } : {}),
    sending: {
      renderer: new FakeComposeRenderer(),
      composer: new FakeMessageComposer(),
      submit: new FakeMailSubmit(),
      sha256: (t) => createHash("sha256").update(t, "utf8").digest("hex"),
    },
  });
  cleanups.push(() => runtime.stop());
  return {
    storage,
    runtime,
    server,
    messages,
    cacheDir,
    clock,
    stop: () => runtime.stop(),
    progress: () =>
      messages.flatMap((m) =>
        m.type === "receivedProgress"
          ? [
              {
                messageKey: m.messageKey,
                partId: m.partId,
                bytes: m.bytes,
                totalBytes: m.totalBytes,
              },
            ]
          : [],
      ),
    call: <C extends WorkerCommand>(command: C) =>
      new Promise<CommandResult<C>>((ok, fail) => {
        const id = ++nextId;
        waiting.set(id, { ok: ok as (v: unknown) => void, fail });
        for (const h of handlers) h({ type: "command", id, command });
      }),
  };
}

/** A stored message with files at a place on the server, ready to ask for. */
async function seedMessage(
  storage: SqliteStorage,
  uid: number,
  files: { partId: string; name: string; size: number }[],
): Promise<number> {
  const doc = makeDocument({ providerId: `m${uid}`, hasAttachments: true, accountId: ACCOUNT });
  const [key] = (await storage.store.upsertMessages([doc.message])).keys;
  const location = { accountId: ACCOUNT, folderId: "INBOX", uidValidity: "1", uid };
  await storage.store.addLocations([{ key: key as number, location }]);
  await storage.store.setAttachments([
    {
      location,
      attachments: files.map((f) => ({
        ...f,
        mimeType: "application/octet-stream",
        inline: false,
      })),
    },
  ]);
  return key as number;
}

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe("fetching a received file through the runtime (ADR 0043, rules 6 and 7)", () => {
  it("writes the bytes to received/<key>/<part>/<name> and answers done", async () => {
    const rt = await open();
    const key = await seedMessage(rt.storage, 1, [{ partId: "2", name: "Faktura.pdf", size: 6 }]);
    rt.server.put(1, "2", bytes(3, 1), bytes(3, 2));

    const done = rt.call({ name: "fetchReceived", messageKey: key, partId: "2" });
    await vi.waitFor(() => expect(rt.server.waiting).toBe(1));
    rt.server.next();
    await vi.waitFor(() => expect(rt.server.waiting).toBe(1));
    rt.server.next();

    expect(await done).toEqual({ kind: "done" });
    const path = join(rt.cacheDir, String(key), "2", "Faktura.pdf");
    expect([...readFileSync(path)]).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it("posts progress at most four times a second, and not for every chunk", async () => {
    const rt = await open();
    const chunks = Array.from({ length: 6 }, (_, i) => bytes(1000, i));
    const key = await seedMessage(rt.storage, 1, [{ partId: "2", name: "big.bin", size: 6000 }]);
    rt.server.put(1, "2", ...chunks);
    const done = rt.call({ name: "fetchReceived", messageKey: key, partId: "2" });

    // The first report goes out at once.
    await vi.waitFor(() => expect(rt.server.waiting).toBe(1));
    rt.server.next();
    await vi.waitFor(() => expect(rt.progress()).toHaveLength(1));
    expect(rt.progress()[0]).toMatchObject({ bytes: 1000, totalBytes: 6000 });

    // Three chunks inside one interval: held back, and only the latest is kept.
    for (const ms of [50, 50, 50]) {
      await vi.waitFor(() => expect(rt.server.waiting).toBe(1));
      rt.server.next();
      await settle(5);
      await rt.clock.advance(ms);
    }
    expect(rt.progress()).toHaveLength(1);

    // The interval ends: the latest word is sent, not every one in between.
    await rt.clock.advance(150);
    expect(rt.progress().map((p) => p.bytes)).toEqual([1000, 4000]);

    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(rt.server.waiting).toBe(1));
      rt.server.next();
    }
    expect(await done).toEqual({ kind: "done" });
    // No stale report goes out after the download ended.
    await rt.clock.advance(1000);
    expect(rt.progress().at(-1)?.bytes).toBeLessThan(6000 + 1);
    expect(rt.progress().map((p) => p.partId)).toEqual(rt.progress().map(() => "2"));
  });

  it("names the part and the true expected size in every report", async () => {
    const rt = await open();
    const key = await seedMessage(rt.storage, 1, [{ partId: "2.1", name: "a.bin", size: 100 }]);
    rt.server.put(1, "2.1", bytes(10, 1));
    const done = rt.call({ name: "fetchReceived", messageKey: key, partId: "2.1" });
    await vi.waitFor(() => expect(rt.server.waiting).toBe(1));
    rt.server.next();
    await done;
    expect(rt.progress()).toEqual([{ messageKey: key, partId: "2.1", bytes: 10, totalBytes: 100 }]);
  });

  it("joins the same part asked for twice: one request to the server, one file", async () => {
    const rt = await open();
    const key = await seedMessage(rt.storage, 1, [{ partId: "2", name: "a.bin", size: 4 }]);
    rt.server.put(1, "2", bytes(4, 5));
    const a = rt.call({ name: "fetchReceived", messageKey: key, partId: "2" });
    const b = rt.call({ name: "fetchReceived", messageKey: key, partId: "2" });
    await vi.waitFor(() => expect(rt.server.waiting).toBe(1));
    rt.server.next();
    expect(await Promise.all([a, b])).toEqual([{ kind: "done" }, { kind: "done" }]);
    expect(rt.server.requests).toEqual(["1/2"]);
  });

  it("runs two downloads of one account at a time", async () => {
    const rt = await open();
    const parts = ["2", "3", "4"].map((partId) => ({ partId, name: `${partId}.bin`, size: 1 }));
    const key = await seedMessage(rt.storage, 1, parts);
    for (const p of parts) rt.server.put(1, p.partId, bytes(1, 1));
    const all = parts.map((p) =>
      rt.call({ name: "fetchReceived", messageKey: key, partId: p.partId }),
    );
    await vi.waitFor(() => expect(rt.server.waiting).toBe(2));
    await settle(10);
    expect(rt.server.active).toBe(2);
    expect(rt.server.requests).toHaveLength(2);
    rt.server.next();
    await vi.waitFor(() => expect(rt.server.requests).toHaveLength(3));
    rt.server.next();
    await vi.waitFor(() => expect(rt.server.waiting).toBeGreaterThan(0));
    rt.server.next();
    expect(await Promise.all(all)).toEqual(parts.map(() => ({ kind: "done" })));
    expect(rt.server.peak).toBe(2);
  });

  it("answers gone for a part the server no longer has, with nothing left in the cache", async () => {
    const rt = await open();
    const key = await seedMessage(rt.storage, 1, [{ partId: "2", name: "a.bin", size: 4 }]);
    expect(await rt.call({ name: "fetchReceived", messageKey: key, partId: "2" })).toEqual({
      kind: "gone",
    });
    expect(existsSync(join(rt.cacheDir, String(key), "2", "a.bin"))).toBe(false);
  });

  it("leaves no temporary file behind when the connection breaks off mid-part", async () => {
    const rt = await open();
    const key = await seedMessage(rt.storage, 1, [{ partId: "2", name: "a.bin", size: 4 }]);
    const original = rt.server.download.bind(rt.server);
    rt.server.download = async (location, partId) => {
      const part = await original(location, partId);
      if (part.kind !== "found") return part;
      return {
        kind: "found",
        content: (async function* () {
          for await (const chunk of part.content) {
            yield chunk;
            throw Object.assign(new Error("connection reset"), { kind: "unreachable" });
          }
        })(),
      };
    };
    rt.server.put(1, "2", bytes(2, 1), bytes(2, 2));
    const done = rt.call({ name: "fetchReceived", messageKey: key, partId: "2" });
    await vi.waitFor(() => expect(rt.server.waiting).toBe(1));
    rt.server.next();
    expect(await done).toMatchObject({ kind: "offline" });
    expect(readdirSync(join(rt.cacheDir, String(key), "2"))).toEqual([]);
  });

  it("answers gone for a part that no row describes", async () => {
    const rt = await open();
    expect(await rt.call({ name: "fetchReceived", messageKey: 5, partId: "2" })).toEqual({
      kind: "gone",
    });
  });
});

describe("the text of files the agent read (ADR 0087, rules 6 and 11)", () => {
  it("is emptied by the worker's clearFileText command, which answers how many files it held", async () => {
    const rt = await open();
    const key = await seedMessage(rt.storage, 1, [{ partId: "2", name: "a.pdf", size: 6 }]);
    await rt.storage.fileText.put(key, "2", { text: "one", pages: 1, state: "ok", extractedMs: 1 });
    await rt.storage.fileText.put(key, "3", {
      text: "",
      pages: 1,
      state: "no_text",
      extractedMs: 1,
    });
    expect(await rt.storage.fileText.count()).toBe(2);
    expect(await rt.call({ name: "clearFileText" })).toBe(2);
    expect(await rt.storage.fileText.count()).toBe(0);
    expect(await rt.call({ name: "clearFileText" })).toBe(0);
    // The message and the file it describes stay: only the copy of the text went.
    expect((await rt.storage.store.getAttachment(key, "2"))?.name).toBe("a.pdf");
  });
});

describe("the start-up sweep (ADR 0043, rule 8)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("trims the cache after launch and does not hold launch up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-received-sweep-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const old = join(dir, "received", "1", "2");
    const fresh = join(dir, "received", "2", "2");
    const partial = join(dir, "received", "3", "2");
    for (const d of [old, fresh, partial]) mkdirSync(d, { recursive: true });
    writeFileSync(join(old, "old.pdf"), "x");
    writeFileSync(join(fresh, "fresh.pdf"), "x");
    writeFileSync(join(partial, ".part-1"), "x");
    utimesSync(
      join(old, "old.pdf"),
      new Date(Date.now() - 9 * DAY),
      new Date(Date.now() - 9 * DAY),
    );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listed = false;
    const slow = (root: string): ReceivedFilesPort => {
      const real = createReceivedFiles(root);
      return {
        ...real,
        async list(): Promise<readonly CachedFile[]> {
          listed = true;
          await gate;
          return real.list();
        },
      };
    };
    // Resolving at all, with the sweep held, is the point: launch does not wait for it.
    const rt = await open({ dir, received: slow, realTime: true });
    await vi.waitFor(() => expect(listed).toBe(true));
    expect(existsSync(join(old, "old.pdf"))).toBe(true);

    release();
    await vi.waitFor(() => expect(existsSync(join(old, "old.pdf"))).toBe(false));
    expect(existsSync(join(fresh, "fresh.pdf"))).toBe(true);
    expect(existsSync(join(partial, ".part-1"))).toBe(false);
    expect(rt.messages.some((m) => m.type === "ready")).toBe(true);
  });
});

describe("removing with the account (ADR 0043, rule 8)", () => {
  it("deletes the account's downloaded copies with its mail", async () => {
    const rt = await open();
    const key = await seedMessage(rt.storage, 1, [{ partId: "2", name: "a.bin", size: 3 }]);
    rt.server.put(1, "2", bytes(3, 1));
    const done = rt.call({ name: "fetchReceived", messageKey: key, partId: "2" });
    await vi.waitFor(() => expect(rt.server.waiting).toBe(1));
    rt.server.next();
    await done;
    expect(existsSync(join(rt.cacheDir, String(key)))).toBe(true);

    expect(await rt.call({ name: "removeAccount", accountId: ACCOUNT })).toBe(true);
    expect(existsSync(join(rt.cacheDir, String(key)))).toBe(false);
  });
});

describe("the demo server (the seed only)", () => {
  const demoAccount: StoredAccount = {
    ...account,
    id: "acc1",
    imap: { host: DEMO_HOST, port: 143, security: "none", username: "me" },
  };

  async function demoRig(demo: boolean) {
    return open({
      account: demoAccount,
      ...(demo ? { demo: new DemoMail() } : {}),
      seed: (storage) => seedAttachmentDemo({ ...storage }),
    });
  }
  const keyOf = async (rt: { storage: SqliteStorage }, uid: number) => {
    const message = DEMO_MESSAGES.find((m) => m.uid === uid) as (typeof DEMO_MESSAGES)[number];
    const found = await rt.storage.store.findByProviderIds("acc1", [
      `seed-files-${DEMO_MESSAGES.indexOf(message)}`,
    ]);
    return [...found.values()][0] as number;
  };

  it("answers a download for the demo account with bytes and no network", async () => {
    const rt = await demoRig(true);
    const key = await keyOf(rt, 9001);
    expect(await rt.call({ name: "fetchReceived", messageKey: key, partId: "2" })).toEqual({
      kind: "done",
    });
    const file = readFileSync(join(rt.cacheDir, String(key), "2", "Faktura FV 2026-10-0417.pdf"));
    expect(file.byteLength).toBe(212_000);
    expect(rt.server.requests).toEqual([]);
  });

  it("is the same bytes every time, so a saved copy can be compared", async () => {
    const a = await demoRig(true);
    const b = await demoRig(true);
    const [ka, kb] = [await keyOf(a, 9001), await keyOf(b, 9001)];
    await a.call({ name: "fetchReceived", messageKey: ka, partId: "2" });
    await b.call({ name: "fetchReceived", messageKey: kb, partId: "2" });
    const name = "Faktura FV 2026-10-0417.pdf";
    expect(
      readFileSync(join(a.cacheDir, String(ka), "2", name)).equals(
        readFileSync(join(b.cacheDir, String(kb), "2", name)),
      ),
    ).toBe(true);
  });

  it("is not there without the seed: the same account goes to the real connector", async () => {
    const rt = await demoRig(false);
    const key = await keyOf(rt, 9001);
    // No password is stored for this account in the demo, and there is no demo server.
    const outcome = await rt.call({ name: "fetchReceived", messageKey: key, partId: "2" });
    expect(outcome.kind).not.toBe("done");
    expect(existsSync(join(rt.cacheDir, String(key)))).toBe(false);
  });

  it("serves the demo account only", () => {
    const demo = new DemoMail();
    expect(demo.serves(demoAccount)).toBe(true);
    expect(demo.serves(account)).toBe(false);
    expect(demo.serves({ ...demoAccount, id: "other" })).toBe(false);
    expect(
      demo.serves({ ...demoAccount, imap: { ...demoAccount.imap, host: "imap.gmail.com" } }),
    ).toBe(false);
  });

  it("fails the first try of the file that is offline once, and then works", async () => {
    const demo = new DemoMail();
    const connection = demo.connection();
    const location = demoLocation(9004);
    await expect(connection.attachments.download(location, "2")).rejects.toMatchObject({
      kind: "unreachable",
    });
    const second = await connection.attachments.download(location, "2");
    expect(second.kind).toBe("found");
  });

  it("says gone for the file that is gone and for anything it does not hold", async () => {
    const connection = new DemoMail().connection();
    expect(await connection.attachments.download(demoLocation(9004), "3")).toEqual({
      kind: "gone",
    });
    expect(await connection.attachments.download(demoLocation(1), "2")).toEqual({ kind: "gone" });
    expect(await connection.attachments.download(demoLocation(9001), "9")).toEqual({
      kind: "gone",
    });
    expect(
      await connection.attachments.download({ ...demoLocation(9001), accountId: "other" }, "2"),
    ).toEqual({ kind: "gone" });
  });

  it("makes a file as large as the row says, slowly enough to watch when it is large", async () => {
    const connection = new DemoMail().connection();
    const part = await connection.attachments.download(demoLocation(9003), "2");
    if (part.kind !== "found") throw new Error("expected a part");
    let total = 0;
    let chunks = 0;
    for await (const chunk of part.content) {
      total += chunk.byteLength;
      if (++chunks === 3) break;
    }
    expect(total).toBe(3 * 128 * 1024);
  });
});

describe("the demo mail itself", () => {
  it("has the variety the states need: long, Polish, runnable, tricky, several, many", () => {
    const names = DEMO_MESSAGES.flatMap((m) => m.files.map((f) => demoStoredName(f)));
    expect(names.some((n) => new TextEncoder().encode(n).length > 100)).toBe(true);
    expect(names.some((n) => /[ąćęłńóśźż]/i.test(n))).toBe(true);
    expect(names.some((n) => n.endsWith(".command"))).toBe(true);
    expect(DEMO_MESSAGES.some((m) => m.files.length === 1)).toBe(true);
    expect(DEMO_MESSAGES.some((m) => m.files.length >= 2)).toBe(true);
    expect(DEMO_MESSAGES.some((m) => m.files.length > 5)).toBe(true);
    expect(DEMO_MESSAGES.some((m) => m.files.some((f) => f.size >= 1_048_576 * 8))).toBe(true);
  });

  it("passes the tricky names through safeFileName: nothing left to reorder or climb", () => {
    for (const m of DEMO_MESSAGES) {
      for (const f of m.files) {
        const stored = demoStoredName(f);
        expect(stored).not.toMatch(BIDI_OR_SEPARATOR);
        expect(stored.startsWith(".")).toBe(false);
      }
    }
    const raw = DEMO_MESSAGES.flatMap((m) => m.files.map((f) => f.name));
    expect(raw.some((n) => n.includes(String.fromCodePoint(0x202e)))).toBe(true);
    expect(raw.some((n) => n.includes("../"))).toBe(true);
  });

  it("is stored as real rows, with part numbers after the text, and a place on the server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-demo-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const storage = createSqliteStorage(join(dir, "matters.db"), { reader: false });
    cleanups.push(() => storage.close());
    await seedAttachmentDemo({ ...storage });
    const first = DEMO_MESSAGES[1] as (typeof DEMO_MESSAGES)[number];
    const found = await storage.store.findByProviderIds("acc1", ["seed-files-1"]);
    const key = [...found.values()][0] as number;
    const message = (await storage.store.getByKeys([key]))[0];
    const view = await storage.store.getThread(message?.threadId as string);
    const files = view?.attachments.get(key);
    expect(files?.known).toBe(true);
    expect(files?.items.map((f) => f.partId)).toEqual(
      first.files.map((_, i) => String(i + FIRST_FILE_PART)),
    );
    expect(await storage.store.getLocations(key)).toEqual([demoLocation(first.uid)]);
    expect(message?.hasAttachments).toBe(true);
    expect(await storage.store.listUnknownAttachmentUids("acc1", "INBOX", "1", 50)).toEqual([]);
  });
});

// --- Forwarded files through the runtime (ADR 0045) ---

describe("forwarded files through the runtime (ADR 0045, rules 7 and 9)", () => {
  const draftContent = {
    accountId: ACCOUNT,
    from: { address: "me@example.test" },
    to: [{ address: "jan@example.test" }],
    cc: [],
    bcc: [],
    subject: "Fwd: Faktura",
    bodyMarkdown: "Zobacz.",
    inReplyTo: "",
    references: [],
    forwarded: true,
  };

  /** Real copies on a real disk, from the cache the runtime downloads into. */
  const realFiles = (dir: string): FileWorkPort =>
    createFileWork(
      { attachments: join(dir, "attachments"), spool: join(dir, "spool") },
      (input, parts) => new NodemailerComposer().composeToStream(input, parts),
    );

  it("downloads the part, copies it to the draft's own, and tells the windows as it goes", async () => {
    const rt = await open({ files: realFiles, realTime: true });
    const key = await seedMessage(rt.storage, 1, [
      { partId: "2", name: "Faktura.pdf", size: 4000 },
    ]);
    rt.server.put(1, "2", bytes(2000, 1), bytes(2000, 2));
    const draft = await rt.call({ name: "saveDraft", content: draftContent });

    const rows = await rt.call({
      name: "addForwardedAttachments",
      draftId: draft.id,
      files: [{ id: "fw-1", messageKey: key, partId: "2" }],
    });
    expect(rows).toEqual([
      {
        id: "fw-1",
        name: "Faktura.pdf",
        size: 4000,
        state: "reading",
        reason: null,
        canRetry: false,
        forwarded: true,
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/cache|received|origin|messageKey/);

    await vi.waitFor(() => expect(rt.server.waiting).toBe(1));
    rt.server.next();
    await vi.waitFor(() => expect(rt.server.waiting).toBe(1));
    rt.server.next();
    await vi.waitFor(async () =>
      expect((await rt.storage.attachments.get("fw-1"))?.state).toBe("ready"),
    );

    const row = await rt.storage.attachments.get("fw-1");
    expect(row).toMatchObject({
      size: 4000,
      sourcePath: null,
      origin: { messageKey: key, partId: "2" },
    });
    // The draft's copy is its own file, the cache's stays where the sweep can find it.
    const copy = readFileSync(join(rt.cacheDir, "..", "attachments", "fw-1"));
    expect([...copy.subarray(0, 3)]).toEqual([1, 1, 1]);
    expect(copy.byteLength).toBe(4000);
    expect(readFileSync(join(rt.cacheDir, String(key), "2", "Faktura.pdf")).equals(copy)).toBe(
      true,
    );
    expect(rt.messages.some((m) => m.type === "attachments" && m.draftId === draft.id)).toBe(true);
    expect(rt.messages.some((m) => m.type === "attachmentProgress" && m.id === "fw-1")).toBe(true);
  });

  /** What a quit in the middle of a download leaves: a draft, its row still reading, no cache copy. */
  async function leftByQuit(storage: SqliteStorage, withSend: boolean): Promise<number> {
    const key = await seedMessage(storage, 1, [{ partId: "2", name: "Faktura.pdf", size: 6 }]);
    const draft = {
      ...draftContent,
      id: "d1",
      version: 1,
      fingerprint: "f".repeat(64),
      updatedAtMs: 1,
      attachments: [
        { id: "fw-1", name: "Faktura.pdf", size: 6, delivery: { kind: "inline" as const } },
      ],
    };
    await storage.drafts.put(draft);
    await storage.attachments.add({
      id: "fw-1",
      draftId: "d1",
      accountId: ACCOUNT,
      name: "Faktura.pdf",
      size: 6,
      state: "reading",
      reason: null,
      sha256: null,
      sourcePath: null,
      sourceMtimeMs: null,
      origin: { messageKey: key, partId: "2" },
      createdAtMs: 1,
    });
    if (withSend) {
      await storage.outbox.enqueue(
        newSendOperation({
          id: "op1",
          approval: approve(draft, null, 1),
          accountId: ACCOUNT,
          summary: "Fwd: Faktura",
          nowMs: 1,
          notBeforeMs: 2,
          encodedBytes: 0,
        }),
      );
    }
    return key;
  }

  it("after a quit, the next start downloads the file again, and it does not stay reading", async () => {
    const rt = await open({
      files: realFiles,
      realTime: true,
      serve: (server) => server.put(1, "2", bytes(3, 7), bytes(3, 8)),
      seed: async (storage) => {
        await leftByQuit(storage, false);
      },
    });
    await vi.waitFor(() => expect(rt.server.waiting).toBe(1));
    rt.server.next();
    await vi.waitFor(() => expect(rt.server.waiting).toBe(1));
    rt.server.next();
    await vi.waitFor(async () =>
      expect((await rt.storage.attachments.get("fw-1"))?.state).toBe("ready"),
    );
    const copy = readFileSync(join(rt.cacheDir, "..", "attachments", "fw-1"));
    expect([...copy]).toEqual([7, 7, 7, 8, 8, 8]);
  });

  it("a file that cannot be had on the next start fails, and fails the send that waited for it", async () => {
    const rt = await open({
      files: realFiles,
      realTime: true,
      // Nothing on the server: the message has left it.
      seed: async (storage) => {
        await leftByQuit(storage, true);
      },
    });
    await vi.waitFor(async () =>
      expect(await rt.storage.attachments.get("fw-1")).toMatchObject({
        state: "failed",
        reason: "No longer on the server",
      }),
    );
    await vi.waitFor(async () =>
      expect((await rt.storage.outbox.get("op1"))?.state).toEqual({
        kind: "failed",
        reason: "Faktura.pdf: No longer on the server",
        action: "openDraft",
      }),
    );
  });
});
