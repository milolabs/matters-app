// The sync runtime's file and send wiring (ADR 0041) over a real database file and fakes for the
// network and the disk: lanes, Stop, quitting during an upload, progress, start-up clean-up.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registrableDomain } from "@matters/adapter-publicsuffix";
import { type RpcPort, serveCredentials } from "@matters/adapter-secrets";
import { createSqliteStorage, type SqliteStorage } from "@matters/adapter-sqlite";
import type {
  DraftContent,
  MailConnectorPort,
  SendOperation,
  StoredAccount,
  StoredAttachment,
} from "@matters/core";
import {
  FakeComposeRenderer,
  FakeFileWork,
  FakeMailAttachments,
  FakeMailFlags,
  FakeMailMoves,
  FakeMailSubmit,
  FakeMessageComposer,
  FakeSentFolder,
  InMemoryCredentialStore,
} from "@matters/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CommandResult,
  FromWorker,
  ToWorker,
  WorkerChannel,
  WorkerCommand,
} from "../src/backend/protocol.ts";
import { type SyncRuntime, startSyncRuntime } from "../src/backend/syncRuntime.ts";

const ACCOUNT = "acc-1";
const account: StoredAccount = {
  id: ACCOUNT,
  address: "me@example.test",
  displayName: "Me",
  imap: { host: "127.0.0.1", port: 1, security: "none", username: "me" },
  smtp: { host: "127.0.0.1", port: 2, security: "none", username: "me" },
  createdAtMs: 1,
};
const LARGE = new Uint8Array(1_000_000).fill(7);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Rig {
  readonly storage: SqliteStorage;
  readonly runtime: SyncRuntime;
  readonly files: FakeFileWork;
  readonly submit: FakeMailSubmit;
  readonly messages: FromWorker[];
  readonly dbPath: string;
  call<C extends WorkerCommand>(command: C): Promise<CommandResult<C>>;
}

async function open(
  options: {
    dir?: string;
    files?: FakeFileWork;
    seed?: (storage: SqliteStorage) => Promise<void>;
    undoWindowMs?: number;
  } = {},
): Promise<Rig> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "matters-runtime-"));
  if (!options.dir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "matters.db");
  const storage = createSqliteStorage(dbPath, { reader: false });
  if (!(await storage.accounts.get(ACCOUNT))) await storage.accounts.add(account);
  await options.seed?.(storage);
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
  const connector: MailConnectorPort = {
    connect: async () => ({
      sync: {
        capabilities: new Set(["savesSent"]),
        listFolders: async () => [],
        async *syncFolder() {},
      },
      sent: new FakeSentFolder(),
      flags: new FakeMailFlags(),
      moves: new FakeMailMoves(),
      attachments: new FakeMailAttachments(),
      close: async () => {},
      abort: () => {},
    }),
    watchInbox: async () => ({ close: async () => {} }),
  };
  const files = options.files ?? new FakeFileWork();
  const submit = new FakeMailSubmit();
  const runtime = await startSyncRuntime({
    storage,
    connector,
    channel,
    discovery: { discover: async () => null },
    registrableDomain,
    files,
    undoWindowMs: options.undoWindowMs ?? 50,
    sending: {
      renderer: new FakeComposeRenderer(),
      composer: new FakeMessageComposer(),
      submit,
      sha256: (t) => createHash("sha256").update(t, "utf8").digest("hex"),
    },
  });
  cleanups.push(() => runtime.stop());
  return {
    storage,
    runtime,
    files,
    submit,
    messages,
    dbPath,
    call: <C extends WorkerCommand>(command: C) =>
      new Promise<CommandResult<C>>((ok, fail) => {
        const id = ++nextId;
        waiting.set(id, { ok: ok as (v: unknown) => void, fail });
        for (const h of handlers) h({ type: "command", id, command });
      }),
  };
}

const content = (subject: string, attachments: DraftContent["attachments"] = []): DraftContent => ({
  accountId: ACCOUNT,
  from: { address: account.address },
  to: [{ address: "anna@northwind.example" }],
  cc: [],
  bcc: [],
  subject,
  bodyMarkdown: "Hello",
  inReplyTo: "",
  references: [],
  ...(attachments.length === 0 ? {} : { attachments }),
});

/** A draft with one file attached and ready, ready to send. */
async function draftWithFile(rt: Rig, subject: string, id: string, bytes: Uint8Array) {
  const draft = await rt.call({ name: "saveDraft", content: content(subject) });
  const path = `/files/${id}.bin`;
  rt.files.addFile(path, bytes);
  await rt.call({
    name: "addAttachments",
    draftId: draft.id,
    files: [{ id, name: `${id}.bin`, size: bytes.byteLength, sourcePath: path }],
  });
  await vi.waitFor(async () => expect((await rt.storage.attachments.get(id))?.state).toBe("ready"));
  return rt.call({
    name: "saveDraft",
    id: draft.id,
    content: content(subject, [
      { id, name: `${id}.bin`, size: bytes.byteLength, delivery: { kind: "inline" } },
    ]),
  });
}

const op = async (rt: Rig, id: string) => (await rt.storage.outbox.get(id)) as SendOperation;
const until = (rt: Rig, id: string, kind: string, timeout = 5000) =>
  vi.waitFor(async () => expect((await op(rt, id)).state.kind).toBe(kind), {
    timeout,
    interval: 10,
  });
const never = new Promise<void>(() => {});

describe("one runner for each lane", () => {
  it("lets a small send overtake a large one that is still going", async () => {
    const rt = await open();
    let release: () => void = () => {};
    rt.submit.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Only the large message waits on the server (the fake's spool holds the raw bytes).
    rt.submit.gateWhen = (source) => source.size > 500_000;

    const bigDraft = await draftWithFile(rt, "Big", "big", LARGE);
    const big = await rt.call({ name: "requestSend", draftId: bigDraft.id });
    expect(big.encodedBytes).toBeGreaterThanOrEqual(1_048_576);
    await vi.waitFor(() => expect(rt.submit.submissions).toHaveLength(1), { timeout: 5000 });
    expect((await op(rt, big.id)).state.kind).toBe("running");

    const reply = await rt.call({ name: "saveDraft", content: content("Reply") });
    const small = await rt.call({ name: "requestSend", draftId: reply.id });
    await until(rt, small.id, "succeeded");
    // The large one is still on its way; the small one did not wait for it.
    expect((await op(rt, big.id)).state.kind).toBe("running");

    release();
    await until(rt, big.id, "succeeded");
    expect(rt.submit.submissions.map((s) => s.envelope.size)).toHaveLength(2);
    // Its files and spool go with the follow-up.
    await vi.waitFor(() => expect(rt.files.spools.size).toBe(0));
    expect(await rt.storage.attachments.get("big")).toBeNull();
  });

  it("reports the bytes handed over as progress, which is shown and never stored", async () => {
    const rt = await open();
    const draft = await draftWithFile(rt, "Progress", "p", LARGE);
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    await until(rt, sent.id, "succeeded");
    const progress = rt.messages.filter((m) => m.type === "sendProgress");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toMatchObject({ operationId: sent.id, totalBytes: expect.any(Number) });
    // Nothing of it reached the database: the operation row has no such column to hold it.
    expect(JSON.stringify(await op(rt, sent.id))).not.toContain("sentBytes");
  });
});

describe("Stop and quit", () => {
  it("Stop cuts an upload short and the send is cancelled, not unknown", async () => {
    const rt = await open();
    rt.submit.gate = never;
    const draft = await draftWithFile(rt, "Stop me", "s", LARGE);
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    await vi.waitFor(() => expect(rt.submit.submissions).toHaveLength(1), { timeout: 5000 });

    expect(await rt.call({ name: "sendAction", operationId: sent.id, action: "stop" })).toBe(true);
    await until(rt, sent.id, "cancelled");
    // The draft and its file stay: Stop is not Discard.
    expect(await rt.storage.drafts.get(draft.id)).not.toBeNull();
    expect((await rt.storage.attachments.get("s"))?.state).toBe("ready");
    // Nothing runs any more, so a second Stop has nothing to cut.
    expect(await rt.call({ name: "sendAction", operationId: sent.id, action: "stop" })).toBe(false);
    expect(await rt.call({ name: "sendAction", operationId: "nobody", action: "stop" })).toBe(
      false,
    );
  });

  it("quitting aborts an upload before waiting for it: it comes back held, not unknown", async () => {
    const rt = await open();
    rt.submit.gate = never;
    const draft = await draftWithFile(rt, "Quit me", "q", LARGE);
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    await vi.waitFor(() => expect(rt.submit.submissions).toHaveLength(1), { timeout: 5000 });

    const started = Date.now();
    await rt.runtime.stop();
    // The 2.5 s the rest may take was not needed: the upload was cut at once.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(rt.messages.at(-1)).toEqual({ type: "stopped" });

    const again = createSqliteStorage(rt.dbPath, { reader: false });
    cleanups.push(() => again.close());
    const stored = (await again.outbox.get(sent.id)) as SendOperation;
    expect(stored.state.kind).toBe("held");
    expect(await again.drafts.get(draft.id)).not.toBeNull();
  });
});

describe("attachments through the worker's commands", () => {
  it("answers at once with the rows, then announces the copy, its progress and its end", async () => {
    const rt = await open();
    const draft = await rt.call({ name: "saveDraft", content: content("Files") });
    let finish: () => void = () => {};
    rt.files.addFile("/files/a.pdf", new Uint8Array(5000));
    finish = rt.files.hold("/files/a.pdf");

    const rows = await rt.call({
      name: "addAttachments",
      draftId: draft.id,
      files: [{ id: "a1", name: "a.pdf", size: 5000, sourcePath: "/files/a.pdf" }],
    });
    // The answer is the page's view of the row: no path, no hash.
    expect(rows).toEqual([
      {
        id: "a1",
        name: "a.pdf",
        size: 5000,
        state: "reading",
        reason: null,
        canRetry: false,
        forwarded: false,
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/files|sha256/);
    expect(rt.messages.some((m) => m.type === "captured")).toBe(false);

    finish();
    await vi.waitFor(() => expect(rt.messages).toContainEqual({ type: "captured", ids: ["a1"] }));
    expect((await rt.storage.attachments.get("a1"))?.state).toBe("ready");
    expect(rt.messages.filter((m) => m.type === "attachments").length).toBeGreaterThanOrEqual(2);
    expect(rt.messages).toContainEqual({ type: "attachments", draftId: draft.id });
    expect(rt.messages).toContainEqual({ type: "attachmentProgress", id: "a1", fraction: 0 });
  });

  it("notices a changed original and reads it again as a new attachment", async () => {
    const rt = await open();
    const draft = await rt.call({ name: "saveDraft", content: content("Files") });
    rt.files.addFile("/files/a.pdf", new Uint8Array(10), 1000);
    await rt.call({
      name: "addAttachments",
      draftId: draft.id,
      files: [{ id: "a1", name: "a.pdf", size: 10, sourcePath: "/files/a.pdf" }],
    });
    await vi.waitFor(async () =>
      expect((await rt.storage.attachments.get("a1"))?.state).toBe("ready"),
    );
    expect(await rt.call({ name: "checkAttachmentSources", draftId: draft.id })).toEqual([]);
    rt.files.addFile("/files/a.pdf", new Uint8Array(20), 2000);
    expect(await rt.call({ name: "checkAttachmentSources", draftId: draft.id })).toEqual(["a1"]);

    const fresh = await rt.call({ name: "recaptureAttachment", draftId: draft.id, id: "a1" });
    expect(fresh).toMatchObject({ name: "a.pdf", state: "reading" });
    expect(fresh?.id).not.toBe("a1");
    expect(
      await rt.call({ name: "recaptureAttachment", draftId: draft.id, id: "nope" }),
    ).toBeNull();
  });

  it("asks the server for its limit and keeps the answer", async () => {
    const rt = await open();
    rt.submit.outgoing = { ok: true, limitBytes: 25_000_000 };
    expect(await rt.call({ name: "probeMessageLimit", accountId: ACCOUNT })).toBe(25_000_000);
    expect((await rt.storage.accounts.get(ACCOUNT))?.messageLimitBytes).toBe(25_000_000);
    expect(rt.submit.verified).toHaveLength(1);
  });

  it("removing an account removes its files and stored copies", async () => {
    const rt = await open();
    const draft = await draftWithFile(rt, "Gone", "g", new Uint8Array(100));
    expect(rt.files.stored.has("g")).toBe(true);
    expect(await rt.call({ name: "removeAccount", accountId: ACCOUNT })).toBe(true);
    expect(await rt.storage.attachments.get("g")).toBeNull();
    expect(rt.files.stored.has("g")).toBe(false);
    expect(await rt.storage.drafts.get(draft.id)).toBeNull();
  });
});

describe("start-up", () => {
  const row = (over: Partial<StoredAttachment>): StoredAttachment => ({
    id: "r1",
    draftId: "d1",
    accountId: ACCOUNT,
    name: "a.pdf",
    size: 3,
    state: "reading",
    reason: null,
    sha256: null,
    sourcePath: "/files/a.pdf",
    sourceMtimeMs: null,
    origin: null,
    createdAtMs: 1,
    ...over,
  });

  it("copies again what was being copied when the app stopped, and sweeps what nothing refers to", async () => {
    const files = new FakeFileWork();
    files.addFile("/files/a.pdf", new Uint8Array([1, 2, 3]));
    files.stored.set("stray", { bytes: new Uint8Array(1), sha256: "x" });
    const rt = await open({
      files,
      seed: async (storage) => {
        await storage.drafts.put({
          id: "d1",
          version: 1,
          fingerprint: "f",
          updatedAtMs: 1,
          ...content("Resume"),
        });
        await storage.attachments.add(row({}));
        // No original to read from: it cannot be started again.
        await storage.attachments.add(row({ id: "r2", sourcePath: null }));
      },
    });
    await vi.waitFor(async () =>
      expect((await rt.storage.attachments.get("r1"))?.state).toBe("ready"),
    );
    expect(await rt.storage.attachments.get("r2")).toMatchObject({ state: "failed" });
    expect(files.swept.length).toBeGreaterThan(0);
    expect(files.stored.has("stray")).toBe(false);
    expect(files.stored.has("r1")).toBe(true);
  });
});
