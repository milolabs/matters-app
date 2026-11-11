import { makeDocument, makeLocation, makeMessage, person } from "@matters/testkit";
import { createInMemoryStorage, FakeComposeRenderer } from "@matters/testkit/fakes";
import { describe, expect, it } from "vitest";
import { type BackendDeps, handle } from "../src/backend/handler.ts";
import { generateMailbox, seedIfEmpty } from "../src/backend/seed.ts";
import { imageDeps, noCounts, noSend, noViewWrites } from "./support/noSend.ts";

const SMALL = { messages: 400, threads: 100 };

const noAccounts: BackendDeps["accounts"] = {
  discover: async () => null,
  list: async () => [],
  add: async () => {
    throw new Error("not used");
  },
  remove: async () => false,
  syncNow: async () => false,
  changePassword: async () => null,
};

function emptyDeps() {
  const storage = createInMemoryStorage();
  return {
    ...storage,
    accountStore: storage.accounts,
    renderer: new FakeComposeRenderer(),
    send: noSend,
    savedViews: { list: async () => [], recentSearches: async () => [] },
    viewWrites: noViewWrites,
    counts: noCounts,
    ...imageDeps,
    accounts: noAccounts,
  };
}

async function deps() {
  const d = emptyDeps();
  await seedIfEmpty(d, SMALL);
  return d;
}

describe("seed", () => {
  it("is deterministic and has unique keys", () => {
    const a = generateMailbox({ messages: 400, threads: 100 });
    const b = generateMailbox({ messages: 400, threads: 100 });
    expect(a).toEqual(b);
    expect(new Set(a.map((d) => d.message.key)).size).toBe(400);
    expect(new Set(a.map((d) => d.message.threadId)).size).toBe(100);
  });
});

describe("seedIfEmpty", () => {
  it("seeds an empty store once, with quoted multi-paragraph Polish bodies", async () => {
    const d = createInMemoryStorage();
    expect(await seedIfEmpty(d, SMALL)).toBe(400);
    expect(await seedIfEmpty(d, SMALL)).toBe(0);

    const docs = generateMailbox(SMALL);
    const reply = docs.find((x) => x.message.subject.startsWith("Re:"));
    expect(reply?.bodyText).toMatch(/\n> /);
    expect(reply?.bodyText).toContain("napisał(a):");
    expect(reply?.bodyText.split("\n\n").length).toBeGreaterThan(3);
    const stored = await d.bodies.getBodies(
      (await d.store.listNewest({ limit: 400 })).map((m) => m.key),
    );
    expect(stored.size).toBe(400);
  });
});

describe("handle", () => {
  it("lists newest first and echoes requestId", async () => {
    const r = await handle(await deps(), { type: "listNewest", requestId: "x", limit: 10 });
    expect(r).toMatchObject({ type: "listNewest", requestId: "x", ok: true });
    if (r.type !== "listNewest") throw new Error("unexpected");
    expect(r.messages).toHaveLength(10);
    expect(r.messages[0]?.key).toBeGreaterThan(r.messages[9]?.key ?? 0);
  });

  it("searches with diacritic folding", async () => {
    const r = await handle(await deps(), {
      type: "search",
      requestId: "s",
      query: "zazolc",
      limit: 5,
    });
    expect(r.type).toBe("search");
    if (r.type !== "search") throw new Error("unexpected");
    expect(r.messages.length).toBeGreaterThan(0);
  });

  it("lists the labels of the mailbox (ADR 0026)", async () => {
    const r = await handle(await deps(), { type: "listLabels", requestId: "l" });
    if (r.type !== "listLabels") throw new Error("unexpected");
    expect(r.labels.length).toBeGreaterThan(0);
    expect([...r.labels].sort()).toEqual(r.labels);
    expect(new Set(r.labels).size).toBe(r.labels.length);
    const bad = await handle(await deps(), {
      type: "listLabels",
      requestId: "l",
      extra: 1,
    } as never);
    expect(bad.type).toBe("listLabels");
  });

  it("suggests people, without the user's own addresses (ADR 0028)", async () => {
    const d = emptyDeps();
    await d.accountStore.add({
      id: "a",
      address: "Me@Example.com",
      displayName: "Me",
      imap: { host: "h", port: 993, security: "tls", username: "u" },
      createdAtMs: 1,
    });
    await d.index.indexMessages([
      makeDocument({
        from: person("Jan Kowalski", "jan@lodz.pl"),
        to: [person("Me", "me@example.com")],
      }),
    ]);
    const r = await handle(d, { type: "suggestPeople", requestId: "p", prefix: "Ja", limit: 5 });
    if (r.type !== "suggestPeople") throw new Error("unexpected");
    expect(r.people).toEqual([{ address: "jan@lodz.pl", name: "Jan Kowalski", count: 1 }]);
    const own = await handle(d, { type: "suggestPeople", requestId: "p", prefix: "me", limit: 5 });
    if (own.type !== "suggestPeople") throw new Error("unexpected");
    expect(own.people).toEqual([]);
    for (const bad of [
      { prefix: 1, limit: 5 },
      { prefix: "a" },
      { prefix: "a", limit: 1.5 },
      { prefix: "a".repeat(201), limit: 5 },
    ]) {
      const e = await handle(d, { type: "suggestPeople", requestId: "p", ...bad } as never);
      expect(e).toMatchObject({ type: "error", code: "invalidRequest" });
    }
  });

  it("finds files by name, newest first, and refuses what is not a request (ADR 0074)", async () => {
    const d = emptyDeps();
    for (const [n, name] of [
      [1, "Aneks_651_2026.pdf"],
      [2, "Załącznik 3.docx"],
      [3, "aneks 2.pdf"],
    ] as const) {
      const m = makeMessage({
        dateMs: Date.UTC(2024, 0, n),
        providerId: `f${n}`,
        hasAttachments: true,
      });
      const location = makeLocation(n);
      const { keys } = await d.store.upsertMessages([m]);
      await d.store.addLocations([{ key: keys[0] as number, location }]);
      await d.store.setAttachments([
        {
          location,
          attachments: [
            { partId: "2", name, mimeType: "application/pdf", size: 10, inline: false },
          ],
        },
      ]);
    }
    const ask = async (extra: object) => {
      const r = await handle(d, { type: "searchFiles", requestId: "f", ...extra } as never);
      if (r.type !== "searchFiles") throw new Error(`unexpected ${r.type}`);
      return r.files.map((f) => f.fileName);
    };
    expect(await ask({ text: "ANEKS" })).toEqual(["aneks 2.pdf", "Aneks_651_2026.pdf"]);
    expect(await ask({ text: "zalacznik", limit: 1 })).toEqual(["Załącznik 3.docx"]);
    expect(await ask({ text: "aneks", limit: 1 })).toEqual(["aneks 2.pdf"]);
    expect(await ask({ text: "aneks", accountId: "nobody" })).toEqual([]);
    expect(await ask({ text: "  " })).toEqual([]);
    for (const bad of [{}, { text: 1 }, { text: "a".repeat(201) }, { text: "a", accountId: 1 }]) {
      const e = await handle(d, { type: "searchFiles", requestId: "f", ...bad } as never);
      expect(e).toMatchObject({ type: "error", code: "invalidRequest" });
    }
  });

  describe("search requests (ADR 0025)", () => {
    const ask = async (d: Awaited<ReturnType<typeof deps>>, query: string, extra = {}) => {
      const r = await handle(d, { type: "search", requestId: "s", query, limit: 400, ...extra });
      if (r.type !== "search") throw new Error(`unexpected ${r.type}`);
      return r;
    };

    it("answers the query language: OR, NOT, flags and the unfinished", async () => {
      const d = await deps();
      const plain = await ask(d, "zazolc");
      expect(plain.messages.length).toBeGreaterThan(0);
      const either = await ask(d, "zazolc OR faktura");
      expect(either.messages.length).toBeGreaterThanOrEqual(plain.messages.length);
      const without = await ask(d, "zazolc -zazolc");
      expect(without.messages).toEqual([]);
      const keys = (r: { messages: readonly { key: number }[] }) => r.messages.map((m) => m.key);
      expect(keys(await ask(d, "(zazolc)"))).toEqual(keys(plain));
      // Unfinished terms constrain nothing and ask nothing of the index.
      for (const q of ["from:", "is:un", " -- "]) {
        expect(await ask(d, q)).toEqual({ type: "search", requestId: "s", ok: true, messages: [] });
      }
      const unread = await ask(d, "is:unread");
      for (const m of unread.messages) expect(m.flags.seen).toBe(false);
    });

    it("reads from:me and account: from the stored accounts, and days from the clock", async () => {
      const d = await deps();
      const now = new Date(2030, 0, 15, 12).getTime();
      const dd = { ...d, now: () => now };
      expect((await ask(dd, "from:me")).messages).toEqual([]);
      await d.accountStore.add({
        id: "acc1",
        address: "milosz@example.com",
        displayName: "Miłosz Sobczak",
        imap: { host: "h", port: 993, security: "tls", username: "u" },
        createdAtMs: 1,
      });
      const mine = await ask(dd, "from:me");
      expect(mine.messages.length).toBeGreaterThan(0);
      for (const m of mine.messages) expect(m.from.address).toBe("milosz@example.com");
      expect((await ask(dd, "account:milosz")).messages.length).toBeGreaterThan(0);
      expect((await ask(dd, "account:nobody")).messages).toEqual([]);
      // Everything seeded is older than "yesterday" relative to the injected clock.
      expect((await ask(dd, "after:yesterday")).messages).toEqual([]);
      expect((await ask(dd, "before:today")).messages.length).toBeGreaterThan(0);
    });

    it("pages with the cursor of the index, not by comparing to the limit", async () => {
      const d = await deps();
      const seen: number[] = [];
      let beforeKey: number | undefined;
      for (let i = 0; i < 100; i++) {
        const r = await ask(d, "-zzzzqqq", {
          limit: 70,
          ...(beforeKey === undefined ? {} : { beforeKey }),
        });
        seen.push(...r.messages.map((m) => m.key));
        if (r.nextBeforeKey === undefined) break;
        beforeKey = r.nextBeforeKey;
      }
      expect(seen).toHaveLength(400);
      expect(seen).toEqual([...seen].sort((a, b) => b - a));
    });
  });

  it("opens a thread and reports unknown ones", async () => {
    const d = await deps();
    const ok = await handle(d, { type: "openThread", requestId: "t", threadId: "thread-0" });
    expect(ok.type).toBe("openThread");
    if (ok.type !== "openThread") throw new Error("unexpected");
    const original = generateMailbox(SMALL).filter((x) => x.message.threadId === "thread-0");
    expect(ok.messages.map((m) => m.bodyText)).toEqual(original.map((x) => x.bodyText));
    expect(ok.messages.every((m) => m.bodyText.length > 0)).toBe(true);
    const missing = await handle(d, { type: "openThread", requestId: "t2", threadId: "nope" });
    expect(missing).toMatchObject({ type: "error", code: "notFound", requestId: "t2" });
  });

  it("rejects malformed requests without throwing", async () => {
    const d = await deps();
    expect(await handle(d, null)).toMatchObject({ type: "error", code: "invalidRequest" });
    expect(await handle(d, { type: "search", requestId: "q", query: 1, limit: 5 })).toMatchObject({
      code: "invalidRequest",
      requestId: "q",
    });
  });
});

describe("sending requests", () => {
  const validContent = {
    accountId: "acc1",
    from: { name: "Miłosz", address: "milosz@example.com" },
    to: [{ address: "anna@example.pl" }],
    cc: [],
    bcc: [],
    subject: "Temat",
    bodyMarkdown: "Treść",
    inReplyTo: "",
    references: [],
  };

  it("refuses a draft that is not one, field by field", async () => {
    const d = emptyDeps();
    for (const bad of [
      null,
      "x",
      { ...validContent, to: "anna@example.pl" },
      { ...validContent, subject: 1 },
      { ...validContent, from: { name: "x" } },
      { ...validContent, references: [1] },
      { ...validContent, bodyMarkdown: "x".repeat(2_000_001) },
      { ...validContent, to: Array.from({ length: 501 }, () => ({ address: "a@b.pl" })) },
    ]) {
      expect(await handle(d, { type: "saveDraft", requestId: "r", content: bad })).toMatchObject({
        type: "error",
        code: "invalidRequest",
      });
    }
  });

  it("passes a good draft on, leaving out what it was not given", async () => {
    const seen: unknown[] = [];
    const d = {
      ...emptyDeps(),
      send: {
        ...noSend,
        saveDraft: async (i: unknown) => {
          seen.push(i);
          return { id: "d1" } as never;
        },
      },
    };
    const r = await handle(d, {
      type: "saveDraft",
      requestId: "r",
      content: { ...validContent, extra: "dropped" },
    });
    expect(r).toMatchObject({ type: "saveDraft", ok: true, draft: { id: "d1" } });
    expect(seen).toEqual([{ content: validContent }]);
  });

  it("answers a blocked send with its own code and the reason", async () => {
    const { SendBlockedError } = await import("@matters/core");
    const d = {
      ...emptyDeps(),
      send: {
        ...noSend,
        requestSend: async () => {
          throw new SendBlockedError([{ kind: "noRecipients" }]);
        },
      },
    };
    expect(await handle(d, { type: "requestSend", requestId: "r", draftId: "d1" })).toMatchObject({
      type: "error",
      code: "sendBlocked",
      message: "Add a recipient.",
    });
  });

  it("knows only the send actions it lists", async () => {
    const d = emptyDeps();
    expect(
      await handle(d, { type: "sendAction", requestId: "r", operationId: "o", action: "format" }),
    ).toMatchObject({ code: "invalidRequest" });
    expect(
      await handle(d, { type: "sendAction", requestId: "r", operationId: "o", action: "markSent" }),
    ).toMatchObject({ type: "sendAction", ok: true, done: false });
  });

  it("renders the preview with the renderer it was given", async () => {
    expect(
      await handle(emptyDeps(), { type: "renderPreview", requestId: "r", markdown: "**x**" }),
    ).toEqual({ type: "renderPreview", requestId: "r", ok: true, html: "<p>**x**</p>" });
  });

  it("starts a reply from the thread, with the existing draft when there is one", async () => {
    const storage = createInMemoryStorage();
    await seedIfEmpty(storage, SMALL);
    const d = {
      ...storage,
      accountStore: storage.accounts,
      renderer: new FakeComposeRenderer(),
      send: noSend,
      savedViews: { list: async () => [], recentSearches: async () => [] },
      viewWrites: noViewWrites,
      counts: noCounts,
      ...imageDeps,
      accounts: noAccounts,
    };
    const [latest] = await storage.store.listNewest({ limit: 1 });
    const threadId = (latest as NonNullable<typeof latest>).threadId;
    const ask = (mode: string, id = threadId) =>
      handle(d, { type: "prepareReply", requestId: "r", threadId: id, mode });

    // no account stored: nothing to reply from
    expect(await ask("reply")).toMatchObject({ type: "error", code: "notFound" });

    await storage.accounts.add({
      id: "acc1",
      address: "milosz@example.com",
      displayName: "Miłosz Sobczak",
      imap: { host: "h", port: 993, security: "tls", username: "u" },
      createdAtMs: 1,
    });
    const reply = await ask("reply");
    expect(reply).toMatchObject({ type: "prepareReply", ok: true, existing: null });
    if (reply.type !== "prepareReply") throw new Error("unexpected");
    expect(reply.content.subject).toMatch(/^Re: /);
    expect(reply.content.subject).not.toMatch(/^Re: Re: /i);
    expect(reply.content.threadId).toBe(threadId);
    expect(reply.content.inReplyTo).toMatch(/^<seed-/);
    expect(reply.content.to.map((p) => p.address)).not.toContain("milosz@example.com");
    expect(reply.content.bodyMarkdown).toMatch(/wrote:\n> /);
    expect(reply.content.from).toEqual({ name: "Miłosz Sobczak", address: "milosz@example.com" });

    expect(await ask("replyAll", "no-such-thread")).toMatchObject({ code: "notFound" });
    expect(await ask("forward")).toMatchObject({ code: "invalidRequest" });

    await storage.drafts.put({
      ...reply.content,
      id: "d1",
      version: 1,
      fingerprint: "f".repeat(64),
      updatedAtMs: 1,
    });
    expect(await ask("reply")).toMatchObject({ existing: { id: "d1" } });
  });

  it("starts a new message from the first account, or the one asked for", async () => {
    const storage = createInMemoryStorage();
    const d = {
      ...storage,
      accountStore: storage.accounts,
      renderer: new FakeComposeRenderer(),
      send: noSend,
      savedViews: { list: async () => [], recentSearches: async () => [] },
      viewWrites: noViewWrites,
      counts: noCounts,
      ...imageDeps,
      accounts: noAccounts,
    };
    expect(await handle(d, { type: "prepareNew", requestId: "r" })).toMatchObject({
      code: "notFound",
    });
    for (const [id, address] of [
      ["a", "a@example.com"],
      ["b", "b@example.com"],
    ] as const) {
      await storage.accounts.add({
        id,
        address,
        displayName: address,
        imap: { host: "h", port: 993, security: "tls", username: "u" },
        createdAtMs: id === "a" ? 1 : 2,
      });
    }
    const first = await handle(d, { type: "prepareNew", requestId: "r" });
    const second = await handle(d, { type: "prepareNew", requestId: "r", accountId: "b" });
    expect(first).toMatchObject({ ok: true, content: { accountId: "a", to: [], subject: "" } });
    expect(second).toMatchObject({ ok: true, content: { accountId: "b" } });
  });

  it("lists the sends in progress", async () => {
    const storage = createInMemoryStorage();
    const seen: number[] = [];
    const d = {
      ...storage,
      accountStore: storage.accounts,
      outbox: {
        listVisible: async (since: number) => {
          seen.push(since);
          return [];
        },
      },
      renderer: new FakeComposeRenderer(),
      send: noSend,
      savedViews: { list: async () => [], recentSearches: async () => [] },
      viewWrites: noViewWrites,
      counts: noCounts,
      ...imageDeps,
      accounts: noAccounts,
      now: () => 1_000_000,
    };
    expect(await handle(d, { type: "listOutbox", requestId: "r" })).toMatchObject({
      type: "listOutbox",
      operations: [],
    });
    expect(seen).toEqual([1_000_000 - 60_000]);
  });
});

describe("handle: setSeen (ADR 0039)", () => {
  it("passes the keys and the state to the worker's side and returns what changed", async () => {
    const calls: { keys: readonly number[]; seen: boolean }[] = [];
    const d = {
      ...emptyDeps(),
      seen: {
        setSeen: async (keys: readonly number[], seen: boolean) => {
          calls.push({ keys, seen });
          return { changeSeq: 42, changedKeys: [keys[0] as number] };
        },
      },
    };
    expect(await handle(d, { type: "setSeen", requestId: "r", keys: [3, 4], seen: true })).toEqual({
      type: "setSeen",
      requestId: "r",
      ok: true,
      changeSeq: 42,
      changedKeys: [3],
    });
    expect(calls).toEqual([{ keys: [3, 4], seen: true }]);
  });

  it("refuses keys that are not a short list of numbers, and a state that is not a boolean", async () => {
    const d = emptyDeps();
    const bad = [
      { keys: "1", seen: true },
      { keys: [1, "2"], seen: true },
      { keys: [Number.NaN], seen: true },
      { keys: Array.from({ length: 1001 }, (_, i) => i), seen: true },
      { keys: [1], seen: "yes" },
      { keys: [1] },
    ];
    for (const body of bad) {
      expect(await handle(d, { type: "setSeen", requestId: "r", ...body })).toMatchObject({
        type: "error",
        ok: false,
        code: "invalidRequest",
      });
    }
  });

  it("reports a failure of the write as an error, not a throw", async () => {
    const d = {
      ...emptyDeps(),
      seen: {
        setSeen: async () => {
          throw new Error("worker gone");
        },
      },
    };
    expect(
      await handle(d, { type: "setSeen", requestId: "r", keys: [1], seen: false }),
    ).toMatchObject({ type: "error", code: "internal", message: "worker gone" });
  });
});

describe("handle: moving mail (ADR 0044)", () => {
  const moves = () => {
    const calls: unknown[] = [];
    return {
      calls,
      api: {
        moveThread: async (input: unknown) => {
          calls.push(["move", input]);
          return { operationId: "op1", keys: [3], changeSeq: 12 };
        },
        undoMove: async (id: string) => {
          calls.push(["undo", id]);
          return { kind: "undone" as const, keys: [3], changeSeq: 13 };
        },
        deleteForever: async (keys: readonly number[]) => {
          calls.push(["forever", keys]);
          return { queued: [...keys], removed: [], refused: [] };
        },
      },
    };
  };

  it("passes a move on and answers with what the worker answered", async () => {
    const m = moves();
    const d = { ...emptyDeps(), moves: m.api };
    expect(
      await handle(d, {
        type: "moveThread",
        requestId: "r",
        threadId: "t1",
        action: "move",
        target: { folderId: "Clients" },
        hidden: true,
      }),
    ).toEqual({
      type: "moveThread",
      requestId: "r",
      ok: true,
      operationId: "op1",
      keys: [3],
      changeSeq: 12,
    });
    expect(
      await handle(d, { type: "moveThread", requestId: "r", threadId: "t", action: "archive" }),
    ).toMatchObject({ ok: true });
    expect(m.calls).toEqual([
      ["move", { threadId: "t1", action: "move", target: { folderId: "Clients" }, hidden: true }],
      ["move", { threadId: "t", action: "archive" }],
    ]);
  });

  it("takes a move back, and deletes for good the keys it is given", async () => {
    const m = moves();
    const d = { ...emptyDeps(), moves: m.api };
    expect(await handle(d, { type: "undoMove", requestId: "r", operationId: "op1" })).toEqual({
      type: "undoMove",
      requestId: "r",
      ok: true,
      result: { kind: "undone", keys: [3], changeSeq: 13 },
    });
    expect(
      await handle(d, { type: "deleteForever", requestId: "r", keys: [1745141760000000] }),
    ).toMatchObject({ type: "deleteForever", ok: true, queued: [1745141760000000] });
  });

  it("refuses requests that are not what they say", async () => {
    const d = { ...emptyDeps(), moves: moves().api };
    const bad = [
      { type: "moveThread", threadId: 1, action: "archive" },
      { type: "moveThread", threadId: "t", action: "obliterate" },
      { type: "moveThread", threadId: "t", action: "move" },
      { type: "moveThread", threadId: "t", action: "move", target: { role: "sent" } },
      { type: "moveThread", threadId: "t", action: "move", target: { folderId: "" } },
      { type: "moveThread", threadId: "t", action: "archive", hidden: "yes" },
      { type: "undoMove", operationId: 5 },
      { type: "undoMove", operationId: "x".repeat(101) },
      { type: "deleteForever", keys: "1" },
      { type: "deleteForever", keys: [1.5] },
      { type: "deleteForever", keys: Array.from({ length: 1001 }, (_, i) => i) },
      { type: "openThread", threadId: "t", hidden: "yes" },
    ];
    for (const body of bad) {
      expect(await handle(d, { requestId: "r", ...body })).toMatchObject({
        type: "error",
        ok: false,
        code: "invalidRequest",
      });
    }
  });

  it("lists the folders sync stored, and opens a thread without deleted mail unless asked for it whole", async () => {
    const d = await deps();
    await d.store.setFolders("acc1", [
      { id: "INBOX", accountId: "acc1", name: "INBOX", role: "inbox", exclusive: true },
    ]);
    const folders = await handle(d, { type: "listFolders", requestId: "r" });
    expect(folders).toMatchObject({ type: "listFolders", ok: true });
    if (folders.type !== "listFolders") throw new Error("unexpected");
    expect(folders.folders.map((f) => f.id)).toEqual(["INBOX"]);

    const seen: (boolean | undefined)[] = [];
    const real = d.store.getThread.bind(d.store);
    d.store.getThread = (id, options) => {
      seen.push(options?.visibleOnly);
      return real(id, options);
    };
    const [first] = await d.store.listNewest({ limit: 1 });
    const threadId = (first as NonNullable<typeof first>).threadId;
    await handle(d, { type: "openThread", requestId: "r", threadId });
    await handle(d, { type: "openThread", requestId: "r", threadId, hidden: true });
    expect(seen).toEqual([true, false]);
  });
});
