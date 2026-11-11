// Runs against the Dovecot container and an SMTP server in this process: `npm run test:imap`
// starts the container and sets the variables. A forward from end to end (ADR 0045): a message with
// binary files arrives by IMAP, the forward downloads them through the cache, copies them into the
// draft, and the SMTP sink gets them byte for byte. Real SQLite, IMAP and SMTP adapters, the real
// renderer, MIME composer and file work; only the vault is fake and the undo window is shortened.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { MarkdownComposeRenderer } from "@matters/adapter-compose";
import { createReceivedFiles } from "@matters/adapter-files";
import { ImapConnector } from "@matters/adapter-imap";
import { PostalMimeParser } from "@matters/adapter-mime";
import { registrableDomain } from "@matters/adapter-publicsuffix";
import { type RpcPort, serveCredentials } from "@matters/adapter-secrets";
import { NodemailerComposer, NodemailerSubmit } from "@matters/adapter-smtp";
import { createSqliteStorage, type SqliteStorage } from "@matters/adapter-sqlite";
import { type ClockPort, prepareForwardDraft, type SendOperation } from "@matters/core";
import { InMemoryCredentialStore } from "@matters/testkit";
import PostalMime from "postal-mime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Admin } from "../../../../packages/adapter-imap/test/support/admin.ts";
import {
  binary,
  multipart,
  part,
  rawMessage,
} from "../../../../packages/adapter-imap/test/support/multipart.ts";
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
    received: createReceivedFiles(join(dirname(dbPath), "received")),
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

const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 8, n));
const text = () =>
  part({
    headers: ["Content-Type: text/plain; charset=utf-8"],
    content: "Dzień dobry,\nw załączeniu faktury i skan.",
    encoding: "base64",
  });
const file = (name: string, content: Buffer, type = "application/octet-stream") =>
  part({
    headers: [
      `Content-Type: ${type}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
    ],
    content,
    encoding: "base64",
  });

describe.skipIf(!enabled)("forwarding against Dovecot and an SMTP sink", () => {
  let admin: Admin;
  let sink: SmtpSink;
  let dir: string;
  let dbPath: string;
  let vault: InMemoryCredentialStore;
  // Every byte value, in an order that repeats nothing a text reader would recognise.
  const scan = binary(300_000, 7);
  const sheet = binary(4_321, 9);

  beforeEach(async () => {
    admin = await Admin.connect(credentials);
    await admin.reset();
    await admin.deleteFolder("Sent").catch(() => {});
    await admin.createFolder("Sent").catch(() => {});
    cleanups.push(() => admin.close());
    sink = await startSmtpSink({ user: credentials.user, password: credentials.pass });
    cleanups.push(() => sink.stop());
    dir = mkdtempSync(join(tmpdir(), "matters-forward-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    dbPath = join(dir, "matters.db");
    vault = new InMemoryCredentialStore();
    await admin.append(
      "INBOX",
      rawMessage({
        id: "faktury-1",
        subject: "Faktury za październik",
        date: at(1),
        entity: multipart("mixed", "mix-1", [
          text(),
          file("Skan faktury.pdf", scan, "application/pdf"),
          file("zestawienie.bin", sheet),
        ]),
      }),
    );
  });

  async function start() {
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
      { timeout: 15_000 },
    );
    const [first] = await rt.storage.store.listNewest({ limit: 1 });
    return { rt, original: first as NonNullable<typeof first> };
  }

  const op = async (rt: Running, id: string) => (await rt.storage.outbox.get(id)) as SendOperation;
  const untilState = (rt: Running, id: string, kind: string) =>
    vi.waitFor(async () => expect((await op(rt, id)).state.kind).toBe(kind), {
      timeout: 20_000,
      interval: 50,
    });

  it("sends a message's binary files to the sink byte for byte, and leaves the original alone", async () => {
    const { rt, original } = await start();
    const view = await rt.storage.store.getThread(original.threadId);
    const files = view?.attachments.get(original.key);
    expect(files?.known).toBe(true);
    expect(files?.items.map((f) => f.name)).toEqual(["Skan faktury.pdf", "zestawienie.bin"]);

    const prepared = await prepareForwardDraft(
      { accounts: rt.storage.accounts, store: rt.storage.store, bodies: rt.storage.bodies },
      original.threadId,
      false,
    );
    expect(prepared?.messageKey).toBe(original.key);
    const draft = await rt.call({
      name: "saveDraft",
      content: {
        ...(prepared?.content as NonNullable<typeof prepared>["content"]),
        to: [{ name: "Jan", address: "jan@northwind.example" }],
        bodyMarkdown: `Jan, proszę o rozliczenie.${prepared?.content.bodyMarkdown}`,
      },
    });
    const rows = await rt.call({
      name: "addForwardedAttachments",
      draftId: draft.id,
      files: (files?.items ?? []).map((f, i) => ({
        id: `fw-${i}`,
        messageKey: original.key,
        partId: f.partId,
      })),
    });
    expect(rows.map((r) => [r.id, r.name, r.forwarded, r.state])).toEqual([
      ["fw-0", "Skan faktury.pdf", true, "reading"],
      ["fw-1", "zestawienie.bin", true, "reading"],
    ]);
    // Send is pressed at once, with the downloads still on their way (rule 9).
    await rt.call({
      name: "saveDraft",
      id: draft.id,
      content: {
        ...draft,
        attachments: rows.map((r) => ({
          id: r.id,
          name: r.name,
          size: r.size,
          delivery: { kind: "inline" as const },
        })),
      },
    });
    const sent = await rt.call({ name: "requestSend", draftId: draft.id });
    await untilState(rt, sent.id, "succeeded");

    expect(sink.received).toHaveLength(1);
    const got = sink.received[0];
    expect(got?.recipients).toEqual(["jan@northwind.example"]);
    const raw = got?.raw ?? Buffer.alloc(0);
    const head = raw.toString("latin1").split("\r\n\r\n")[0] as string;
    expect(head).not.toMatch(/^in-reply-to:/im);
    expect(head).not.toMatch(/^references:/im);
    const parsed = await PostalMime.parse(raw);
    expect(parsed.subject).toBe("Fwd: Faktury za październik");
    expect(parsed.attachments.map((a) => a.filename)).toEqual([
      "Skan faktury.pdf",
      "zestawienie.bin",
    ]);
    expect(Buffer.from(parsed.attachments[0]?.content as ArrayBuffer).equals(scan)).toBe(true);
    expect(Buffer.from(parsed.attachments[1]?.content as ArrayBuffer).equals(sheet)).toBe(true);
    expect(parsed.text).toContain("Jan, proszę o rozliczenie.");
    expect(parsed.text).toContain("> Forwarded message");
    expect(parsed.text).toContain("> w załączeniu faktury i skan.");
    expect(parsed.html).toContain("<blockquote");

    // The original is where it was and nobody read it: forwarding marks nothing (Consequences).
    const inbox = await admin.messages("INBOX");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.flags).not.toContain("\\Seen");
    expect(inbox[0]?.flags).not.toContain("$Forwarded");
    expect(inbox[0]?.flags).not.toContain("\\Answered");
    const after = (await rt.storage.store.getThread(original.threadId))?.messages;
    expect(after?.map((m) => m.key)).toContain(original.key);
    expect(after?.find((m) => m.key === original.key)?.flags).toMatchObject({
      seen: false,
      answered: false,
    });
    expect(await rt.storage.store.getLocations(original.key)).toEqual([
      expect.objectContaining({ folderId: "INBOX" }),
    ]);
  }, 90_000);

  it("a second forward of the same message needs no second download, and each draft has its own copy", async () => {
    const { rt, original } = await start();
    const files =
      (await rt.storage.store.getThread(original.threadId))?.attachments.get(original.key)?.items ??
      [];
    const make = async (suffix: string) => {
      const draft = await rt.call({
        name: "saveDraft",
        content: {
          accountId: original.accountId,
          from: { name: "Test", address: credentials.user },
          to: [{ address: "jan@northwind.example" }],
          cc: [],
          bcc: [],
          subject: `Fwd: ${suffix}`,
          bodyMarkdown: suffix,
          inReplyTo: "",
          references: [],
          forwarded: true,
        },
      });
      const rows = await rt.call({
        name: "addForwardedAttachments",
        draftId: draft.id,
        files: [{ id: `copy-${suffix}`, messageKey: original.key, partId: files[0]?.partId ?? "" }],
      });
      return { draft, rows };
    };
    const one = await make("one");
    const two = await make("two");
    await vi.waitFor(
      async () => {
        expect((await rt.storage.attachments.get("copy-one"))?.state).toBe("ready");
        expect((await rt.storage.attachments.get("copy-two"))?.state).toBe("ready");
      },
      { timeout: 20_000 },
    );
    expect(one.rows[0]?.id).not.toBe(two.rows[0]?.id);
    // Removing one draft's file leaves the other's, and the message in the cache.
    await rt.call({ name: "deleteDraft", draftId: one.draft.id });
    expect(await rt.storage.attachments.get("copy-one")).toBeNull();
    expect((await rt.storage.attachments.get("copy-two"))?.state).toBe("ready");
  }, 60_000);
});
