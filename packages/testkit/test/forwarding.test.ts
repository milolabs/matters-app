// The files of a forward (ADR 0045, rules 6 to 10): a part of a received message is downloaded
// through the cache of ADR 0043 and then captured into a copy the draft owns (ADR 0041).
import { createHash } from "node:crypto";
import type {
  DraftContent,
  ProcessDeps,
  ReceivedAttachment,
  SendOperation,
  StoredAccount,
  StoredAttachment,
} from "@matters/core";
import {
  addForwardedAttachments,
  CopyBook,
  deleteDraft,
  dropAttachments,
  OVERDUE_MS,
  processOutbox,
  ReceivedDownloads,
  recaptureAttachment,
  requestSend,
  resumeCaptures,
  SendBlockedError,
  saveDraft,
  sweepAttachmentFiles,
} from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  createInMemoryStorage,
  FakeComposeRenderer,
  FakeFileWork,
  FakeMailAttachments,
  FakeMailConnector,
  FakeMailError,
  FakeMailSubmit,
  FakeMailSync,
  FakeMessageComposer,
  InMemoryCredentialStore,
  InMemoryReceivedFiles,
  makeDocument,
  makeLocation,
} from "../src/index.ts";

const T0 = 1_800_000_000_000;
const SMALL = { lane: "small" } as const;
const bytes = (...values: number[]) => new Uint8Array(values);
const sleep = (ms = 1) => new Promise((r) => setTimeout(r, ms));

const part = (partId: string, name: string, size: number): ReceivedAttachment => ({
  partId,
  name,
  mimeType: "application/pdf",
  size,
  inline: false,
});

const account = (over: Partial<StoredAccount> = {}): StoredAccount => ({
  id: "acc1",
  address: "me@example.com",
  displayName: "me",
  imap: { host: "imap.example.com", port: 993, security: "tls", username: "me" },
  smtp: { host: "smtp.example.com", port: 587, security: "starttls", username: "me" },
  createdAtMs: 1,
  ...over,
});

/** A message with files on the fake server, a cache, a draft's file work, and a quit button. */
async function rig(options: { limit?: number } = {}) {
  const storage = createInMemoryStorage();
  await storage.accounts.add(account(options.limit ? { messageLimitBytes: options.limit } : {}));
  const credentials = new InMemoryCredentialStore();
  await credentials.set("acc1", { kind: "password", username: "me", password: "pw" });
  const server = new FakeMailAttachments();
  const cache = new InMemoryReceivedFiles();
  const files = new FakeFileWork();
  files.cache = cache;
  const progress: [string, number][] = [];
  const changed: string[] = [];
  const ops: SendOperation[] = [];
  const state = { now: T0, ids: 0 };
  const submit = new FakeMailSubmit();

  const newDownloads = () =>
    new ReceivedDownloads({
      store: storage.store,
      files: cache,
      open: async () => ({ attachments: server, close: async () => {} }),
    });
  let downloads = newDownloads();

  const deps: ProcessDeps = {
    drafts: storage.drafts,
    outbox: storage.outbox,
    store: storage.store,
    accounts: storage.accounts,
    credentials,
    renderer: new FakeComposeRenderer(),
    composer: new FakeMessageComposer(),
    submit,
    connector: new FakeMailConnector(new FakeMailSync(["INBOX", "Sent"], [])),
    ingest: storage,
    attachments: storage.attachments,
    files,
    carriers: [],
    sha256: (t) => createHash("sha256").update(t, "utf8").digest("hex"),
    newId: () => `id${++state.ids}`,
    now: () => state.now,
    onChange: (op) => ops.push(op),
    onAttachmentsChanged: (draftId) => changed.push(draftId),
    onAttachmentProgress: (id, fraction) => progress.push([id, fraction]),
    wakeOutbox: () => {},
    onTransferStart: () => {},
    onTransferEnd: () => {},
    onSendProgress: () => {},
    forward: {
      attachment: (key, partId) => storage.store.getAttachment(key, partId),
      fetch: (key, partId, watch) => downloads.fetch(key, partId, watch),
      locate: (key, partId) => cache.locate(key, partId),
      stopped: () => downloads.stopped,
    },
    copies: new CopyBook(),
  };

  /** A stored message with these files, each served by the fake server unless it is `null`. */
  async function message(
    uid: number,
    listed: readonly (readonly [ReceivedAttachment, Uint8Array | null])[],
  ) {
    const doc = makeDocument({ providerId: `m${uid}`, hasAttachments: true, threadId: `t${uid}` });
    const [key] = (await storage.store.upsertMessages([doc.message])).keys;
    const location = makeLocation(uid);
    await storage.store.addLocations([{ key: key as number, location }]);
    await storage.store.setAttachments([{ location, attachments: listed.map(([p]) => p) }]);
    for (const [p, content] of listed) if (content) server.put(location, p.partId, content);
    return { key: key as number, location };
  }
  const content = (over: Partial<DraftContent> = {}): DraftContent => ({
    accountId: "acc1",
    from: { name: "me", address: "me@example.com" },
    to: [{ name: "Anna", address: "anna@northwind.example" }],
    cc: [],
    bcc: [],
    subject: "Fwd: Faktury",
    bodyMarkdown: "Zobacz.",
    inReplyTo: "",
    references: [],
    forwarded: true,
    ...over,
  });
  /** A forward draft listing these rows, in the order given. */
  async function draftFor(rows: readonly { id: string; name: string; size: number }[], over = {}) {
    return saveDraft(deps, {
      content: content({
        attachments: rows.map((r) => ({ ...r, delivery: { kind: "inline" as const } })),
        ...over,
      }),
    });
  }
  const row = async (id: string) => (await storage.attachments.get(id)) as StoredAttachment;
  const op = async (id: string) => (await storage.outbox.get(id)) as SendOperation;
  return {
    storage,
    server,
    cache,
    files,
    deps,
    progress,
    changed,
    ops,
    state,
    submit,
    message,
    content,
    draftFor,
    row,
    op,
    get downloads() {
      return downloads;
    },
    /** The app starts again: its downloads are new, the disk and the database are what they were. */
    restart() {
      downloads = newDownloads();
    },
  };
}

const origin = (messageKey: number, partId: string) => ({ messageKey, partId });

describe("forwarded files: download, then capture (rule 7)", () => {
  it("downloads the part into the cache and copies it to the draft's own", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "Faktura.pdf", 3), bytes(1, 2, 3)]]);
    const draft = await r.draftFor([{ id: "f1", name: "Faktura.pdf", size: 3 }]);

    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    // The row exists at once, before the bytes are there, with the origin stored.
    expect(added.attachments[0]).toMatchObject({
      id: "f1",
      state: "reading",
      name: "Faktura.pdf",
      origin: { messageKey: key, partId: "2" },
      sourcePath: null,
    });
    await added.settled;

    expect(await r.row("f1")).toMatchObject({
      state: "ready",
      reason: null,
      size: 3,
      sourcePath: null,
      sourceMtimeMs: null,
      sha256: createHash("sha256")
        .update(bytes(1, 2, 3))
        .digest("hex"),
    });
    expect(r.files.stored.get("f1")?.bytes).toEqual(bytes(1, 2, 3));
    // The cache is the sweep's: the draft's copy does not depend on it, and it is still there.
    expect(r.cache.has(key, "2")).toBe(true);
  });

  it("takes the name and size from the message, not from the page, and skips a part it lacks", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "Faktura.pdf", 3), bytes(1, 2, 3)]]);
    const draft = await r.draftFor([]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
      { id: "f2", origin: origin(key, "9") },
      { id: "f3", origin: origin(99_999, "2") },
    ]);
    expect(added.attachments.map((a) => [a.id, a.name, a.size])).toEqual([
      ["f1", "Faktura.pdf", 3],
    ]);
  });

  it("keeps the order of the message and gives each file its own id", async () => {
    const r = await rig();
    const { key } = await r.message(1, [
      [part("2", "b.pdf", 1), bytes(2)],
      [part("3", "a.pdf", 1), bytes(1)],
    ]);
    const draft = await r.draftFor([]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "x1", origin: origin(key, "2") },
      { id: "x2", origin: origin(key, "3") },
    ]);
    await added.settled;
    expect((await r.storage.attachments.forDraft(draft.id)).map((a) => a.name)).toEqual([
      "b.pdf",
      "a.pdf",
    ]);
  });

  it("is idempotent for the same id, like any other file", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "a.pdf", 1), bytes(1)]]);
    const draft = await r.draftFor([]);
    const first = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    await first.settled;
    const again = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    await again.settled;
    expect(r.server.requests).toHaveLength(1);
    expect(await r.storage.attachments.allIds()).toEqual(["f1"]);
  });

  it("one ring: the download fills it with its bytes, the capture adds nothing", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "a.pdf", 10), bytes(1, 2, 3)]]);
    r.server.put(makeLocation(1), "2", bytes(1, 2, 3), bytes(4, 5, 6, 7), bytes(8, 9, 10, 11));
    const draft = await r.draftFor([]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    await added.settled;
    expect(r.progress).toEqual([
      ["f1", 0.3],
      ["f1", 0.7],
      ["f1", 1],
    ]);
    // The size was an estimate of 10; the true size replaces it.
    expect((await r.row("f1")).size).toBe(11);
  });

  it("a part already in the cache costs no connection", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "a.pdf", 2), bytes(7, 8)]]);
    await r.downloads.fetch(key, "2");
    const draft = await r.draftFor([]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    await added.settled;
    expect(r.server.requests).toHaveLength(1);
    expect(r.files.stored.get("f1")?.bytes).toEqual(bytes(7, 8));
  });
});

describe("forwarded files that cannot be had (rules 8 and 10)", () => {
  it("offline: the chip says so, offers Try again, and the retry starts from the origin", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "a.pdf", 2), bytes(7, 8)]]);
    r.server.errors.push(new FakeMailError("unreachable"));
    const draft = await r.draftFor([]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    await added.settled;
    expect(await r.row("f1")).toMatchObject({
      state: "failed",
      reason: "Couldn’t download",
      origin: { messageKey: key, partId: "2" },
    });

    const retried = await recaptureAttachment(r.deps, draft.id, "f1");
    expect(retried?.attachments[0]).toMatchObject({
      id: "id2",
      state: "reading",
      origin: { messageKey: key, partId: "2" },
    });
    await retried?.settled;
    expect(await r.row("id2")).toMatchObject({ state: "ready", reason: null });
    expect(r.files.stored.get("id2")?.bytes).toEqual(bytes(7, 8));
  });

  it("retries from the origin after the cache was swept", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "a.pdf", 2), bytes(7, 8)]]);
    const draft = await r.draftFor([]);
    const first = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    await first.settled;
    // The cache copy the first capture read goes, and the file is asked for again.
    r.cache.sweepAway(key, "2");
    const retried = await recaptureAttachment(r.deps, draft.id, "f1");
    await retried?.settled;
    expect(r.server.requests).toHaveLength(2);
    expect(await r.row("id2")).toMatchObject({ state: "ready" });
    expect(r.files.stored.get("id2")?.bytes).toEqual(bytes(7, 8));
  });

  it("gone from the server: said quietly, with no way to try again", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "Skierowanie.pdf", 2), null]]);
    const draft = await r.draftFor([]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    await added.settled;
    const failed = await r.row("f1");
    expect(failed).toMatchObject({ state: "failed", reason: "No longer on the server" });
    const { canRetryAttachment } = await import("@matters/core");
    expect(canRetryAttachment(failed)).toBe(false);
    expect(canRetryAttachment({ state: "failed", reason: "Couldn’t download" })).toBe(true);
  });

  it("a file over the account's limit is a chip and is never downloaded", async () => {
    const r = await rig({ limit: 1_000_000 });
    const { key } = await r.message(1, [[part("2", "Projekt.zip", 900_000), bytes(1)]]);
    const draft = await r.draftFor([]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    await added.settled;
    expect(await r.row("f1")).toMatchObject({
      state: "tooLarge",
      reason: "Larger than your server takes",
    });
    expect(r.server.requests).toHaveLength(0);
    expect(r.files.captures).toHaveLength(0);
  });

  it("a cache copy that cannot be read is a download that failed, not the user's file", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "a.pdf", 2), bytes(1)]]);
    await r.downloads.fetch(key, "2");
    // The path `locate` gives is not one the file work can read.
    r.cache.locate = async () => "cache/elsewhere";
    const draft = await r.draftFor([]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    await added.settled;
    expect(await r.row("f1")).toMatchObject({ state: "failed", reason: "Couldn’t download" });
  });
});

describe("two drafts from one message", () => {
  it("each has its own id and copy, and the part is downloaded once", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "a.pdf", 2), bytes(5, 6)]]);
    const one = await r.draftFor([], { subject: "one" });
    const two = await r.draftFor([], { subject: "two" });
    const a = await addForwardedAttachments(r.deps, one.id, [
      { id: "a1", origin: origin(key, "2") },
    ]);
    const b = await addForwardedAttachments(r.deps, two.id, [
      { id: "b1", origin: origin(key, "2") },
    ]);
    await Promise.all([a.settled, b.settled]);
    expect(r.server.requests).toHaveLength(1);
    expect(r.files.stored.get("a1")?.bytes).toEqual(bytes(5, 6));
    expect(r.files.stored.get("b1")?.bytes).toEqual(bytes(5, 6));
    expect(await r.storage.attachments.allIds()).toEqual(["a1", "b1"]);

    // Discarding one leaves the other, and the cache, alone.
    await deleteDraft(r.deps, one.id);
    expect(r.files.stored.has("a1")).toBe(false);
    expect(r.files.stored.get("b1")?.bytes).toEqual(bytes(5, 6));
    expect(r.cache.has(key, "2")).toBe(true);
  });
});

describe("removing a chip (rule 6)", () => {
  it("during the download stops the copy and the download nobody else wants", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "a.pdf", 6), bytes(1, 2)]]);
    r.server.put(makeLocation(1), "2", bytes(1, 2), bytes(3, 4), bytes(5, 6));
    let release!: () => void;
    r.server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const draft = await r.draftFor([]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    await sleep(5);
    await dropAttachments(r.deps, ["f1"]);
    release();
    await added.settled;
    await sleep(5);

    expect(await r.storage.attachments.get("f1")).toBeNull();
    expect(r.files.stored.has("f1")).toBe(false);
    expect(r.files.captures).toHaveLength(0);
    // Nobody was waiting for the file, so it was not kept either.
    expect(r.cache.has(key, "2")).toBe(false);
  });

  it("does not stop a download a reader in another window is waiting on", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "a.pdf", 6), bytes(1, 2)]]);
    r.server.put(makeLocation(1), "2", bytes(1, 2), bytes(3, 4), bytes(5, 6));
    let release!: () => void;
    r.server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const draft = await r.draftFor([]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    await sleep(5);
    // A reader presses the same chip: it joins the download that is running.
    const reader = r.downloads.fetch(key, "2");
    await dropAttachments(r.deps, ["f1"]);
    release();

    expect(await reader).toEqual({ kind: "done" });
    await added.settled;
    expect(r.cache.has(key, "2")).toBe(true);
    // The chip was removed, so no copy of it stays.
    expect(await r.storage.attachments.get("f1")).toBeNull();
    expect(r.files.stored.has("f1")).toBe(false);
    expect(r.server.requests).toHaveLength(1);
  });

  it("stops the download only when every forward waiting on it has been removed", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "a.pdf", 6), bytes(1, 2)]]);
    r.server.put(makeLocation(1), "2", bytes(1, 2), bytes(3, 4), bytes(5, 6));
    let release!: () => void;
    r.server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const one = await r.draftFor([], { subject: "one" });
    const two = await r.draftFor([], { subject: "two" });
    const a = await addForwardedAttachments(r.deps, one.id, [
      { id: "a1", origin: origin(key, "2") },
    ]);
    const b = await addForwardedAttachments(r.deps, two.id, [
      { id: "b1", origin: origin(key, "2") },
    ]);
    await sleep(5);
    await dropAttachments(r.deps, ["a1"]);
    release();
    await Promise.all([a.settled, b.settled]);
    expect((await r.row("b1")).state).toBe("ready");
    expect(r.files.stored.has("a1")).toBe(false);
  });

  it("never touches the cache copy while it exists, with the copy ready or not", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "a.pdf", 2), bytes(7, 8)]]);
    const draft = await r.draftFor([]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    await added.settled;
    await dropAttachments(r.deps, ["f1"]);
    expect(r.files.stored.has("f1")).toBe(false);
    expect(r.cache.content(key, "2")).toEqual(bytes(7, 8));
  });

  it("changes the draft's fingerprint, and voids the approval of the old one", async () => {
    const r = await rig();
    const { key } = await r.message(1, [
      [part("2", "a.pdf", 1), bytes(1)],
      [part("3", "b.pdf", 1), bytes(2)],
    ]);
    const listed = [
      { id: "f1", name: "a.pdf", size: 1 },
      { id: "f2", name: "b.pdf", size: 1 },
    ];
    const draft = await r.draftFor(listed);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
      { id: "f2", origin: origin(key, "3") },
    ]);
    await added.settled;
    const sending = await requestSend(r.deps, draft.id);

    const without = await saveDraft(r.deps, {
      id: draft.id,
      content: r.content({
        attachments: [{ id: "f2", name: "b.pdf", size: 1, delivery: { kind: "inline" } }],
      }),
    });
    expect(without.fingerprint).not.toBe(draft.fingerprint);
    expect((await r.op(sending.id)).state.kind).toBe("voided");
    // The removed chip's row and copy go; the other and the cache stay.
    expect(await r.storage.attachments.get("f1")).toBeNull();
    expect(r.files.stored.has("f1")).toBe(false);
    expect(r.files.stored.has("f2")).toBe(true);
    expect(r.cache.has(key, "2")).toBe(true);
  });
});

describe("Send with forwarded files (rule 9)", () => {
  it("pressed while a file is on its way, waits for it and then goes with its bytes", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "a.pdf", 3), bytes(1, 2, 3)]]);
    let release!: () => void;
    r.server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const draft = await r.draftFor([{ id: "f1", name: "a.pdf", size: 3 }]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    await sleep(5);
    expect((await r.row("f1")).state).toBe("reading");

    const sending = await requestSend(r.deps, draft.id);
    r.state.now += 10_000 + 5 * OVERDUE_MS;
    expect(await processOutbox(r.deps, SMALL)).toEqual([]);
    expect((await r.op(sending.id)).state.kind).toBe("pending");
    expect(r.submit.submissions).toHaveLength(0);

    release();
    await added.settled;
    const done = await processOutbox(r.deps, SMALL);
    expect(done.map((o) => o.state.kind)).toEqual(["succeeded"]);
    const sent = new TextDecoder("latin1").decode(r.submit.submissions[0]?.raw);
    expect(sent).toContain("--file a.pdf");
    expect(r.submit.submissions[0]?.raw.slice(-3)).toEqual(bytes(1, 2, 3));
  });

  it("a download that fails fails the send with the file's name, and nothing is sent", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "Skierowanie.pdf", 3), null]]);
    let release!: () => void;
    r.server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const draft = await r.draftFor([{ id: "f1", name: "Skierowanie.pdf", size: 3 }]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    const sending = await requestSend(r.deps, draft.id);
    release();
    await added.settled;
    expect((await r.op(sending.id)).state).toEqual({
      kind: "failed",
      reason: "Skierowanie.pdf: No longer on the server",
      action: "openDraft",
    });
    r.state.now += 10_000;
    expect(await processOutbox(r.deps, SMALL)).toEqual([]);
    expect(r.submit.submissions).toHaveLength(0);
  });

  it("an offline download fails the send the same way, and Send stays blocked on the chip", async () => {
    const r = await rig();
    const { key } = await r.message(1, [[part("2", "a.pdf", 3), bytes(1)]]);
    r.server.errors.push(new FakeMailError("unreachable"));
    const draft = await r.draftFor([{ id: "f1", name: "a.pdf", size: 3 }]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    await added.settled;
    const refused = await requestSend(r.deps, draft.id).catch((e) => e);
    expect(refused).toBeInstanceOf(SendBlockedError);
    expect(refused.message).toBe("a.pdf: Couldn’t download");
  });
});

describe("a quit in the middle (start-up recovery, ADR 0041 rule 19)", () => {
  async function quitDuringDownload(r: Awaited<ReturnType<typeof rig>>) {
    const { key } = await r.message(1, [[part("2", "a.pdf", 3), bytes(1)]]);
    r.server.put(makeLocation(1), "2", bytes(1), bytes(2), bytes(3));
    let release!: () => void;
    r.server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const draft = await r.draftFor([{ id: "f1", name: "a.pdf", size: 3 }]);
    const added = await addForwardedAttachments(r.deps, draft.id, [
      { id: "f1", origin: origin(key, "2") },
    ]);
    const sending = await requestSend(r.deps, draft.id);
    await sleep(5);
    r.downloads.abortAll();
    release();
    await added.settled;
    return { draft, sending, key };
  }

  it("leaves the file reading, not failed, so the next start picks it up", async () => {
    const r = await rig();
    await quitDuringDownload(r);
    expect((await r.row("f1")).state).toBe("reading");
    expect(r.cache.has(1, "2")).toBe(false);
  });

  it("the next start downloads it again, and a held send then goes with it", async () => {
    const r = await rig();
    const { sending } = await quitDuringDownload(r);
    // The window ended while the app was closed: the send is held, not lost.
    r.state.now += 10_000 + 5 * OVERDUE_MS;
    r.restart();
    r.server.gate = null;

    const resumed = await resumeCaptures(r.deps);
    expect(resumed).toMatchObject({ resumed: 1, failed: 0 });
    await resumed.settled;
    expect((await r.row("f1")).state).toBe("ready");
    expect(r.files.stored.get("f1")?.bytes).toEqual(bytes(1, 2, 3));
    const done = await processOutbox(r.deps, SMALL);
    expect(done.map((o) => o.id)).toEqual([sending.id]);
    expect(r.submit.submissions).toHaveLength(1);
  });

  it("never stays reading when it cannot be had: it fails, and the send fails with its name", async () => {
    const r = await rig();
    const { sending } = await quitDuringDownload(r);
    r.restart();
    r.server.gate = null;
    r.server.errors.push(new FakeMailError("unreachable"));
    const resumed = await resumeCaptures(r.deps);
    await resumed.settled;
    expect((await r.row("f1")).state).toBe("failed");
    expect((await r.op(sending.id)).state).toMatchObject({
      kind: "failed",
      reason: "a.pdf: Couldn’t download",
      action: "openDraft",
    });
    r.state.now += 10_000;
    expect(await processOutbox(r.deps, SMALL)).toEqual([]);
    expect(r.submit.submissions).toHaveLength(0);
  });

  it("a send held at start-up does not go while the file is still being read", async () => {
    const r = await rig();
    const { sending } = await quitDuringDownload(r);
    r.state.now += 10_000 + 5 * OVERDUE_MS;
    // Before recovery has finished: reading, so nothing is claimed.
    expect(await processOutbox(r.deps, SMALL)).toEqual([]);
    expect((await r.op(sending.id)).state.kind).toBe("pending");
    expect(r.submit.submissions).toHaveLength(0);
  });

  it("the sweep of start-up keeps the rows of forwarded files that are being read", async () => {
    const r = await rig();
    await quitDuringDownload(r);
    await sweepAttachmentFiles(r.deps);
    expect(await r.storage.attachments.get("f1")).not.toBeNull();
  });
});
