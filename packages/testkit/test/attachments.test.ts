import { createHash } from "node:crypto";
import type {
  DraftContent,
  ProcessDeps,
  SendOperation,
  StoredAccount,
  StoredAttachment,
} from "@matters/core";
import {
  addAttachments,
  checkAttachmentSources,
  DraftNotFoundError,
  deleteDraft,
  encodedMessageBytes,
  FileWorkError,
  holdExpiredOnStartup,
  ingestDocuments,
  OVERDUE_MS,
  probeMessageLimit,
  processOutbox,
  recaptureAttachment,
  releaseSend,
  removeAccount,
  requestSend,
  resumeCaptures,
  SendBlockedError,
  saveDraft,
  sweepAttachmentFiles,
  undoSend,
} from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  createInMemoryStorage,
  FakeComposeRenderer,
  FakeFileWork,
  FakeMailConnector,
  FakeMailSubmit,
  FakeMailSync,
  FakeMessageComposer,
  InMemoryCredentialStore,
  makeDocument,
} from "../src/index.ts";

const T0 = 1_800_000_000_000;
const PASSWORD = "s3cret-pw-value";

const account = (
  id: string,
  address: string,
  over: Partial<StoredAccount> = {},
): StoredAccount => ({
  id,
  address,
  displayName: id,
  imap: { host: "imap.example.com", port: 993, security: "tls", username: "me" },
  smtp: { host: "smtp.example.com", port: 587, security: "starttls", username: "me" },
  createdAtMs: 1,
  ...over,
});

const sleep = (ms = 1) => new Promise((r) => setTimeout(r, ms));
async function waitFor(condition: () => boolean | Promise<boolean>, what = "condition") {
  for (let i = 0; i < 1000; i++) {
    if (await condition()) return;
    await sleep();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function rig(options: { limit?: number } = {}) {
  const storage = createInMemoryStorage();
  await storage.accounts.add(
    account("acc1", "me@example.com", options.limit ? { messageLimitBytes: options.limit } : {}),
  );
  await storage.accounts.add(account("acc2", "other@example.com"));
  const credentials = new InMemoryCredentialStore();
  for (const id of ["acc1", "acc2"]) {
    await credentials.set(id, { kind: "password", username: "me", password: PASSWORD });
  }
  const server = new FakeMailSync(["INBOX", "Sent"], []);
  const connector = new FakeMailConnector(server);
  const submit = new FakeMailSubmit();
  const composer = new FakeMessageComposer();
  const files = new FakeFileWork();
  const state = { now: T0, ids: 0 };
  const events = {
    changed: [] as string[],
    progress: [] as [string, number][],
    wakes: 0,
    ops: [] as SendOperation[],
    transfers: new Map<string, AbortController>(),
    sendProgress: [] as [string, number, number][],
  };
  await ingestDocuments(storage, [
    makeDocument(
      {
        providerId: "p-anna",
        threadId: "t1",
        dateMs: T0 - 3_600_000,
        accountId: "acc1",
        messageIdHeader: "<a1@northwind.example>",
      },
      "Prosimy o wycenę",
    ),
  ]);
  const deps: ProcessDeps = {
    drafts: storage.drafts,
    outbox: storage.outbox,
    store: storage.store,
    accounts: storage.accounts,
    credentials,
    renderer: new FakeComposeRenderer(),
    composer,
    submit,
    connector,
    ingest: storage,
    attachments: storage.attachments,
    files,
    carriers: [],
    sha256: (t) => createHash("sha256").update(t, "utf8").digest("hex"),
    newId: () => `id${++state.ids}`,
    now: () => state.now,
    onChange: (op) => events.ops.push(op),
    onAttachmentsChanged: (draftId) => events.changed.push(draftId),
    onAttachmentProgress: (id, fraction) => events.progress.push([id, fraction]),
    wakeOutbox: () => {
      events.wakes++;
    },
    onTransferStart: (id, controller) => events.transfers.set(id, controller),
    onTransferEnd: (id) => events.transfers.delete(id),
    onSendProgress: (id, sent, total) => events.sendProgress.push([id, sent, total]),
  };
  const content = (over: Partial<DraftContent> = {}): DraftContent => ({
    accountId: "acc1",
    from: { name: "Miłosz", address: "me@example.com" },
    to: [{ name: "Anna", address: "anna@northwind.example" }],
    cc: [],
    bcc: [],
    subject: "Re: Wycena",
    bodyMarkdown: "Dzień dobry",
    inReplyTo: "<a1@northwind.example>",
    references: ["<a1@northwind.example>"],
    threadId: "t1",
    ...over,
  });
  /** A draft that lists these files, with the originals in place and the rows added. */
  async function draftWith(
    originals: Record<string, string | Uint8Array>,
    over: Partial<DraftContent> = {},
  ) {
    const entries = Object.entries(originals);
    const listed = entries.map(([name, body]) => ({
      id: `file-${name}`,
      name,
      size: typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength,
      delivery: { kind: "inline" as const },
    }));
    for (const [name, body] of entries) files.addFile(`/src/${name}`, body);
    const draft = await saveDraft(deps, { content: content({ attachments: listed, ...over }) });
    const added = await addAttachments(
      deps,
      draft.id,
      listed.map((f) => ({ id: f.id, name: f.name, size: f.size, sourcePath: `/src/${f.name}` })),
    );
    return { draft, added, listed };
  }
  const op = async (id: string) => (await storage.outbox.get(id)) as SendOperation;
  const row = async (id: string) => (await storage.attachments.get(id)) as StoredAttachment;
  return {
    storage,
    credentials,
    connector,
    submit,
    composer,
    files,
    state,
    events,
    deps,
    content,
    draftWith,
    op,
    row,
  };
}

const SMALL = { lane: "small" } as const;
const LARGE = { lane: "large" } as const;

describe("addAttachments", () => {
  it("gives every file a row at once, copies it, and says so when it is done", async () => {
    const r = await rig();
    r.files.addFile("/src/a.txt", "hello");
    const release = r.files.hold("/src/a.txt");
    const draft = await saveDraft(r.deps, { content: r.content() });
    const { attachments, settled } = await addAttachments(r.deps, draft.id, [
      { id: "a", name: "a.txt", size: 5, sourcePath: "/src/a.txt" },
    ]);
    // the row is there before the copy has ended
    expect(attachments[0]).toMatchObject({ id: "a", state: "reading", draftId: draft.id });
    expect(await r.row("a")).toMatchObject({ state: "reading", sha256: null });
    expect(r.events.changed).toEqual([draft.id]);

    release();
    await settled;
    expect(await r.row("a")).toMatchObject({
      state: "ready",
      reason: null,
      size: 5,
      sourceMtimeMs: 1000,
      sha256: createHash("sha256").update("hello").digest("hex"),
      sourcePath: "/src/a.txt",
    });
    expect(r.events.changed).toEqual([draft.id, draft.id]);
    expect(r.events.progress).toEqual([
      ["a", 0],
      ["a", 1],
    ]);
  });

  it("is the same request when asked twice", async () => {
    const r = await rig();
    r.files.addFile("/src/a.txt", "hello");
    const draft = await saveDraft(r.deps, { content: r.content() });
    const file = { id: "a", name: "a.txt", size: 5, sourcePath: "/src/a.txt" };
    await (await addAttachments(r.deps, draft.id, [file])).settled;
    await (await addAttachments(r.deps, draft.id, [file])).settled;
    expect(r.files.captures).toHaveLength(1);
    expect(await r.storage.attachments.forDraft(draft.id)).toHaveLength(1);
  });

  it("keeps a file that alone is over the known limit as a chip, and copies nothing", async () => {
    const r = await rig({ limit: 1_000_000 });
    r.files.addFile("/src/big.bin", new Uint8Array(900_000));
    const draft = await saveDraft(r.deps, { content: r.content() });
    const { attachments, settled } = await addAttachments(r.deps, draft.id, [
      { id: "big", name: "big.bin", size: 900_000, sourcePath: "/src/big.bin" },
    ]);
    await settled;
    expect(attachments[0]).toMatchObject({
      state: "tooLarge",
      reason: "Larger than your server takes",
    });
    expect(r.files.captures).toEqual([]);
    expect(r.files.stored.size).toBe(0);
  });

  it("says why a file could not be read, in the words of ADR 0041", async () => {
    const r = await rig();
    r.files.sources.set("/src/dir", { kind: "directory" });
    r.files.sources.set("/src/full", { kind: "noSpace" });
    const draft = await saveDraft(r.deps, { content: r.content() });
    const { settled } = await addAttachments(r.deps, draft.id, [
      { id: "gone", name: "gone.pdf", size: 1, sourcePath: "/src/gone.pdf" },
      { id: "dir", name: "dir", size: 0, sourcePath: "/src/dir" },
      { id: "full", name: "full.bin", size: 1, sourcePath: "/src/full" },
    ]);
    await settled;
    expect(await r.row("gone")).toMatchObject({ state: "failed", reason: "Can't read this file" });
    expect(await r.row("dir")).toMatchObject({
      state: "failed",
      reason: "Folders can't be attached. Zip it first.",
    });
    expect(await r.row("full")).toMatchObject({ state: "failed", reason: "Not enough disk space" });
  });

  it("an empty file is a file", async () => {
    const r = await rig();
    r.files.addFile("/src/empty.txt", "");
    const draft = await saveDraft(r.deps, { content: r.content() });
    await (
      await addAttachments(r.deps, draft.id, [
        { id: "e", name: "empty.txt", size: 0, sourcePath: "/src/empty.txt" },
      ])
    ).settled;
    expect(await r.row("e")).toMatchObject({ state: "ready", size: 0 });
  });

  it("refuses a draft that does not exist", async () => {
    const r = await rig();
    await expect(addAttachments(r.deps, "nope", [])).rejects.toBeInstanceOf(DraftNotFoundError);
  });
});

describe("Send while a file is being read (ADR 0041, rules 7 and 8)", () => {
  it("is allowed; the send waits for the file and then goes", async () => {
    const r = await rig();
    r.files.addFile("/src/a.txt", "hello");
    const release = r.files.hold("/src/a.txt");
    const { draft, added } = await r.draftWith({ "a.txt": "hello" });
    expect((await r.row("file-a.txt")).state).toBe("reading");

    const op = await requestSend(r.deps, draft.id);
    r.state.now += 10_000;
    expect(await processOutbox(r.deps, SMALL)).toEqual([]);
    expect((await r.op(op.id)).state.kind).toBe("pending");
    expect(await r.storage.outbox.nextDueMs("small")).toBeNull();
    expect(r.submit.submissions).toHaveLength(0);

    release();
    await added.settled;
    expect(r.events.wakes).toBeGreaterThan(0);
    expect((await processOutbox(r.deps, SMALL)).map((o) => o.state.kind)).toEqual(["succeeded"]);
    expect(r.submit.submissions).toHaveLength(1);
  });

  it("does not count the wait as lateness: a long wait is not held as overdue", async () => {
    const r = await rig();
    const release = r.files.hold("/src/a.txt");
    const { draft, added } = await r.draftWith({ "a.txt": "hello" });
    const op = await requestSend(r.deps, draft.id);
    // the computer sleeps, or the file is on a slow network drive, for much longer than a minute
    r.state.now += 10_000 + 5 * OVERDUE_MS;
    expect(await processOutbox(r.deps, SMALL)).toEqual([]);
    expect((await r.op(op.id)).state.kind).toBe("pending");

    release();
    await added.settled;
    // the window moved to the moment the file was ready, so nothing is held now either
    expect((await r.op(op.id)).notBeforeMs).toBe(r.state.now);
    expect((await processOutbox(r.deps, SMALL)).map((o) => o.state.kind)).toEqual(["succeeded"]);
  });

  it("a window still open when the file is ready keeps its end", async () => {
    const r = await rig();
    const release = r.files.hold("/src/a.txt");
    const { draft, added } = await r.draftWith({ "a.txt": "hello" });
    const op = await requestSend(r.deps, draft.id);
    const end = op.notBeforeMs;
    r.state.now += 3_000;
    release();
    await added.settled;
    expect((await r.op(op.id)).notBeforeMs).toBe(end);
    expect(await processOutbox(r.deps, SMALL)).toEqual([]);
  });

  it("when the file fails the send fails, names the file and offers the draft", async () => {
    const r2 = await rig();
    const release = r2.files.hold("/src/b.txt");
    const second = await r2.draftWith({ "b.txt": "x" });
    const waiting = await requestSend(r2.deps, second.draft.id);
    r2.files.sources.delete("/src/b.txt");
    release();
    await second.added.settled;
    expect((await r2.op(waiting.id)).state).toEqual({
      kind: "failed",
      reason: "b.txt: Can't read this file",
      action: "openDraft",
    });
    expect(r2.events.ops.at(-1)?.state.kind).toBe("failed");
    r2.state.now += 10_000;
    expect(await processOutbox(r2.deps, SMALL)).toEqual([]);
    expect(r2.submit.submissions).toHaveLength(0);
  });

  it("a send that is held waits and fails the same way", async () => {
    const r = await rig();
    const release = r.files.hold("/src/a.txt");
    const { draft, added } = await r.draftWith({ "a.txt": "hello" });
    const op = await requestSend(r.deps, draft.id);
    r.state.now += 10_000;
    r.files.sources.delete("/src/a.txt");
    release();
    await added.settled;
    expect((await r.op(op.id)).state).toMatchObject({ kind: "failed", action: "openDraft" });
  });
});

describe("requestSend with files", () => {
  it("refuses while a file failed, or the files are over the known limit", async () => {
    const r = await rig({ limit: 2_000_000 });
    const failing = await r.draftWith({ "ok.txt": "hello" }, { subject: "one" });
    r.files.stored.clear();
    await failing.added.settled;
    await r.storage.attachments.update({
      ...(await r.row("file-ok.txt")),
      state: "failed",
      reason: "Can't read this file",
    });
    const refused = await requestSend(r.deps, failing.draft.id).catch((e) => e);
    expect(refused).toBeInstanceOf(SendBlockedError);
    expect(refused.message).toBe("ok.txt: Can't read this file");

    // each file alone fits (900 kB is 1.2 MB encoded), the two together do not
    const big = await r.draftWith(
      { "big.bin": new Uint8Array(900_000), "bigger.bin": new Uint8Array(900_000) },
      { subject: "two" },
    );
    await big.added.settled;
    expect((await r.row("file-big.bin")).state).toBe("ready");
    const tooMuch = await requestSend(r.deps, big.draft.id).catch((e) => e);
    expect(tooMuch).toBeInstanceOf(SendBlockedError);
    expect(tooMuch.blockers[0]).toMatchObject({ kind: "tooLarge" });
  });

  it("fixes the estimate that picks the lane when Send is pressed", async () => {
    const r = await rig();
    const small = await r.draftWith({ "a.txt": "hello" }, { subject: "small" });
    await small.added.settled;
    const op = await requestSend(r.deps, small.draft.id);
    expect(op.encodedBytes).toBe(encodedMessageBytes([{ size: 5 }]));
    expect(op.encodedBytes).toBeGreaterThan(512);
    expect(op.encodedBytes).toBeLessThan(1_048_576);

    const large = await r.draftWith({ "b.bin": new Uint8Array(1_000_000) }, { subject: "large" });
    await large.added.settled;
    const big = await requestSend(r.deps, large.draft.id);
    expect(big.encodedBytes).toBeGreaterThanOrEqual(1_048_576);
    const plain = await saveDraft(r.deps, { content: r.content({ subject: "plain" }) });
    expect((await requestSend(r.deps, plain.id)).encodedBytes).toBe(0);
  });

  it("an edit that removes a file voids the send, and the file's row and copy go", async () => {
    const r = await rig();
    const { draft, added } = await r.draftWith({ "a.txt": "hello", "b.txt": "world" });
    await added.settled;
    const op = await requestSend(r.deps, draft.id);
    expect(r.files.stored.size).toBe(2);
    const [first] = draft.attachments ?? [];
    await saveDraft(r.deps, {
      id: draft.id,
      content: r.content({ attachments: first ? [first] : [] }),
    });
    expect((await r.op(op.id)).state.kind).toBe("voided");
    expect(await r.storage.attachments.allIds()).toEqual(["file-a.txt"]);
    expect([...r.files.stored.keys()]).toEqual(["file-a.txt"]);
  });

  it("a file added in the backend but not yet in any saved content survives an older save", async () => {
    const r = await rig();
    const draft = await saveDraft(r.deps, { content: r.content() });
    r.files.addFile("/src/new.txt", "x");
    await (
      await addAttachments(r.deps, draft.id, [
        { id: "new", name: "new.txt", size: 1, sourcePath: "/src/new.txt" },
      ])
    ).settled;
    // an autosave that was already on its way, without the file
    await saveDraft(r.deps, { id: draft.id, content: r.content({ subject: "edited" }) });
    expect(await r.storage.attachments.allIds()).toEqual(["new"]);
    expect(r.files.stored.has("new")).toBe(true);
  });

  it("deleting a draft drops its files", async () => {
    const r = await rig();
    const { draft, added } = await r.draftWith({ "a.txt": "hello" });
    await added.settled;
    await deleteDraft(r.deps, draft.id);
    expect(await r.storage.attachments.allIds()).toEqual([]);
    expect(r.files.stored.size).toBe(0);
  });
});

describe("a message with files", () => {
  it("is built once into a spool, submitted from it with its size, and cleaned up after", async () => {
    const r = await rig();
    const { draft, added } = await r.draftWith({ "a.txt": "hello" });
    await added.settled;
    const op = await requestSend(r.deps, draft.id);
    r.state.now += 10_000;
    const [done] = await processOutbox(r.deps, SMALL);

    expect(done?.state.kind).toBe("succeeded");
    expect(r.composer.composed).toBe(0);
    expect(r.files.built).toHaveLength(1);
    expect(r.files.built[0]).toMatchObject({ operationId: op.id, names: ["a.txt"] });
    const sent = r.submit.submissions[0];
    expect(sent?.envelope.size).toBe(sent?.raw.byteLength);
    expect(new TextDecoder().decode(sent?.raw)).toContain("--file a.txt\r\nhello");
    expect(r.events.sendProgress.at(-1)).toEqual([
      op.id,
      sent?.raw.byteLength,
      sent?.raw.byteLength,
    ]);
    expect((await r.op(op.id)).mimeBytes).toBe(sent?.raw.byteLength);
    expect(await r.storage.outbox.getMime(op.id)).toBeNull();

    // the copy for the Sent folder is the spool, read once the send had succeeded
    expect(r.connector.sent.appended).toEqual([sent?.raw]);
    // everything is cleaned up
    expect(await r.storage.attachments.allIds()).toEqual([]);
    expect(r.files.stored.size).toBe(0);
    expect(r.files.spools.size).toBe(0);
    expect(await r.storage.drafts.get(draft.id)).toBeNull();
    const thread = (await r.storage.store.getThread("t1"))?.messages ?? [];
    expect(thread.at(-1)).toMatchObject({ subject: "Re: Wycena", hasAttachments: true });
  });

  it("reads the spool into memory only for the Sent copy, after the state is succeeded", async () => {
    const r = await rig();
    const { draft, added } = await r.draftWith({ "a.txt": "hello" });
    await added.settled;
    const op = await requestSend(r.deps, draft.id);
    r.state.now += 10_000;
    const statesWhenRead: string[] = [];
    const original = r.files.readSpool.bind(r.files);
    r.files.readSpool = async (path: string) => {
      statesWhenRead.push((await r.op(op.id)).state.kind);
      return original(path);
    };
    await processOutbox(r.deps, SMALL);
    expect(statesWhenRead).toEqual(["succeeded"]);
  });

  it("a message without files keeps the BLOB and builds nothing in the files work", async () => {
    const r = await rig();
    const draft = await saveDraft(r.deps, { content: r.content() });
    const op = await requestSend(r.deps, draft.id);
    r.state.now += 10_000;
    await processOutbox(r.deps, SMALL);
    expect(r.composer.composed).toBe(1);
    expect(r.files.built).toEqual([]);
    expect(await r.storage.outbox.getSpool(op.id)).toBeNull();
    expect(r.submit.submissions[0]?.envelope.size).toBe(r.submit.submissions[0]?.raw.byteLength);
  });

  it("after a failure the retry sends the very same spool", async () => {
    const r = await rig();
    const { draft, added } = await r.draftWith({ "a.txt": "hello" });
    await added.settled;
    const op = await requestSend(r.deps, draft.id);
    r.state.now += 10_000;
    r.submit.script.push({ kind: "rejected", reason: "451 try later", code: 451 });
    await processOutbox(r.deps, SMALL);
    expect((await r.op(op.id)).state).toEqual({ kind: "failed", reason: "451 try later" });
    // the spool is kept for the retry
    expect(r.files.spools.size).toBe(1);
    expect(await releaseSend(r.deps, op.id)).toBe(true);
    await processOutbox(r.deps, SMALL);
    expect((await r.op(op.id)).state.kind).toBe("succeeded");
    expect(r.files.built).toHaveLength(1);
    expect(r.submit.submissions).toHaveLength(2);
    expect(r.submit.submissions[1]?.raw).toEqual(r.submit.submissions[0]?.raw);
  });

  it("a stored copy that is gone at hand-off is Not sent, naming the file, with Open draft", async () => {
    const r = await rig();
    const { draft, added } = await r.draftWith({ "report.pdf": "hello" });
    await added.settled;
    const op = await requestSend(r.deps, draft.id);
    r.files.stored.clear();
    r.state.now += 10_000;
    await processOutbox(r.deps, SMALL);
    expect((await r.op(op.id)).state).toEqual({
      kind: "failed",
      reason: "report.pdf is missing",
      action: "openDraft",
    });
    expect(r.submit.submissions).toHaveLength(0);
  });

  it("a copy that no longer matches its hash is missing too", async () => {
    const r = await rig();
    const { draft, added } = await r.draftWith({ "report.pdf": "hello" });
    await added.settled;
    const op = await requestSend(r.deps, draft.id);
    r.files.stored.set("file-report.pdf", { bytes: new Uint8Array(1), sha256: "0".repeat(64) });
    r.state.now += 10_000;
    await processOutbox(r.deps, SMALL);
    expect((await r.op(op.id)).state).toMatchObject({
      kind: "failed",
      reason: "report.pdf is missing",
      action: "openDraft",
    });
  });

  it("the server's refusal for size is a failure that only the draft can fix", async () => {
    const r = await rig();
    const { draft, added } = await r.draftWith({ "a.txt": "hello" });
    await added.settled;
    const op = await requestSend(r.deps, draft.id);
    r.state.now += 10_000;
    r.submit.script.push({ kind: "rejected", reason: "552 too big", code: 552, tooLarge: true });
    await processOutbox(r.deps, SMALL);
    expect((await r.op(op.id)).state).toEqual({
      kind: "failed",
      reason: "552 too big",
      action: "openDraft",
    });
    // a 552 on its own says the same
    const again = await r.draftWith({ "b.txt": "x" }, { subject: "second" });
    await again.added.settled;
    const second = await requestSend(r.deps, again.draft.id);
    r.submit.script.push({ kind: "rejected", reason: "552 mailbox full", code: 552 });
    r.state.now += 10_000;
    await processOutbox(r.deps, SMALL);
    expect((await r.op(second.id)).state).toMatchObject({ kind: "failed", action: "openDraft" });
    // other refusals can be retried
    const third = await saveDraft(r.deps, { content: r.content({ subject: "third" }) });
    const plain = await requestSend(r.deps, third.id);
    r.submit.script.push({ kind: "rejected", reason: "550 no", code: 550 });
    r.state.now += 10_000;
    await processOutbox(r.deps, SMALL);
    expect((await r.op(plain.id)).state).toEqual({ kind: "failed", reason: "550 no" });
  });

  it("keeps the server's announced limit, and a later send is refused by it before Send", async () => {
    const r = await rig();
    r.submit.serverLimit = 1_000_000;
    const first = await saveDraft(r.deps, { content: r.content() });
    await requestSend(r.deps, first.id);
    r.state.now += 10_000;
    await processOutbox(r.deps, SMALL);
    await waitFor(
      async () => (await r.storage.accounts.get("acc1"))?.messageLimitBytes === 1_000_000,
    );

    const big = await r.draftWith({ "big.bin": new Uint8Array(900_000) }, { subject: "big" });
    await big.added.settled;
    expect(await requestSend(r.deps, big.draft.id).catch((e) => e)).toBeInstanceOf(
      SendBlockedError,
    );

    r.submit.serverLimit = null;
    const second = await saveDraft(r.deps, { content: r.content({ subject: "again" }) });
    await requestSend(r.deps, second.id);
    r.state.now += 10_000;
    await processOutbox(r.deps, SMALL);
    await waitFor(
      async () => (await r.storage.accounts.get("acc1"))?.messageLimitBytes === undefined,
    );
  });
});

describe("a connection lost before the data ended (ADR 0041, rules 13 and 16)", () => {
  it("is retried by itself after 5 s, 30 s and 2 min, with the same bytes, then fails", async () => {
    const r = await rig();
    const draft = await saveDraft(r.deps, { content: r.content() });
    const op = await requestSend(r.deps, draft.id);
    r.state.now += 10_000;
    for (const delay of [5_000, 30_000, 120_000]) {
      r.submit.script.push({ kind: "interrupted", reason: "ECONNRESET" });
      await processOutbox(r.deps, SMALL);
      const waiting = await r.op(op.id);
      expect(waiting.state.kind).toBe("pending");
      expect(waiting.notBeforeMs).toBe(r.state.now + delay);
      // nothing happens before it is due
      r.state.now += delay - 1;
      expect(await processOutbox(r.deps, SMALL)).toEqual([]);
      r.state.now += 1;
    }
    r.submit.script.push({ kind: "interrupted", reason: "ECONNRESET" });
    await processOutbox(r.deps, SMALL);
    expect((await r.op(op.id)).state).toEqual({
      kind: "failed",
      reason: "The connection kept dropping: ECONNRESET",
    });
    expect(r.submit.submissions).toHaveLength(4);
    const bytes = r.submit.submissions.map((s) => new TextDecoder().decode(s.raw));
    expect(new Set(bytes).size).toBe(1);
    expect(r.composer.composed).toBe(1);
  });

  it("an interrupted send can still be undone while it waits to try again", async () => {
    const r = await rig();
    const { draft, added } = await r.draftWith({ "a.txt": "hello" });
    await added.settled;
    const op = await requestSend(r.deps, draft.id);
    r.state.now += 10_000;
    r.submit.script.push({ kind: "interrupted", reason: "reset" });
    await processOutbox(r.deps, SMALL);
    expect(r.files.spools.size).toBe(1);
    expect(await undoSend(r.deps, op.id)).toBe("cancelled");
    expect(r.files.spools.size).toBe(0);
  });

  it("past the end of the data a lost connection is unknown, not retried", async () => {
    const r = await rig();
    const draft = await saveDraft(r.deps, { content: r.content() });
    const op = await requestSend(r.deps, draft.id);
    r.state.now += 10_000;
    r.submit.script.push({ kind: "unknown", reason: "no answer" });
    await processOutbox(r.deps, SMALL);
    const after = await r.op(op.id);
    expect(after.state.kind).toBe("unknown");
    expect(after.dataEnded).toBe(true);
  });
});

describe("Stop and quit (ADR 0041, rules 14 and 15)", () => {
  async function inFlight(r: Awaited<ReturnType<typeof rig>>) {
    const { draft, added } = await r.draftWith({ "a.txt": "hello" });
    await added.settled;
    const op = await requestSend(r.deps, draft.id);
    r.state.now += 10_000;
    let release: () => void = () => {};
    r.submit.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = processOutbox(r.deps, SMALL);
    await waitFor(() => r.events.transfers.has(op.id), "the transfer");
    await waitFor(() => r.submit.submissions.length === 1, "the data");
    return { op, run, release };
  }

  it("Stop during the upload closes it and cancels the send, with its spool", async () => {
    const r = await rig();
    const { op, run } = await inFlight(r);
    r.events.transfers.get(op.id)?.abort("stop");
    await run;
    expect((await r.op(op.id)).state.kind).toBe("cancelled");
    expect(r.files.spools.size).toBe(0);
    expect(r.events.transfers.size).toBe(0);
    expect(r.connector.sent.appended).toEqual([]);
  });

  it("quitting during the upload holds it: next start asks Send now or Discard", async () => {
    const r = await rig();
    const { op, run } = await inFlight(r);
    r.events.transfers.get(op.id)?.abort("quit");
    await run;
    const held = await r.op(op.id);
    expect(held.state.kind).toBe("held");
    expect(held.dataEnded).toBe(false);
    // the built message is kept: Send now uses it
    expect(r.files.spools.size).toBe(1);
    r.submit.gate = null;
    expect(await releaseSend(r.deps, op.id)).toBe(true);
    await processOutbox(r.deps, SMALL);
    expect((await r.op(op.id)).state.kind).toBe("succeeded");
    expect(r.files.built).toHaveLength(1);
  });

  it("writes the mark before the last byte, so a crash after it is unknown and before it is held", async () => {
    const r = await rig();
    const draft = await saveDraft(r.deps, { content: r.content() });
    const op = await requestSend(r.deps, draft.id);
    r.state.now += 10_000;
    let release: () => void = () => {};
    r.submit.gateAfterEnd = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = processOutbox(r.deps, SMALL);
    await waitFor(async () => (await r.op(op.id)).dataEnded, "the mark");
    expect((await r.op(op.id)).state.kind).toBe("running");
    // the app dies here: the data had ended
    expect(await holdExpiredOnStartup(r.deps)).toEqual({ held: 0, interrupted: 1 });
    expect((await r.op(op.id)).state.kind).toBe("unknown");
    release();
    await run;
  });
});

describe("two lanes (ADR 0041, rule 11)", () => {
  it("a reply overtakes a large upload", async () => {
    const r = await rig();
    const large = await r.draftWith({ "big.bin": new Uint8Array(1_500_000) }, { subject: "large" });
    await large.added.settled;
    const reply = await saveDraft(r.deps, { content: r.content({ subject: "reply" }) });
    const bigOp = await requestSend(r.deps, large.draft.id);
    const replyOp = await requestSend(r.deps, reply.id);
    expect(bigOp.encodedBytes).toBeGreaterThanOrEqual(1_048_576);
    r.state.now += 10_000;

    let release: () => void = () => {};
    r.submit.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.submit.gateWhen = (source) => source.size > 1_000_000;
    const bigRun = processOutbox(r.deps, LARGE);
    await waitFor(() => r.events.transfers.has(bigOp.id), "the large transfer");
    // the large lane never takes the reply, the small one never the large message
    expect((await processOutbox(r.deps, SMALL)).map((o) => o.id)).toEqual([replyOp.id]);
    expect((await r.op(replyOp.id)).state.kind).toBe("succeeded");
    expect((await r.op(bigOp.id)).state.kind).toBe("running");
    release();
    await bigRun;
    expect((await r.op(bigOp.id)).state.kind).toBe("succeeded");
  });

  it("the large lane sends one message per account at a time, other accounts alongside", async () => {
    const r = await rig();
    const blob = new Uint8Array(1_200_000);
    const mk = async (name: string, accountId: string, from: string) => {
      const made = await r.draftWith(
        { [name]: blob },
        {
          subject: name,
          accountId,
          from: { address: from },
          threadId: undefined,
          inReplyTo: "",
          references: [],
        },
      );
      await made.added.settled;
      return requestSend(r.deps, made.draft.id);
    };
    const a1 = await mk("a1.bin", "acc1", "me@example.com");
    const a2 = await mk("a2.bin", "acc1", "me@example.com");
    const b1 = await mk("b1.bin", "acc2", "other@example.com");
    r.state.now += 10_000;
    let release: () => void = () => {};
    r.submit.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = processOutbox(r.deps, LARGE);
    await waitFor(
      () => r.events.transfers.has(a1.id) && r.events.transfers.has(b1.id),
      "two transfers",
    );
    expect(r.events.transfers.has(a2.id)).toBe(false);
    expect((await r.op(a2.id)).state.kind).toBe("pending");
    release();
    const done = await run;
    expect(done.map((o) => o.state.kind)).toEqual(["succeeded", "succeeded", "succeeded"]);
    // a2 went after a1 had ended
    const order = r.submit.submissions.map((s) => new TextDecoder().decode(s.raw.subarray(0, 60)));
    expect(order).toHaveLength(3);
    expect(r.events.ops.some((o) => o.id === a2.id && o.state.kind === "running")).toBe(true);
  });

  it("only the lane's own overdue sends are held", async () => {
    const r = await rig();
    const large = await r.draftWith({ "big.bin": new Uint8Array(1_200_000) }, { subject: "large" });
    await large.added.settled;
    const small = await saveDraft(r.deps, { content: r.content({ subject: "small" }) });
    const bigOp = await requestSend(r.deps, large.draft.id);
    const smallOp = await requestSend(r.deps, small.id);
    r.state.now += 10_000 + 2 * OVERDUE_MS;
    await processOutbox(r.deps, SMALL);
    expect((await r.op(smallOp.id)).state.kind).toBe("held");
    expect((await r.op(bigOp.id)).state.kind).toBe("pending");
    await processOutbox(r.deps, LARGE);
    expect((await r.op(bigOp.id)).state.kind).toBe("held");
  });
});

describe("the files of a draft over time", () => {
  it("a copy that was running when the app stopped starts again; one without an original fails", async () => {
    const r = await rig();
    const draft = await saveDraft(r.deps, { content: r.content() });
    r.files.addFile("/src/a.txt", "hello");
    const base = {
      draftId: draft.id,
      accountId: "acc1",
      state: "reading" as const,
      reason: null,
      sha256: null,
      sourceMtimeMs: null,
      origin: null,
      createdAtMs: 1,
      size: 5,
    };
    await r.storage.attachments.add({ ...base, id: "a", name: "a.txt", sourcePath: "/src/a.txt" });
    await r.storage.attachments.add({ ...base, id: "x", name: "x.txt", sourcePath: null });
    const resumed = await resumeCaptures(r.deps);
    expect(resumed).toMatchObject({ resumed: 1, failed: 1 });
    await resumed.settled;
    expect(await r.row("a")).toMatchObject({ state: "ready" });
    expect(await r.row("x")).toMatchObject({ state: "failed", reason: "Can't read this file" });
  });

  it("notices an original edited after it was attached, but not one that is gone", async () => {
    const r = await rig();
    const { draft, added } = await r.draftWith({
      "a.txt": "hello",
      "b.txt": "other",
      "c.txt": "same",
    });
    await added.settled;
    expect(await checkAttachmentSources(r.deps, draft.id)).toEqual([]);
    r.files.addFile("/src/a.txt", "hello, edited", 2_000);
    r.files.sources.delete("/src/b.txt");
    r.files.addFile("/src/c.txt", "same", 5_000); // touched, same size, different time
    expect(await checkAttachmentSources(r.deps, draft.id)).toEqual(["file-a.txt", "file-c.txt"]);
  });

  it("'Use new version' reads the original again as a new attachment", async () => {
    const r = await rig();
    const { draft, added } = await r.draftWith({ "a.txt": "hello" });
    await added.settled;
    r.files.addFile("/src/a.txt", "hello, edited", 2_000);
    const again = await recaptureAttachment(r.deps, draft.id, "file-a.txt");
    const fresh = again?.attachments[0]?.id ?? "";
    expect(fresh).not.toBe("file-a.txt");
    expect(again?.attachments[0]).toMatchObject({ name: "a.txt", state: "reading" });
    await again?.settled;
    expect(await r.row(fresh)).toMatchObject({ state: "ready", size: 13, sourceMtimeMs: 2_000 });
    // the old copy is still there until the draft is saved without it
    expect(await r.row("file-a.txt")).toMatchObject({ state: "ready", size: 5 });
    expect(await recaptureAttachment(r.deps, draft.id, "nope")).toBeNull();
    expect(await recaptureAttachment(r.deps, "other-draft", "file-a.txt")).toBeNull();
  });

  it("sweeps rows whose draft is gone and files no row names, keeping the spool of an unknown send", async () => {
    const r = await rig();
    const keep = await r.draftWith({ "a.txt": "hello" }, { subject: "keep" });
    await keep.added.settled;
    const gone = await r.draftWith({ "b.txt": "bye" }, { subject: "gone" });
    await gone.added.settled;
    await r.storage.drafts.delete(gone.draft.id);
    r.files.stored.set("stray", { bytes: new Uint8Array(1), sha256: "x" });
    r.files.spools.set("spool/stray", new Uint8Array(1));
    r.files.spools.set("spool/live", new Uint8Array(1));
    const op = await requestSend(r.deps, keep.draft.id);
    await r.storage.outbox.setSpool(op.id, "<m@x>", "spool/live", 1);
    await sweepAttachmentFiles(r.deps);
    expect(await r.storage.attachments.allIds()).toEqual(["file-a.txt"]);
    expect([...r.files.stored.keys()]).toEqual(["file-a.txt"]);
    expect([...r.files.spools.keys()]).toEqual(["spool/live"]);
  });

  it("removing an account removes its files and spools", async () => {
    const r = await rig();
    const { draft, added } = await r.draftWith({ "a.txt": "hello" });
    await added.settled;
    const op = await requestSend(r.deps, draft.id);
    r.files.spools.set("spool/o", new Uint8Array(1));
    await r.storage.outbox.setSpool(op.id, "<m@x>", "spool/o", 1);
    await removeAccount(
      {
        ...r.storage,
        accounts: r.storage.accounts,
        credentials: r.credentials,
        attachments: r.storage.attachments,
        files: r.files,
        flagOps: r.storage.flagOps,
      },
      "acc1",
    );
    expect(await r.storage.attachments.allIds()).toEqual([]);
    expect(r.files.stored.size).toBe(0);
    expect(r.files.spools.size).toBe(0);
  });
});

describe("probeMessageLimit", () => {
  it("asks the outgoing server and keeps what it announces", async () => {
    const r = await rig();
    r.submit.outgoing = { ok: true, limitBytes: 26_214_400 };
    expect(await probeMessageLimit(r.deps, "acc1")).toBe(26_214_400);
    expect((await r.storage.accounts.get("acc1"))?.messageLimitBytes).toBe(26_214_400);
    r.submit.outgoing = { ok: true, limitBytes: null };
    expect(await probeMessageLimit(r.deps, "acc1")).toBeNull();
    expect((await r.storage.accounts.get("acc1"))?.messageLimitBytes).toBeUndefined();
  });

  it("leaves the stored limit alone when the server cannot be asked", async () => {
    const r = await rig({ limit: 5_000_000 });
    r.submit.outgoing = { ok: false, kind: "unreachable", reason: "down" };
    expect(await probeMessageLimit(r.deps, "acc1")).toBeNull();
    expect((await r.storage.accounts.get("acc1"))?.messageLimitBytes).toBe(5_000_000);
    expect(await probeMessageLimit(r.deps, "nope")).toBeNull();
  });
});

describe("a file work failure reaches the user as a failure, not a crash", () => {
  it("a build that throws a FileWorkError offers the draft", async () => {
    const r = await rig();
    const { draft, added } = await r.draftWith({ "a.txt": "hello" });
    await added.settled;
    const op = await requestSend(r.deps, draft.id);
    r.files.failBuild = new FileWorkError("noSpace", "There is not enough disk space");
    r.state.now += 10_000;
    await processOutbox(r.deps, SMALL);
    expect((await r.op(op.id)).state).toEqual({
      kind: "failed",
      reason: "There is not enough disk space",
      action: "openDraft",
    });
  });
});

describe("changing the sender of a draft (ADR 0050)", () => {
  const fromOther = {
    accountId: "acc2",
    from: { name: "Other", address: "other@example.com" },
    inReplyTo: "",
    references: [],
  };

  it("takes the files along, so removing an account takes only the files of its own drafts", async () => {
    const r = await rig();
    const { draft, added, listed } = await r.draftWith(
      { "a.txt": "hello" },
      { threadId: undefined },
    );
    await added.settled;
    const moved = await saveDraft(r.deps, {
      id: draft.id,
      content: r.content({ ...fromOther, threadId: undefined, attachments: listed }),
    });
    expect(moved).toMatchObject({ accountId: "acc2", version: draft.version + 1 });
    expect(await r.row("file-a.txt")).toMatchObject({ accountId: "acc2", state: "ready" });
    await r.storage.attachments.discardAccount("acc1");
    expect(await r.storage.attachments.get("file-a.txt")).not.toBeNull();
  });

  it("voids a send still waiting on the old sender", async () => {
    const r = await rig();
    const draft = await saveDraft(r.deps, { content: r.content({ threadId: undefined }) });
    const op = await requestSend(r.deps, draft.id);
    await saveDraft(r.deps, {
      id: draft.id,
      content: r.content({ ...fromOther, threadId: undefined }),
    });
    expect((await r.op(op.id)).state.kind).toBe("voided");
  });

  it("checks the message against the new sender's limit", async () => {
    const r = await rig();
    await r.storage.accounts.setMessageLimit("acc2", 10);
    const { draft, added, listed } = await r.draftWith(
      { "a.txt": "hello" },
      { threadId: undefined },
    );
    await added.settled;
    await saveDraft(r.deps, {
      id: draft.id,
      content: r.content({ ...fromOther, threadId: undefined, attachments: listed }),
    });
    await expect(requestSend(r.deps, draft.id)).rejects.toBeInstanceOf(SendBlockedError);
  });
});
