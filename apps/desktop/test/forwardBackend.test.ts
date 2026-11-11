// The requests of a forward as the backend answers them (ADR 0045).
import { makeMessage } from "@matters/testkit";
import { createInMemoryStorage, FakeComposeRenderer } from "@matters/testkit/fakes";
import { describe, expect, it, vi } from "vitest";
import { toAttachmentInfo } from "../src/backend/attachmentInfo.ts";
import { DEMO_MESSAGES, FIRST_FILE_PART } from "../src/backend/demoMail.ts";
import { type BackendDeps, handle } from "../src/backend/handler.ts";
import { attachmentDemoMail } from "../src/backend/seed.ts";
import { imageDeps, noCounts, noSend, noViewWrites } from "./support/noSend.ts";

const T = 1_800_000_000_000;

async function start() {
  const storage = createInMemoryStorage();
  await storage.accounts.add({
    id: "acc1",
    address: "me@example.com",
    displayName: "Me",
    imap: { host: "h", port: 993, security: "tls", username: "u" },
    smtp: { host: "s", port: 587, security: "starttls", username: "u" },
    createdAtMs: 1,
    messageLimitBytes: 25_000_000,
  });
  const addForwarded = vi.fn(async () => []);
  const saveDraft = vi.fn(async (_input: unknown) => ({}) as never);
  const deps = {
    ...storage,
    accountStore: storage.accounts,
    renderer: new FakeComposeRenderer(),
    send: { ...noSend, saveDraft },
    savedViews: { list: async () => [], recentSearches: async () => [] },
    viewWrites: noViewWrites,
    counts: noCounts,
    ...imageDeps,
    attachmentWrites: {
      add: async () => [],
      addForwarded,
      check: async () => [],
      recapture: async () => null,
    },
    accounts: {
      discover: async () => null,
      list: async () => [],
      add: async () => {
        throw new Error("not used");
      },
      remove: async () => false,
      syncNow: async () => false,
      changePassword: async () => null,
    },
  } as unknown as BackendDeps;
  async function message(over: Parameters<typeof makeMessage>[0]) {
    const m = makeMessage({ threadId: "t1", to: [{ address: "me@example.com" }], ...over });
    await storage.store.upsertMessages([m]);
    await storage.bodies.putBodies([
      { key: m.key, threadId: m.threadId, text: `body ${m.providerId}` },
    ]);
    return m;
  }
  const ask = (hidden?: boolean) =>
    handle(deps, {
      type: "prepareForward",
      requestId: "r",
      threadId: "t1",
      ...(hidden === undefined ? {} : { hidden }),
    });
  const raw = (request: unknown) => handle(deps, request);
  return { storage, message, ask, raw, addForwarded, saveDraft };
}

describe("prepareForward", () => {
  it("answers the draft of a forward, the message it quotes, and the account's limit", async () => {
    const t = await start();
    const first = await t.message({ providerId: "m1", dateMs: T, subject: "Budget" });
    const second = await t.message({ providerId: "m2", dateMs: T + 1000, subject: "Re: Budget" });
    const r = await t.ask();
    if (r.type !== "prepareForward") throw new Error(`unexpected ${JSON.stringify(r)}`);
    expect(r.forwardedKey).toBe(second.key);
    expect(first.key).not.toBe(second.key);
    expect(r.content).toMatchObject({
      to: [],
      subject: "Fwd: Re: Budget",
      inReplyTo: "",
      references: [],
      forwarded: true,
    });
    expect(r.content.threadId).toBeUndefined();
    expect(r.existing).toBeNull();
    expect(r.redirect).toBeNull();
    expect(r.messageLimitBytes).toBe(25_000_000);
  });

  it("leaves out what is in Trash or Spam, unless the thread is looked at from there", async () => {
    const t = await start();
    const kept = await t.message({ providerId: "m1", dateMs: T, subject: "Kept" });
    const deleted = await t.message({
      providerId: "m2",
      dateMs: T + 1000,
      subject: "Deleted",
      labelIds: ["trash"],
    });
    const plain = await t.ask();
    const hidden = await t.ask(true);
    if (plain.type !== "prepareForward" || hidden.type !== "prepareForward") throw new Error("?");
    expect(plain.forwardedKey).toBe(kept.key);
    expect(plain.content.subject).toBe("Fwd: Kept");
    expect(hidden.forwardedKey).toBe(deleted.key);
    expect(hidden.content.subject).toBe("Fwd: Deleted");
  });

  it("is not found for a thread with nothing to forward", async () => {
    const t = await start();
    expect(await t.ask()).toMatchObject({ ok: false, code: "notFound" });
    await t.message({ providerId: "m1", labelIds: ["spam"] });
    expect(await t.ask()).toMatchObject({ ok: false, code: "notFound" });
  });

  it("refuses a request that is not one", async () => {
    const t = await start();
    expect(await t.raw({ type: "prepareForward", requestId: "r" })).toMatchObject({
      ok: false,
      code: "invalidRequest",
    });
    expect(
      await t.raw({ type: "prepareForward", requestId: "r", threadId: "t1", hidden: "yes" }),
    ).toMatchObject({ ok: false, code: "invalidRequest" });
  });
});

describe("addForwardedAttachments", () => {
  const request = (files: unknown) => ({
    type: "addForwardedAttachments",
    requestId: "r",
    draftId: "d1",
    files,
  });

  it("passes names in the cache on, and nothing else", async () => {
    const t = await start();
    const r = await t.raw(
      request([{ id: "chip-1", messageKey: 123, partId: "2.1", path: "/etc/passwd", name: "x" }]),
    );
    expect(r).toMatchObject({ type: "addForwardedAttachments", ok: true });
    expect(t.addForwarded).toHaveBeenCalledWith("d1", [
      { id: "chip-1", messageKey: 123, partId: "2.1" },
    ]);
  });

  it.each([
    [[]],
    [[{ id: "a", messageKey: 0, partId: "2" }]],
    [[{ id: "a", messageKey: 1.5, partId: "2" }]],
    [[{ id: "a", messageKey: 1, partId: "../../etc" }]],
    [[{ id: "a", messageKey: 1, partId: "" }]],
    [[{ id: "bad id", messageKey: 1, partId: "2" }]],
    [[{ id: "a", messageKey: "1", partId: "2" }]],
    [[null]],
    ["files"],
  ])("refuses %j", async (files) => {
    const t = await start();
    expect(await t.raw(request(files))).toMatchObject({ ok: false, code: "invalidRequest" });
    expect(t.addForwarded).not.toHaveBeenCalled();
  });

  it("refuses a draft id that is not text", async () => {
    const t = await start();
    expect(
      await t.raw({ ...request([{ id: "a", messageKey: 1, partId: "2" }]), draftId: 4 }),
    ).toMatchObject({ ok: false, code: "invalidRequest" });
  });
});

describe("saving a forward", () => {
  const content = {
    accountId: "acc1",
    from: { address: "me@example.com" },
    to: [],
    cc: [],
    bcc: [],
    subject: "Fwd: x",
    bodyMarkdown: "",
    inReplyTo: "",
    references: [],
  };
  const save = async (extra: object) => {
    const t = await start();
    await t.raw({ type: "saveDraft", requestId: "r", content: { ...content, ...extra } });
    return t.saveDraft.mock.calls[0]?.[0];
  };

  it("keeps the flag that titles it", async () => {
    expect(await save({ forwarded: true })).toEqual({ content: { ...content, forwarded: true } });
  });

  it("drops what is not a draft's, and a flag that is not true", async () => {
    expect(await save({ forwarded: true, evil: 1 })).toEqual({
      content: { ...content, forwarded: true },
    });
    expect(await save({ forwarded: "yes" })).toEqual({ content });
    expect(await save({ forwarded: false })).toEqual({ content });
    expect(await save({})).toEqual({ content });
  });
});

describe("the files of an opened thread (rules 11 and 12)", () => {
  it("say whether the message has parts inside its body", async () => {
    const storage = createInMemoryStorage();
    const m = makeMessage({ threadId: "t1", providerId: "m1", hasAttachments: true });
    await storage.store.upsertMessages([m]);
    await storage.store.setAttachments([]);
    const view = await storage.store.getThread("t1");
    expect(view?.attachments.get(m.key)).toEqual({ known: false, items: [], hasInline: false });
  });
});

describe("what AttachmentInfo tells the page", () => {
  const row = (over: object) =>
    toAttachmentInfo({
      id: "a",
      draftId: "d",
      accountId: "acc1",
      name: "n.pdf",
      size: 1,
      state: "failed",
      reason: "Couldn’t download",
      sha256: null,
      sourcePath: null,
      sourceMtimeMs: null,
      origin: { messageKey: 1, partId: "2" },
      createdAtMs: 0,
      ...over,
    });

  it("a forwarded file says so, and a download that failed can be tried again", () => {
    expect(row({})).toMatchObject({ forwarded: true, canRetry: true });
  });

  it("a message that left the server cannot be tried again", () => {
    expect(row({ reason: "No longer on the server" })).toMatchObject({ canRetry: false });
  });

  it("an ordinary file is not forwarded, and a path never travels", () => {
    const info = row({ origin: null, sourcePath: "/Users/me/secret.pdf", sha256: "abc" });
    expect(info.forwarded).toBe(false);
    expect(JSON.stringify(info)).not.toMatch(/secret|abc|origin|messageKey/);
  });
});

describe("the demo mail for forwarding", () => {
  const withFiles = DEMO_MESSAGES.filter((m) => m.files.length >= 3);

  it("has a message with several files, one that fails offline and one that is gone", () => {
    const m = DEMO_MESSAGES.find((x) => x.files.some((f) => f.behaviour === "offlineOnce"));
    expect(m?.files.length).toBeGreaterThanOrEqual(3);
    expect(m?.files.some((f) => f.behaviour === "gone")).toBe(true);
    expect(withFiles.length).toBeGreaterThan(1);
  });

  it("has one with a designed layout and files, and a file over what a typical server takes", () => {
    const designed = attachmentDemoMail().filter((d) => d.htmlKind === "designed");
    expect(designed.length).toBeGreaterThan(0);
    expect(designed.every((d) => d.message.hasAttachments)).toBe(true);
    const big = DEMO_MESSAGES.flatMap((m) => m.files).find((f) => f.size > 25_000_000);
    expect(big?.name).toBe("Projekt makiet.zip");
    expect(FIRST_FILE_PART).toBe(2);
  });
});
