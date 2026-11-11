import { createHash } from "node:crypto";
import type {
  DraftContent,
  ProcessDeps,
  ProviderCapability,
  SendOperation,
  StoredAccount,
} from "@matters/core";
import {
  applySyncBatch,
  deleteDraft,
  discardSend,
  holdExpiredOnStartup,
  ingestDocuments,
  markDataEnded,
  messageKey,
  processOutbox,
  reconcileUnknown,
  releaseSend,
  requestSend,
  resolveUnknown,
  SendBlockedError,
  saveDraft,
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
  makeSyncBatch,
  syncedDoc,
} from "../src/index.ts";

const T0 = 1_800_000_000_000;
const PASSWORD = "s3cret-pw-value";

const account: StoredAccount = {
  id: "acc1",
  address: "me@example.com",
  displayName: "Miłosz",
  imap: { host: "imap.example.com", port: 993, security: "tls", username: "me" },
  smtp: { host: "smtp.example.com", port: 587, security: "starttls", username: "me" },
  createdAtMs: 1,
};

const replyContent = (over: Partial<DraftContent> = {}): DraftContent => ({
  accountId: "acc1",
  from: { name: "Miłosz", address: "me@example.com" },
  to: [{ name: "Anna", address: "anna@northwind.example" }],
  cc: [],
  bcc: [{ address: "secret@example.com" }],
  subject: "Re: Wycena",
  bodyMarkdown: "Dzień dobry, cena: 36 000 PLN.",
  inReplyTo: "<a1@northwind.example>",
  references: ["<a1@northwind.example>"],
  threadId: "t1",
  ...over,
});

async function rig(options: { capabilities?: ProviderCapability[]; withAccount?: boolean } = {}) {
  const storage = createInMemoryStorage();
  if (options.withAccount !== false) await storage.accounts.add(account);
  const credentials = new InMemoryCredentialStore();
  await credentials.set("acc1", { kind: "password", username: "me", password: PASSWORD });
  const server = new FakeMailSync(["INBOX", "Sent"], options.capabilities ?? []);
  const connector = new FakeMailConnector(server);
  const submit = new FakeMailSubmit();
  const composer = new FakeMessageComposer();
  const files = new FakeFileWork();
  const state = { now: T0, ids: 0, changes: [] as SendOperation[] };
  // The thread being answered, one message from Anna.
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
    onChange: (op) => state.changes.push(op),
  };
  const draft = async (over: Partial<DraftContent> = {}) =>
    saveDraft(deps, { content: replyContent(over) });
  const op = async (id: string) => (await storage.outbox.get(id)) as SendOperation;
  const threadMessages = async () => (await storage.store.getThread("t1"))?.messages ?? [];
  return {
    storage,
    credentials,
    server,
    connector,
    submit,
    composer,
    files,
    state,
    deps,
    draft,
    op,
    threadMessages,
  };
}

describe("saveDraft", () => {
  it("creates, keeps the version for the same content and bumps it for a change", async () => {
    const r = await rig();
    const d1 = await r.draft();
    expect(d1).toMatchObject({ id: "id1", version: 1 });
    const same = await saveDraft(r.deps, { id: d1.id, content: replyContent() });
    expect(same).toBe(d1);
    const d2 = await saveDraft(r.deps, { id: d1.id, content: replyContent({ subject: "Inny" }) });
    expect(d2).toMatchObject({ id: d1.id, version: 2 });
    expect((await r.storage.drafts.get(d1.id))?.subject).toBe("Inny");
  });

  it("an edit after Send voids the waiting send at once, with the reason", async () => {
    const r = await rig();
    const d = await r.draft();
    const sent = await requestSend(r.deps, d.id);
    await saveDraft(r.deps, {
      id: d.id,
      content: replyContent({ bodyMarkdown: "Zmieniona treść" }),
    });
    expect((await r.op(sent.id)).state).toEqual({
      kind: "voided",
      reason: "The draft was edited after you pressed Send.",
    });
    r.state.now += 60_000;
    await processOutbox(r.deps, { lane: "small", lateMs: 1e9 });
    expect(r.submit.submissions).toHaveLength(0);
  });

  it("deleting a draft cancels its waiting send", async () => {
    const r = await rig();
    const d = await r.draft();
    const sent = await requestSend(r.deps, d.id);
    expect(await deleteDraft(r.deps, d.id)).toBe(true);
    expect((await r.op(sent.id)).state.kind).toBe("cancelled");
  });
});

describe("requestSend", () => {
  it("queues a send for the end of a 10 s undo window, with the thread context", async () => {
    const r = await rig();
    const d = await r.draft();
    const op = await requestSend(r.deps, d.id);
    expect(op).toMatchObject({
      state: { kind: "pending" },
      notBeforeMs: T0 + 10_000,
      draftId: d.id,
      accountId: "acc1",
    });
    expect(op.approval).toMatchObject({ version: 1, fingerprint: d.fingerprint });
    expect(op.approval.threadContext).toBe(messageKey(T0 - 3_600_000, 0));
    expect(op.summary).toBe("Re: Wycena → Anna, secret@example.com");
  });

  it("refuses while recipients are empty or placeholders remain", async () => {
    const r = await rig();
    const noOne = await r.draft({ to: [], bcc: [] });
    await expect(requestSend(r.deps, noOne.id)).rejects.toThrow(SendBlockedError);
    const gap = await r.draft({ bodyMarkdown: "Cena: [cena]" });
    await expect(requestSend(r.deps, gap.id)).rejects.toThrow("Fill in [cena] first.");
    expect(await r.storage.outbox.listByState(["pending"])).toEqual([]);
  });

  it("a second press does not queue a second send; several drafts may wait at once", async () => {
    const r = await rig();
    const a = await r.draft();
    const b = await r.draft({ subject: "Re: Inna sprawa", threadId: undefined });
    const first = await requestSend(r.deps, a.id);
    expect((await requestSend(r.deps, a.id)).id).toBe(first.id);
    const other = await requestSend(r.deps, b.id);
    expect(other.id).not.toBe(first.id);
    expect(await r.storage.outbox.listByState(["pending"])).toHaveLength(2);
  });
});

describe("undo", () => {
  it("within the window nothing is ever sent", async () => {
    const r = await rig();
    const op = await requestSend(r.deps, (await r.draft()).id);
    r.state.now += 4_000;
    expect(await undoSend(r.deps, op.id)).toBe("cancelled");
    r.state.now += 60_000;
    expect(await processOutbox(r.deps, { lane: "small", lateMs: 1e9 })).toEqual([]);
    expect(r.submit.submissions).toHaveLength(0);
    expect((await r.op(op.id)).state.kind).toBe("cancelled");
    // the draft is still there to edit
    expect(await r.storage.drafts.get(op.draftId)).not.toBeNull();
  });

  it("is too late once the hand-off started, unknown for a missing id", async () => {
    const r = await rig();
    const op = await requestSend(r.deps, (await r.draft()).id);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    expect(await undoSend(r.deps, op.id)).toBe("tooLate");
    expect(await undoSend(r.deps, "nope")).toBe("notFound");
  });
});

describe("processOutbox", () => {
  it("sends nothing before the window ends", async () => {
    const r = await rig();
    await requestSend(r.deps, (await r.draft()).id);
    r.state.now += 9_999;
    expect(await processOutbox(r.deps, { lane: "small" })).toEqual([]);
    expect(r.submit.submissions).toHaveLength(0);
  });

  it("hands off exactly one message, appends to Sent, records it in the thread, drops the draft", async () => {
    const r = await rig();
    const d = await r.draft();
    const op = await requestSend(r.deps, d.id);
    r.state.now += 10_000;
    const done = await processOutbox(r.deps, { lane: "small" });

    expect(done).toHaveLength(1);
    expect(r.submit.submissions).toHaveLength(1);
    const sent = r.submit.submissions[0];
    expect(sent?.envelope).toEqual({
      from: "me@example.com",
      recipients: ["anna@northwind.example", "secret@example.com"],
      // The size goes on MAIL FROM, so a server that will refuse the message says so first.
      size: sent?.raw.byteLength,
    });
    // the SMTP login uses the saved password with the outgoing user name
    expect(sent?.target).toMatchObject({
      server: { host: "smtp.example.com" },
      credential: { kind: "password", username: "me", password: PASSWORD },
    });
    expect(r.composer.composed).toBe(1);
    expect(r.connector.sent.appended).toEqual([sent?.raw]);

    const final = await r.op(op.id);
    expect(final.state).toEqual({ kind: "succeeded", providerMessageId: final.messageId });
    expect(final.messageId).toBe("<fake-1@example.test>");
    expect(final.warning).toBeNull();
    expect(final.attempts).toBe(1);
    expect(await r.storage.drafts.get(d.id)).toBeNull();

    const thread = await r.threadMessages();
    expect(thread).toHaveLength(2);
    expect(thread[1]).toMatchObject({
      providerId: "fake-sent-1",
      subject: "Re: Wycena",
      flags: { seen: true },
      labelIds: ["Sent"],
    });
    expect(await r.storage.store.getLocations(thread[1]?.key as number)).toEqual([
      { accountId: "acc1", folderId: "Sent", uidValidity: "1", uid: 1 },
    ]);
  });

  it("reports each state change, starting with running", async () => {
    const r = await rig();
    await requestSend(r.deps, (await r.draft()).id);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    expect(r.state.changes.map((c) => c.state.kind)).toContain("running");
    expect(r.state.changes.at(-1)?.state.kind).toBe("succeeded");
  });

  it("sends nothing when the draft was changed behind the app's back", async () => {
    const r = await rig();
    const d = await r.draft();
    const op = await requestSend(r.deps, d.id);
    // written straight to the store, as a second writer would: the guard at hand-off must hold
    await r.storage.drafts.put({ ...d, version: 2, fingerprint: "0".repeat(64) });
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    expect(r.submit.submissions).toHaveLength(0);
    expect((await r.op(op.id)).state).toEqual({
      kind: "voided",
      reason: "The draft was edited after you pressed Send.",
    });
    expect(r.composer.composed).toBe(0);
  });

  it("sends nothing when a new message arrived in the thread, and says why", async () => {
    const r = await rig();
    const op = await requestSend(r.deps, (await r.draft()).id);
    await ingestDocuments(r.storage, [
      makeDocument(
        { providerId: "p-new", threadId: "t1", dateMs: T0 + 2_000, accountId: "acc1" },
        "Jeszcze jedno",
      ),
    ]);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    expect(r.submit.submissions).toHaveLength(0);
    expect((await r.op(op.id)).state).toEqual({
      kind: "voided",
      reason: "A new message arrived in the thread after you pressed Send.",
    });
  });

  it("the user's own sent message after approval does not void it", async () => {
    const r = await rig();
    const a = await requestSend(r.deps, (await r.draft()).id);
    r.state.now += 1_000;
    const b = await requestSend(r.deps, (await r.draft({ subject: "Re: Wycena 2" })).id);
    r.state.now += 20_000;
    await processOutbox(r.deps, { lane: "small" });
    expect((await r.op(a.id)).state.kind).toBe("succeeded");
    expect((await r.op(b.id)).state.kind).toBe("succeeded");
    expect(r.submit.submissions).toHaveLength(2);
    expect(await r.threadMessages()).toHaveLength(3);
  });

  it("a message from the user's own address that arrives by sync does not void it", async () => {
    const r = await rig();
    const op = await requestSend(r.deps, (await r.draft()).id);
    await ingestDocuments(r.storage, [
      makeDocument(
        {
          providerId: "p-other-client",
          threadId: "t1",
          dateMs: T0 + 2_000,
          accountId: "acc1",
          from: { name: "Miłosz", address: "ME@example.com" },
        },
        "Odpisałem z telefonu",
      ),
    ]);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    expect((await r.op(op.id)).state.kind).toBe("succeeded");
    expect(r.submit.submissions).toHaveLength(1);
  });

  it("a message from someone else after the user's own one still voids it", async () => {
    const r = await rig();
    const first = await requestSend(r.deps, (await r.draft()).id);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    expect((await r.op(first.id)).state.kind).toBe("succeeded");
    const second = await requestSend(r.deps, (await r.draft({ subject: "Re: Wycena 2" })).id);
    await ingestDocuments(r.storage, [
      makeDocument(
        { providerId: "p-new2", threadId: "t1", dateMs: T0 + 20_000, accountId: "acc1" },
        "Jeszcze jedno",
      ),
    ]);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    expect((await r.op(second.id)).state).toMatchObject({ kind: "voided" });
    expect(r.submit.submissions).toHaveLength(1);
  });

  it("sends nothing when the draft is gone", async () => {
    const r = await rig();
    const d = await r.draft();
    const op = await requestSend(r.deps, d.id);
    await r.storage.drafts.delete(d.id);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    expect(r.submit.submissions).toHaveLength(0);
    expect((await r.op(op.id)).state).toMatchObject({ kind: "voided" });
  });

  it("sends several waiting operations in order", async () => {
    const r = await rig();
    const a = await requestSend(
      r.deps,
      (await r.draft({ subject: "Pierwszy", threadId: undefined })).id,
    );
    r.state.now += 1_000;
    const b = await requestSend(
      r.deps,
      (await r.draft({ subject: "Drugi", threadId: undefined })).id,
    );
    r.state.now += 20_000;
    const done = await processOutbox(r.deps, { lane: "small" });
    expect(done.map((o) => o.id)).toEqual([a.id, b.id]);
    expect(r.submit.submissions).toHaveLength(2);
  });

  it("fails an account without an outgoing server, and one without a saved password", async () => {
    const r = await rig();
    await r.storage.accounts.remove("acc1");
    await r.storage.accounts.add({ ...account, smtp: undefined as never, id: "acc1" });
    const d = await r.draft();
    const op = await requestSend(r.deps, d.id);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    expect((await r.op(op.id)).state).toEqual({
      kind: "failed",
      reason: "No outgoing mail server is set up for this account",
    });

    await r.storage.accounts.remove("acc1");
    await r.storage.accounts.add(account);
    await r.credentials.delete("acc1");
    await releaseSend(r.deps, op.id);
    await processOutbox(r.deps, { lane: "small" });
    expect((await r.op(op.id)).state).toEqual({
      kind: "failed",
      reason: "The saved password is missing",
    });
    expect(r.submit.submissions).toHaveLength(0);
  });

  it("an append failure is a warning, not a failure", async () => {
    const r = await rig();
    r.connector.sent.failAppend = new Error("No Sent folder");
    const op = await requestSend(r.deps, (await r.draft()).id);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    const final = await r.op(op.id);
    expect(final.state.kind).toBe("succeeded");
    expect(final.warning).toContain("could not be saved to your Sent folder");
    expect(final.warning).toContain("No Sent folder");
    // still shown in the thread, with a provisional id
    expect((await r.threadMessages())[1]?.providerId).toBe("sent:<fake-1@example.test>");
    expect(r.submit.submissions).toHaveLength(1);
  });

  it("never lets the password into a failure reason", async () => {
    const r = await rig();
    r.submit.script.push({ kind: "rejected", reason: `535 login ${PASSWORD} refused` });
    const op = await requestSend(r.deps, (await r.draft()).id);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    const final = await r.op(op.id);
    expect(final.state).toEqual({ kind: "failed", reason: "535 login *** refused" });
    expect(JSON.stringify(final)).not.toContain(PASSWORD);
  });

  it("holds an operation that is long past its window instead of sending it hours late", async () => {
    const r = await rig();
    const op = await requestSend(r.deps, (await r.draft()).id);
    r.state.now += 3 * 3_600_000;
    await processOutbox(r.deps, { lane: "small" });
    expect(r.submit.submissions).toHaveLength(0);
    expect((await r.op(op.id)).state.kind).toBe("held");
  });
});

describe("failed, then retry", () => {
  it("a 550 fails, a retry sends the same bytes once", async () => {
    const r = await rig();
    r.submit.script.push({ kind: "rejected", reason: "550 5.1.1 No such user", code: 550 });
    const d = await r.draft();
    const op = await requestSend(r.deps, d.id);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });

    expect((await r.op(op.id)).state).toEqual({ kind: "failed", reason: "550 5.1.1 No such user" });
    expect(r.connector.sent.appended).toHaveLength(0);
    expect(await r.threadMessages()).toHaveLength(1);
    expect(await r.storage.drafts.get(d.id)).not.toBeNull();

    // nothing happens by itself
    r.state.now += 60_000;
    await processOutbox(r.deps, { lane: "small" });
    expect(r.submit.submissions).toHaveLength(1);

    expect(await releaseSend(r.deps, op.id)).toBe(true);
    await processOutbox(r.deps, { lane: "small" });
    expect(r.submit.submissions).toHaveLength(2);
    expect(r.submit.submissions[1]?.raw).toEqual(r.submit.submissions[0]?.raw);
    expect(r.composer.composed).toBe(1);
    const final = await r.op(op.id);
    expect(final.state.kind).toBe("succeeded");
    expect(final.attempts).toBe(2);
    expect(r.connector.sent.appended).toHaveLength(1);
    expect(await r.threadMessages()).toHaveLength(2);
  });

  it("a failed retry is checked again: an edit in between sends nothing", async () => {
    const r = await rig();
    r.submit.script.push({ kind: "rejected", reason: "451 try later" });
    const d = await r.draft();
    const op = await requestSend(r.deps, d.id);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    await r.storage.drafts.put({ ...d, version: 2, fingerprint: "1".repeat(64) });
    await releaseSend(r.deps, op.id);
    await processOutbox(r.deps, { lane: "small" });
    expect(r.submit.submissions).toHaveLength(1);
    expect((await r.op(op.id)).state.kind).toBe("voided");
  });

  it("discard cancels a failed send and keeps the draft", async () => {
    const r = await rig();
    r.submit.script.push({ kind: "rejected", reason: "550" });
    const d = await r.draft();
    const op = await requestSend(r.deps, d.id);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    expect(await discardSend(r.deps, op.id)).toBe("cancelled");
    expect(await discardSend(r.deps, op.id)).toBe("tooLate");
    expect(await r.storage.drafts.get(d.id)).not.toBeNull();
  });
});

describe("unknown outcome", () => {
  async function unknownSend(r: Awaited<ReturnType<typeof rig>>) {
    r.submit.script.push({ kind: "unknown", reason: "socket closed after DATA" });
    const d = await r.draft();
    const op = await requestSend(r.deps, d.id);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    return { d, op };
  }

  it("is never resent by itself", async () => {
    const r = await rig();
    const { op } = await unknownSend(r);
    expect((await r.op(op.id)).state.kind).toBe("unknown");
    expect(await releaseSend(r.deps, op.id)).toBe(false);
    r.state.now += 3_600_000;
    await processOutbox(r.deps, { lane: "small" });
    expect(r.submit.submissions).toHaveLength(1);
    // no Sent copy and no thread entry while nobody knows
    expect(r.connector.sent.appended).toHaveLength(0);
    expect(await r.threadMessages()).toHaveLength(1);
  });

  it("'mark as sent' finishes it: the draft goes, the message shows in the thread", async () => {
    const r = await rig();
    const { d, op } = await unknownSend(r);
    expect(await resolveUnknown(r.deps, op.id, "markSent")).toBe(true);
    expect((await r.op(op.id)).state.kind).toBe("succeeded");
    expect(await r.storage.drafts.get(d.id)).toBeNull();
    expect(await r.threadMessages()).toHaveLength(2);
    expect(r.submit.submissions).toHaveLength(1);
    expect(await resolveUnknown(r.deps, op.id, "markSent")).toBe(false);
  });

  it("'send again' sends the very same message once more, at once", async () => {
    const r = await rig();
    const { op } = await unknownSend(r);
    expect(await resolveUnknown(r.deps, op.id, "sendAgain")).toBe(true);
    await processOutbox(r.deps, { lane: "small" });
    expect(r.submit.submissions).toHaveLength(2);
    expect(r.submit.submissions[1]?.raw).toEqual(r.submit.submissions[0]?.raw);
    expect((await r.op(op.id)).state.kind).toBe("succeeded");
  });

  it("a server that does not keep its own copy leaves it to the user", async () => {
    const r = await rig();
    const { op } = await unknownSend(r);
    r.state.now += 3_600_000;
    const report = await reconcileUnknown(r.deps, { graceMs: 1000 });
    expect(report).toEqual({ resolved: 0, leftToUser: 1, waiting: 0 });
    expect(r.connector.sent.searches).toEqual([]);
    expect((await r.op(op.id)).state.kind).toBe("unknown");
  });

  it("Gmail: found by Message-ID means sent; not found waits out the grace period, then fails", async () => {
    const r = await rig({ capabilities: ["savesSent"] });
    const { op } = await unknownSend(r);
    const id = (await r.op(op.id)).messageId as string;

    expect(await reconcileUnknown(r.deps, { graceMs: 60_000 })).toEqual({
      resolved: 0,
      leftToUser: 0,
      waiting: 1,
    });
    expect(r.connector.sent.searches).toEqual([id]);
    expect((await r.op(op.id)).state.kind).toBe("unknown");

    r.state.now += 60_000;
    expect(await reconcileUnknown(r.deps, { graceMs: 60_000 })).toMatchObject({ resolved: 1 });
    expect((await r.op(op.id)).state).toMatchObject({ kind: "failed" });
    expect(r.submit.submissions).toHaveLength(1);

    // the retry works because the provider never had it
    await releaseSend(r.deps, op.id);
    await processOutbox(r.deps, { lane: "small" });
    expect((await r.op(op.id)).state.kind).toBe("succeeded");
  });

  it("Gmail: a copy found by search settles it as sent, with no APPEND", async () => {
    const r = await rig({ capabilities: ["savesSent"] });
    const { d, op } = await unknownSend(r);
    const id = (await r.op(op.id)).messageId as string;
    r.connector.sent.found.set(id, "gm:777");
    expect(await reconcileUnknown(r.deps, { graceMs: 60_000 })).toMatchObject({ resolved: 1 });
    expect((await r.op(op.id)).state).toEqual({ kind: "succeeded", providerMessageId: "gm:777" });
    expect(r.connector.sent.appended).toHaveLength(0);
    expect(await r.storage.drafts.get(d.id)).toBeNull();
    expect((await r.threadMessages())[1]?.providerId).toBe(`sent:${id}`);
  });
});

describe("a server that files sent mail itself (ADR 0092)", () => {
  it("gets no APPEND: its own copy is recorded where it is", async () => {
    const r = await rig();
    r.connector.sent.filesSentItself = true;
    const op = await requestSend(r.deps, (await r.draft()).id);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    const id = (await r.op(op.id)).messageId as string;
    expect(r.connector.sent.appended).toHaveLength(0);
    expect(r.connector.sent.searches).toEqual([id]);
    const [, mine] = await r.threadMessages();
    expect(mine).toMatchObject({ providerId: `filed-${id}`, messageIdHeader: id });
  });

  it("is looked for again while it is filed, then the send appends none", async () => {
    const r = await rig();
    const waits: number[] = [];
    const deps = { ...r.deps, sleep: async (ms: number) => void waits.push(ms) };
    r.connector.sent.filesSentItself = true;
    r.connector.sent.filedAfterLooks = 2;
    await requestSend(deps, (await r.draft()).id);
    r.state.now += 10_000;
    await processOutbox(deps, { lane: "small" });
    expect(r.connector.sent.searches).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
    expect(r.connector.sent.appended).toHaveLength(0);
  });

  it("appends once when no copy turns up", async () => {
    const r = await rig();
    const deps = { ...r.deps, sleep: async () => {} };
    await requestSend(deps, (await r.draft()).id);
    r.state.now += 10_000;
    await processOutbox(deps, { lane: "small" });
    expect(r.connector.sent.searches).toHaveLength(3);
    expect(r.connector.sent.appended).toHaveLength(1);
  });
});

describe("Gmail keeps its own copy", () => {
  it("a successful send gets no APPEND, only a provisional entry that the provider's copy replaces", async () => {
    const r = await rig({ capabilities: ["savesSent"] });
    const op = await requestSend(r.deps, (await r.draft()).id);
    r.state.now += 10_000;
    await processOutbox(r.deps, { lane: "small" });
    expect(r.connector.sent.appended).toHaveLength(0);
    const id = (await r.op(op.id)).messageId as string;
    const [, mine] = await r.threadMessages();
    expect(mine).toMatchObject({ providerId: `sent:${id}`, messageIdHeader: id });

    // the next sync brings Gmail's own copy of the same message
    const theirs = makeDocument(
      {
        providerId: "gm:555",
        threadId: "t1",
        messageIdHeader: id,
        dateMs: T0 + 10_500,
        accountId: "acc1",
      },
      "Dzień dobry, cena: 36 000 PLN.",
    );
    await applySyncBatch(r.storage, {
      accountId: "acc1",
      folderId: "[Gmail]/All Mail",
      batch: makeSyncBatch({ documents: [syncedDoc(theirs, 1, "[Gmail]/All Mail")] }),
      labelSource: "provider",
    });
    const after = await r.threadMessages();
    expect(after).toHaveLength(2);
    expect(after[1]?.providerId).toBe("gm:555");
    expect(await r.storage.bodies.getBodies(after.map((m) => m.key))).toHaveProperty("size", 2);
  });
});

describe("holdExpiredOnStartup", () => {
  it("holds sends whose window ended while the app was closed, keeps open windows, and never sends", async () => {
    const r = await rig();
    const expired = await requestSend(
      r.deps,
      (await r.draft({ threadId: undefined, subject: "A" })).id,
    );
    r.state.now += 5_000;
    const open = await requestSend(
      r.deps,
      (await r.draft({ threadId: undefined, subject: "B" })).id,
    );
    // the app quits; 7 s later it starts again: A's window (10 s) is over, B's has 8 s left
    r.state.now += 7_000;
    expect(await holdExpiredOnStartup(r.deps)).toEqual({ held: 1, interrupted: 0 });
    expect((await r.op(expired.id)).state.kind).toBe("held");
    expect((await r.op(open.id)).state.kind).toBe("pending");

    expect(await processOutbox(r.deps, { lane: "small" })).toEqual([]);
    expect(r.submit.submissions).toHaveLength(0);

    // B's window still counts from its original deadline
    r.state.now += 8_000;
    expect((await processOutbox(r.deps, { lane: "small" })).map((o) => o.id)).toEqual([open.id]);
    expect((await r.op(expired.id)).state.kind).toBe("held");

    // "Send now" on the held one
    expect(await releaseSend(r.deps, expired.id)).toBe(true);
    await processOutbox(r.deps, { lane: "small" });
    expect((await r.op(expired.id)).state.kind).toBe("succeeded");
  });

  it("an operation that was running with its data ended when the app stopped becomes unknown", async () => {
    // ADR 0041, rule 13: past the mark the message may have gone out.
    const r = await rig();
    const op = await requestSend(r.deps, (await r.draft()).id);
    r.state.now += 10_000;
    const running = (await r.storage.outbox.claimNext(r.state.now, "small")) as SendOperation;
    await r.storage.outbox.update(markDataEnded(running));
    expect(await holdExpiredOnStartup(r.deps)).toEqual({ held: 0, interrupted: 1 });
    const after = await r.op(op.id);
    expect(after.state.kind).toBe("unknown");
    expect(after.unknownSinceMs).toBe(r.state.now);
  });

  it("an operation that was running before its data ended was not delivered: it is held", async () => {
    // Before this rule it became unknown. The end-of-data marker was never written, so the
    // server cannot have the message, and the user is asked what to do, not whether it left.
    const r = await rig();
    const op = await requestSend(r.deps, (await r.draft()).id);
    r.state.now += 10_000;
    await r.storage.outbox.claimNext(r.state.now, "small");
    expect(await holdExpiredOnStartup(r.deps)).toEqual({ held: 1, interrupted: 0 });
    const after = await r.op(op.id);
    expect(after.state.kind).toBe("held");
    expect(after.unknownSinceMs).toBeNull();
    // "Send now" sends the same message
    expect(await releaseSend(r.deps, op.id)).toBe(true);
    await processOutbox(r.deps, { lane: "small" });
    expect((await r.op(op.id)).state.kind).toBe("succeeded");
  });
});
