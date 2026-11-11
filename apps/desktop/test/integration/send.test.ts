// Runs against the Dovecot container and an SMTP server in this process: `npm run test:imap`
// starts the container and sets the variables. The whole send path of ADR 0020 through the sync
// runtime: real SQLite, real IMAP and SMTP adapters, the real renderer and MIME composer; only
// the vault is fake and the undo window is shortened (the default is tested in testkit).
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { MarkdownComposeRenderer } from "@matters/adapter-compose";
import { ImapConnector } from "@matters/adapter-imap";
import { PostalMimeParser } from "@matters/adapter-mime";
import { registrableDomain } from "@matters/adapter-publicsuffix";
import { type RpcPort, serveCredentials } from "@matters/adapter-secrets";
import { NodemailerComposer, NodemailerSubmit } from "@matters/adapter-smtp";
import { createSqliteStorage, type SqliteStorage } from "@matters/adapter-sqlite";
import {
  type ClockPort,
  type DraftContent,
  prepareReplyDraft,
  type SendOperation,
} from "@matters/core";
import { InMemoryCredentialStore } from "@matters/testkit";
import PostalMime from "postal-mime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Admin } from "../../../../packages/adapter-imap/test/support/admin.ts";
import { mail } from "../../../../packages/adapter-imap/test/support/mail.ts";
import {
  type SmtpSink,
  startSmtpSink,
} from "../../../../packages/adapter-smtp/test/support/smtpSink.ts";
import type {
  CommandResult,
  FromWorker,
  ToWorker,
  WorkerChannel,
  WorkerCommand,
} from "../../src/backend/protocol.ts";
import { type SyncRuntime, startSyncRuntime } from "../../src/backend/syncRuntime.ts";
import { ThreadedFileWork } from "../../src/backend/threadedFileWork.ts";

const enabled = process.env.MATTERS_IMAP_TEST === "1";
const credentials = {
  host: process.env.MATTERS_IMAP_HOST ?? "127.0.0.1",
  port: Number(process.env.MATTERS_IMAP_PORT ?? 143),
  user: process.env.MATTERS_IMAP_USER ?? "",
  pass: process.env.MATTERS_IMAP_PASS ?? "",
};
const WINDOW_MS = 1500;

/** Wall-clock time, shiftable: "the app was closed for a minute" without waiting for it. */
const skew = { ms: 0 };
const clock: ClockPort = {
  now: () => Date.now() + skew.ms,
  setTimeout(run, ms) {
    const t = setTimeout(run, ms);
    return () => clearTimeout(t);
  },
  random: () => Math.random(),
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Running {
  readonly storage: SqliteStorage;
  readonly runtime: SyncRuntime;
  readonly messages: FromWorker[];
  call<C extends WorkerCommand>(command: C): Promise<CommandResult<C>>;
  stop(): Promise<void>;
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  skew.ms = 0;
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** The sync runtime over an in-process channel, as the worker thread would host it. */
async function openRuntime(
  dbPath: string,
  vault: InMemoryCredentialStore,
  windowMs = WINDOW_MS,
  submit = new NodemailerSubmit({ allowInsecure: true, socketTimeoutMs: 800 }),
): Promise<Running> {
  const storage = createSqliteStorage(dbPath, { reader: false });
  const handlers: ((m: ToWorker) => void)[] = [];
  const messages: FromWorker[] = [];
  const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  let nextId = 0;

  // The vault answers the runtime's credential requests, as main does in the app.
  const toRuntime = (data: unknown) => {
    for (const h of handlers) h({ type: "credentials", data });
  };
  let vaultHandler: (data: unknown) => void = () => {};
  const rpc: RpcPort = { postMessage: toRuntime, onMessage: (h) => (vaultHandler = h) };
  serveCredentials(rpc, vault);

  const channel: WorkerChannel = {
    post(message) {
      messages.push(message);
      if (message.type === "credentials") vaultHandler(message.data);
      if (message.type === "result") {
        const w = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.ok) w?.ok(message.value);
        else w?.fail(new Error(`${message.error.name}: ${message.error.message}`));
      }
    },
    onMessage: (h) => handlers.push(h),
  };
  // Files go through the real attachment worker thread, into directories beside the database.
  const dirs = {
    attachments: join(dirname(dbPath), "attachments"),
    spool: join(dirname(dbPath), "spool"),
  };
  const runtime = await startSyncRuntime({
    storage,
    connector: new ImapConnector({ parser: new PostalMimeParser(), allowInsecure: true }),
    channel,
    discovery: { discover: async () => null },
    registrableDomain,
    clock,
    files: new ThreadedFileWork({
      dirs,
      spawn: () =>
        new Worker(new URL("../../src/backend/attachmentWorker.ts", import.meta.url), {
          workerData: dirs,
        }),
    }),
    undoWindowMs: windowMs,
    sending: {
      renderer: new MarkdownComposeRenderer(),
      composer: new NodemailerComposer(),
      submit,
      sha256,
    },
  });
  const running: Running = {
    storage,
    runtime,
    messages,
    call: <C extends WorkerCommand>(command: C) =>
      new Promise<CommandResult<C>>((ok, fail) => {
        const id = ++nextId;
        waiting.set(id, { ok: ok as (v: unknown) => void, fail });
        for (const h of handlers) h({ type: "command", id, command });
      }),
    async stop() {
      await runtime.stop().catch(() => {});
    },
  };
  cleanups.push(() => running.stop());
  return running;
}

const SENT = "Sent";
const THREAD_ROOT = "wycena-1";

describe.skipIf(!enabled)("sending against Dovecot and an SMTP sink", () => {
  let admin: Admin;
  let sink: SmtpSink;
  let dir: string;
  let dbPath: string;
  let vault: InMemoryCredentialStore;

  beforeEach(async () => {
    admin = await Admin.connect(credentials);
    await admin.reset();
    await admin.deleteFolder(SENT).catch(() => {});
    await admin.createFolder(SENT).catch(() => {});
    cleanups.push(() => admin.close());
    sink = await startSmtpSink({ user: credentials.user, password: credentials.pass });
    cleanups.push(() => sink.stop());
    dir = mkdtempSync(join(tmpdir(), "matters-send-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    dbPath = join(dir, "matters.db");
    vault = new InMemoryCredentialStore();
    await admin.append(
      "INBOX",
      mail({
        id: THREAD_ROOT,
        subject: "Wycena okien",
        body: "Dzień dobry,\nprosimy o wycenę do piątku.",
        from: { name: "Anna Kowalska", address: "anna@northwind.example" },
        date: new Date(Date.now() - 3_600_000),
      }),
    );
  });

  /** Adds the account (IMAP and the sink) and waits for the first sync to bring the thread. */
  async function start(): Promise<{ rt: Running; threadId: string }> {
    const rt = await openRuntime(dbPath, vault);
    await rt.call({
      name: "addAccount",
      address: credentials.user,
      displayName: "Test",
      password: credentials.pass,
      imap: {
        host: credentials.host,
        port: credentials.port,
        security: "none",
        username: credentials.user,
      },
      smtp: { host: sink.host, port: sink.port, security: "none", username: credentials.user },
    });
    await vi.waitFor(
      async () => expect(await rt.storage.store.listNewest({ limit: 10 })).toHaveLength(1),
      {
        timeout: 15_000,
      },
    );
    const [first] = await rt.storage.store.listNewest({ limit: 1 });
    return { rt, threadId: (first as NonNullable<typeof first>).threadId };
  }

  async function replyDraft(
    rt: Running,
    threadId: string,
    body = "Cena: 36 000 PLN. Pozdrawiam, Miłosz",
  ) {
    const accounts = await rt.storage.accounts.list();
    const prepared = await prepareReplyDraft(
      {
        accounts: rt.storage.accounts,
        store: rt.storage.store,
        bodies: rt.storage.bodies,
        drafts: rt.storage.drafts,
      },
      threadId,
      "reply",
    );
    if (!prepared) throw new Error("no thread");
    expect(accounts).toHaveLength(1);
    const content: DraftContent = {
      ...prepared.content,
      bodyMarkdown: `${body}\n${prepared.content.bodyMarkdown}`,
    };
    return rt.call({ name: "saveDraft", content });
  }

  const op = async (rt: Running, id: string) => (await rt.storage.outbox.get(id)) as SendOperation;
  const state = async (rt: Running, id: string) => (await op(rt, id)).state.kind;
  const untilState = (rt: Running, id: string, kind: string, timeout = 15_000) =>
    vi.waitFor(async () => expect(await state(rt, id)).toBe(kind), { timeout, interval: 50 });
  const thread = async (rt: Running, threadId: string) =>
    (await rt.storage.store.getThread(threadId))?.messages ?? [];

  it("sends a reply once, files it in Sent, and the next sync matches it to the local message", async () => {
    const { rt, threadId } = await start();
    const draft = await replyDraft(rt, threadId);
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    expect(sent.state.kind).toBe("pending");
    await untilState(rt, sent.id, "succeeded");

    // exactly one message reached the SMTP server, with the right envelope and headers
    expect(sink.received).toHaveLength(1);
    const got = sink.received[0];
    expect(got).toMatchObject({ from: credentials.user, recipients: ["anna@northwind.example"] });
    expect(got?.user).toBe(credentials.user);
    const parsed = await PostalMime.parse(got?.raw ?? Buffer.alloc(0));
    const final = await op(rt, sent.id);
    expect(parsed.messageId).toBe(final.messageId);
    expect(parsed.messageId).toMatch(/^<[0-9a-f-]{36}@example\.test>$/);
    expect(parsed.subject).toBe("Re: Wycena okien");
    expect(parsed.inReplyTo).toBe(`<${THREAD_ROOT}@example.pl>`);
    expect(parsed.references).toBe(`<${THREAD_ROOT}@example.pl>`);
    expect(parsed.to).toEqual([{ name: "Anna Kowalska", address: "anna@northwind.example" }]);
    expect(parsed.text).toContain("Cena: 36 000 PLN. Pozdrawiam, Miłosz");
    expect(parsed.text).toContain("> Dzień dobry,");
    expect(parsed.html).toContain("<blockquote");
    expect(parsed.html).toContain("Cena: 36 000 PLN");
    expect(Buffer.from(got?.raw ?? "").toString("utf8")).toMatch(/multipart\/alternative/);

    // the copy landed in Dovecot's Sent folder, read, byte for byte
    await vi.waitFor(async () => expect(await admin.messages(SENT)).toHaveLength(1), {
      timeout: 5000,
    });
    const [copy] = await admin.messages(SENT);
    expect(copy?.flags).toContain("\\Seen");
    expect(copy?.source.equals(got?.raw ?? Buffer.alloc(0))).toBe(true);
    expect(final.warning).toBeNull();

    // the sent message is in its thread at once, with the id sync will compute
    const before = await thread(rt, threadId);
    expect(before.map((m) => m.messageIdHeader)).toEqual([
      `<${THREAD_ROOT}@example.pl>`,
      final.messageId,
    ]);
    const mine = before[1];
    expect(mine?.providerId).toMatch(/^fp:/);
    expect(mine?.flags.seen).toBe(true);
    expect(await rt.storage.drafts.get(draft.id)).toBeNull();

    // the next sync brings the server copy: same message, same key, same thread
    await rt.call({ name: "syncNow", accountId: await accountOf(rt) });
    await vi.waitFor(
      async () => expect(await locationsOf(rt, mine?.key as number)).toHaveLength(1),
      {
        timeout: 15_000,
      },
    );
    await sleep(500);
    const after = await thread(rt, threadId);
    expect(after).toHaveLength(2);
    expect(after[1]?.key).toBe(mine?.key);
    expect(after[1]?.providerId).toBe(mine?.providerId);
    expect(after[1]?.threadId).toBe(threadId);
    expect(await rt.storage.store.listNewest({ limit: 10 })).toHaveLength(2);
    expect(await locationsOf(rt, mine?.key as number)).toEqual([
      expect.objectContaining({ folderId: SENT }),
    ]);
  }, 60_000);

  const locationsOf = (rt: Running, key: number) => rt.storage.store.getLocations(key);

  it("sends a real attachment through the large lane, byte for byte, and cleans up after itself", async () => {
    const { rt, threadId } = await start();
    const draft = await replyDraft(rt, threadId);
    // 1.5 MB of noise: over 1 MiB once encoded, so it travels in the large lane.
    const bytes = Buffer.alloc(1_500_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
    const original = join(dir, "kosztorys.bin");
    writeFileSync(original, bytes);

    const rows = await rt.call({
      name: "addAttachments",
      draftId: draft.id,
      files: [{ id: "att-1", name: "kosztorys.bin", size: bytes.length, sourcePath: original }],
    });
    expect(rows[0]).toMatchObject({ id: "att-1", name: "kosztorys.bin", size: bytes.length });
    await vi.waitFor(
      async () => expect((await rt.storage.attachments.get("att-1"))?.state).toBe("ready"),
      { timeout: 10_000 },
    );
    // What goes out is what was attached, even if the original changes afterwards.
    writeFileSync(original, "edited afterwards");
    await rt.call({
      name: "saveDraft",
      id: draft.id,
      content: {
        ...draft,
        attachments: [
          {
            id: "att-1",
            name: "kosztorys.bin",
            size: bytes.length,
            delivery: { kind: "inline" },
          },
        ],
      },
    });

    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    expect(sent.encodedBytes).toBeGreaterThanOrEqual(1_048_576);
    await untilState(rt, sent.id, "succeeded");

    expect(sink.received).toHaveLength(1);
    const parsed = await PostalMime.parse(sink.received[0]?.raw ?? Buffer.alloc(0));
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe("kosztorys.bin");
    expect(Buffer.from(parsed.attachments[0]?.content as ArrayBuffer).equals(bytes)).toBe(true);
    expect(parsed.text).toContain("Cena: 36 000 PLN");

    // The Sent copy is the very message, read from the spool for the APPEND.
    await vi.waitFor(async () => expect(await admin.messages(SENT)).toHaveLength(1), {
      timeout: 10_000,
    });
    const [copy] = await admin.messages(SENT);
    expect(copy?.source.equals(sink.received[0]?.raw ?? Buffer.alloc(0))).toBe(true);

    // The draft, its row, the stored copy and the spool are gone once the Sent copy is kept.
    await vi.waitFor(async () => expect(await rt.storage.drafts.get(draft.id)).toBeNull());
    await vi.waitFor(() => {
      expect(readdirSync(join(dir, "attachments"))).toEqual([]);
      expect(readdirSync(join(dir, "spool"))).toEqual([]);
    });
    expect(await rt.storage.attachments.get("att-1")).toBeNull();
    expect((await op(rt, sent.id)).warning).toBeNull();
  }, 60_000);

  it("an undo inside the window sends nothing, and the draft survives", async () => {
    const { rt, threadId } = await start();
    const draft = await replyDraft(rt, threadId);
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    await sleep(300);
    expect(await rt.call({ name: "undoSend", operationId: sent.id })).toBe("cancelled");
    await sleep(WINDOW_MS + 1000);
    expect(sink.received).toHaveLength(0);
    expect(await admin.messages(SENT)).toHaveLength(0);
    expect(await state(rt, sent.id)).toBe("cancelled");
    expect(await rt.storage.drafts.get(draft.id)).not.toBeNull();
    expect(await thread(rt, threadId)).toHaveLength(1);
  }, 40_000);

  it("an edit after approval sends nothing and says why", async () => {
    const { rt, threadId } = await start();
    const draft = await replyDraft(rt, threadId);
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    await sleep(200);
    await rt.call({
      name: "saveDraft",
      id: draft.id,
      content: { ...draft, bodyMarkdown: `${draft.bodyMarkdown}\n\nPS. Zmieniłem zdanie.` },
    });
    await sleep(WINDOW_MS + 1000);
    expect(sink.received).toHaveLength(0);
    expect((await op(rt, sent.id)).state).toEqual({
      kind: "voided",
      reason: "The draft was edited after you pressed Send.",
    });
    expect(await admin.messages(SENT)).toHaveLength(0);
  }, 40_000);

  it("a new message in the thread before the hand-off sends nothing (contextChanged)", async () => {
    const { rt, threadId } = await start();
    const draft = await replyDraft(rt, threadId);
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    await admin.append(
      "INBOX",
      mail({
        id: "wycena-2",
        subject: "Re: Wycena okien",
        body: "Jeszcze jedno pytanie.",
        from: { name: "Anna Kowalska", address: "anna@northwind.example" },
        inReplyTo: THREAD_ROOT,
        references: [THREAD_ROOT],
        date: new Date(),
      }),
    );
    await rt.call({ name: "syncNow", accountId: await accountOf(rt) });
    await vi.waitFor(async () => expect(await thread(rt, threadId)).toHaveLength(2), {
      timeout: 10_000,
    });
    await untilState(rt, sent.id, "voided");
    expect((await op(rt, sent.id)).state).toEqual({
      kind: "voided",
      reason: "A new message arrived in the thread after you pressed Send.",
    });
    expect(sink.received).toHaveLength(0);
    expect(await admin.messages(SENT)).toHaveLength(0);
    // the draft is still there; sending it again approves the new situation
    expect(await rt.storage.drafts.get(draft.id)).not.toBeNull();
  }, 40_000);

  it("two replies queued in one thread are both delivered, in order, once each", async () => {
    const { rt, threadId } = await start();
    const first = await replyDraft(rt, threadId, "Pierwsza odpowiedź");
    const second = await rt.call({
      name: "saveDraft",
      content: { ...first, subject: "Re: Wycena okien (2)", bodyMarkdown: "Druga odpowiedź" },
    });
    const a = await rt.call({ name: "requestSend", draftId: first.id });
    await sleep(100);
    const b = await rt.call({ name: "requestSend", draftId: second.id });
    await untilState(rt, a.id, "succeeded");
    await untilState(rt, b.id, "succeeded");
    await sleep(WINDOW_MS);

    expect(sink.received).toHaveLength(2);
    const parsed = await Promise.all(sink.received.map((m) => PostalMime.parse(m.raw)));
    expect(parsed.map((p) => p.messageId)).toEqual([
      (await op(rt, a.id)).messageId,
      (await op(rt, b.id)).messageId,
    ]);
    expect(parsed[0]?.text).toContain("Pierwsza odpowiedź");
    expect(parsed[1]?.text).toContain("Druga odpowiedź");
    expect((await op(rt, a.id)).attempts).toBe(1);
    expect((await op(rt, b.id)).attempts).toBe(1);
    await vi.waitFor(async () => expect(await admin.messages(SENT)).toHaveLength(2), {
      timeout: 5000,
    });
  }, 60_000);

  it("a 550 fails the send; one retry sends it, once, with the same message", async () => {
    const { rt, threadId } = await start();
    sink.script.rejectRcpt = () => 550;
    const draft = await replyDraft(rt, threadId);
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    await untilState(rt, sent.id, "failed");
    const failed = await op(rt, sent.id);
    expect(failed.state).toMatchObject({ kind: "failed" });
    expect((failed.state as { reason: string }).reason).toContain("550");
    expect(sink.received).toHaveLength(0);
    expect(await admin.messages(SENT)).toHaveLength(0);

    // nothing is retried by itself
    await sleep(1500);
    expect(sink.received).toHaveLength(0);

    sink.script.rejectRcpt = undefined;
    expect(await rt.call({ name: "sendAction", operationId: sent.id, action: "retry" })).toBe(true);
    await untilState(rt, sent.id, "succeeded");
    expect(sink.received).toHaveLength(1);
    expect((await op(rt, sent.id)).attempts).toBe(2);
    expect((await op(rt, sent.id)).messageId).toBe(failed.messageId);
    await vi.waitFor(async () => expect(await admin.messages(SENT)).toHaveLength(1), {
      timeout: 5000,
    });
  }, 60_000);

  it("a connection dropped after the data is unknown: never resent, and 'mark as sent' settles it", async () => {
    const { rt, threadId } = await start();
    sink.script.dropAfterData = true;
    const draft = await replyDraft(rt, threadId);
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    await untilState(rt, sent.id, "unknown");
    expect(sink.received).toHaveLength(1);

    // Dovecot keeps no copy of its own, so nothing can settle it but the user
    await sleep(2500);
    expect(await state(rt, sent.id)).toBe("unknown");
    expect(sink.received).toHaveLength(1);
    expect(await admin.messages(SENT)).toHaveLength(0);
    expect(await rt.call({ name: "sendAction", operationId: sent.id, action: "retry" })).toBe(
      false,
    );

    expect(await rt.call({ name: "sendAction", operationId: sent.id, action: "markSent" })).toBe(
      true,
    );
    expect(await state(rt, sent.id)).toBe("succeeded");
    expect(sink.received).toHaveLength(1);
    expect(await rt.storage.drafts.get(draft.id)).toBeNull();
    expect(await thread(rt, threadId)).toHaveLength(2);
  }, 60_000);

  it("send again after an unknown outcome sends the same bytes once more", async () => {
    const { rt, threadId } = await start();
    sink.script.dropAfterData = true;
    const draft = await replyDraft(rt, threadId);
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    await untilState(rt, sent.id, "unknown");
    sink.script.dropAfterData = false;
    expect(await rt.call({ name: "sendAction", operationId: sent.id, action: "sendAgain" })).toBe(
      true,
    );
    await untilState(rt, sent.id, "succeeded");
    expect(sink.received).toHaveLength(2);
    expect(sink.received[1]?.raw.equals(sink.received[0]?.raw ?? Buffer.alloc(0))).toBe(true);
  }, 60_000);

  it("a send whose window ended while the app was closed is held at the next start, then sent on request", async () => {
    const { rt, threadId } = await start();
    const draft = await replyDraft(rt, threadId);
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    // the app quits inside the window
    await rt.stop();
    expect(sink.received).toHaveLength(0);

    // ... and starts again a minute later
    skew.ms = 60_000;
    const again = await openRuntime(dbPath, vault);
    expect(await state(again, sent.id)).toBe("held");
    await sleep(WINDOW_MS + 500);
    expect(sink.received).toHaveLength(0);

    expect(await again.call({ name: "sendAction", operationId: sent.id, action: "sendNow" })).toBe(
      true,
    );
    await untilState(again, sent.id, "succeeded");
    expect(sink.received).toHaveLength(1);
  }, 60_000);

  it("a send still inside its window when the app restarts goes out on time", async () => {
    const { rt, threadId } = await start();
    const draft = await replyDraft(rt, threadId);
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    await rt.stop();
    const again = await openRuntime(dbPath, vault);
    expect(await state(again, sent.id)).toBe("pending");
    await untilState(again, sent.id, "succeeded");
    expect(sink.received).toHaveLength(1);
  }, 60_000);

  // ADR 0041, rule 13: what a crash means depends on whether the data had ended. The test
  // plays the process dying with the operation `running`, with and without the mark.
  async function diedWhileRunning(dataEnded: boolean) {
    const { rt, threadId } = await start();
    const draft = await replyDraft(rt, threadId);
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    await rt.stop();
    const db = createSqliteStorage(dbPath, { reader: false });
    const pending = (await db.outbox.get(sent.id)) as SendOperation;
    await db.outbox.update({ ...pending, state: { kind: "running" }, attempts: 1, dataEnded });
    db.close();
    const again = await openRuntime(dbPath, vault);
    return { again, id: sent.id };
  }

  it("a hand-off that died after its data ended is unknown at the next start", async () => {
    const { again, id } = await diedWhileRunning(true);
    expect(await state(again, id)).toBe("unknown");
    await sleep(1000);
    expect(sink.received).toHaveLength(0);
  }, 60_000);

  it("one that died before its data ended was not delivered: it is held, not unknown", async () => {
    const { again, id } = await diedWhileRunning(false);
    expect(await state(again, id)).toBe("held");
    await sleep(1000);
    expect(sink.received).toHaveLength(0);
  }, 60_000);

  it("never writes the password into the database, the draft, the MIME or the operation", async () => {
    const { rt, threadId } = await start();
    const draft = await replyDraft(rt, threadId);
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    await untilState(rt, sent.id, "succeeded");
    const mime = await rt.storage.outbox.getMime(sent.id);
    expect(Buffer.from(mime ?? "").includes(credentials.pass)).toBe(false);
    expect(JSON.stringify(await op(rt, sent.id))).not.toContain(credentials.pass);
    expect(JSON.stringify(await rt.storage.accounts.list())).not.toContain(credentials.pass);
    expect(JSON.stringify(rt.messages.filter((m) => m.type !== "credentials"))).not.toContain(
      credentials.pass,
    );
  }, 60_000);
});

async function accountOf(rt: Running): Promise<string> {
  const [first] = await rt.storage.accounts.list();
  if (!first) throw new Error("no account");
  return first.id;
}
