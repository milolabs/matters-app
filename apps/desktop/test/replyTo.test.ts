import { makeMessage } from "@matters/testkit";
import { createInMemoryStorage, FakeComposeRenderer } from "@matters/testkit/fakes";
import { describe, expect, it, vi } from "vitest";
import { type BackendDeps, handle } from "../src/backend/handler.ts";
import { imageDemoMail } from "../src/backend/seed.ts";
import { createComposerSession } from "../src/renderer/compose.ts";
import { replyNotice, UNVERIFIED_WARNING } from "../src/renderer/replyNotice.ts";
import { replyPromptName } from "../src/renderer/replyPrompt.ts";
import { imageDeps, noCounts, noSend, noViewWrites } from "./support/noSend.ts";

const shop = { name: "Sklep", address: "orders@mailer.example" };
const help = { name: "Pomoc", address: "help@shop.example" };
const redirect = { to: [help], from: shop, unverified: false };

describe("replyNotice (ADR 0042, rule 5)", () => {
  it("is no line at all when the reply goes where it always did", () => {
    expect(replyNotice(null)).toBeNull();
    expect(replyNotice(undefined)).toBeNull();
    expect(replyNotice({ ...redirect, to: [] })).toBeNull();
  });

  it("says who the reply goes to and where the message came from, as plain addresses", () => {
    const notice = replyNotice(redirect);
    expect(notice).toMatchObject({
      to: "help@shop.example",
      warning: null,
      text: "Replies go to help@shop.example, as the sender asked. Sent from orders@mailer.example.",
    });
  });

  it("names every address the reply goes to", () => {
    const notice = replyNotice({ ...redirect, to: [help, { address: "billing@shop.example" }] });
    expect(notice?.to).toBe("help@shop.example, billing@shop.example");
  });

  it("adds the warning when the sender could not be verified", () => {
    const notice = replyNotice({ ...redirect, unverified: true });
    expect(notice?.warning).toBe(UNVERIFIED_WARNING);
    expect(notice?.warning).toBe(
      "The sender could not be verified. Check this address before replying.",
    );
    expect(notice?.text.endsWith(UNVERIFIED_WARNING)).toBe(true);
  });

  it("keeps markup in an address as the text it is", () => {
    const hostile = { address: '"><img src=x onerror=alert(1)>@evil.example' };
    const notice = replyNotice({ ...redirect, to: [hostile], from: hostile });
    expect(notice?.to).toBe(hostile.address);
    expect(notice?.text).toContain(hostile.address);
  });
});

describe("replyPromptName (ADR 0042, rule 6)", () => {
  const own = new Set(["me@example.com"]);
  const theirs = makeMessage({ from: shop, replyTo: [help] });

  it("names who the reply goes to, not who sent the message", () => {
    expect(replyPromptName([theirs], own)).toBe("Pomoc");
  });

  it("names the sender when nobody else was asked", () => {
    expect(replyPromptName([{ ...theirs, replyTo: [] }], own)).toBe("Sklep");
    expect(replyPromptName([makeMessage({ from: { address: "x@y.pl" } })], own)).toBe("x@y.pl");
  });

  it("answers the newest message that is not the user's own", () => {
    const mine = makeMessage({ from: { address: "ME@example.com" }, to: [shop], replyTo: [] });
    expect(replyPromptName([theirs, mine], own)).toBe("Pomoc");
  });

  it("calls a thread of one's own mail, with nobody to name, this thread", () => {
    const mine = makeMessage({ from: { address: "me@example.com" }, to: [], replyTo: [] });
    expect(replyPromptName([mine], own)).toBe("this thread");
    expect(replyPromptName([], own)).toBe("this thread");
  });
});

describe("the demo mail (ADR 0042)", () => {
  const demo = imageDemoMail().map((d) => d.message);

  it("has a message whose Reply-To differs from From, and one that fails verification too", () => {
    const differs = (m: (typeof demo)[number]) =>
      (m.replyTo ?? []).some((p) => p.address !== m.from.address);
    expect(demo.some((m) => differs(m) && m.senderAuth !== "fail")).toBe(true);
    expect(demo.some((m) => differs(m) && m.senderAuth === "fail")).toBe(true);
  });
});

describe("prepareReply (ADR 0042)", () => {
  async function start(message: Parameters<typeof makeMessage>[0]) {
    const storage = createInMemoryStorage();
    const m = makeMessage({ threadId: "t1", to: [{ address: "me@example.com" }], ...message });
    await storage.store.upsertMessages([m]);
    await storage.accounts.add({
      id: "acc1",
      address: "me@example.com",
      displayName: "Me",
      imap: { host: "h", port: 993, security: "tls", username: "u" },
      createdAtMs: 1,
    });
    const deps = {
      ...storage,
      accountStore: storage.accounts,
      renderer: new FakeComposeRenderer(),
      send: noSend,
      savedViews: { list: async () => [], recentSearches: async () => [] },
      viewWrites: noViewWrites,
      counts: noCounts,
      ...imageDeps,
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
    } satisfies BackendDeps;
    const ask = () =>
      handle(deps, { type: "prepareReply", requestId: "r", threadId: "t1", mode: "reply" });
    return { storage, ask };
  }

  it("addresses the reply to Reply-To and carries what the line needs", async () => {
    const { ask } = await start({ from: shop, replyTo: [help], senderAuth: "fail" });
    const r = await ask();
    if (r.type !== "prepareReply") throw new Error("unexpected");
    expect(r.content.to).toEqual([help]);
    expect(r.redirect).toEqual({ to: [help], from: shop, unverified: true });
  });

  it("carries no line when the reply goes to the sender", async () => {
    for (const replyTo of [undefined, []]) {
      const { ask } = await start({ from: shop, ...(replyTo ? { replyTo } : {}) });
      const r = await ask();
      if (r.type !== "prepareReply") throw new Error("unexpected");
      expect(r.content.to).toEqual([shop]);
      expect(r.redirect).toBeNull();
    }
  });

  it("carries no line for a draft that exists: it keeps its recipients", async () => {
    const { storage, ask } = await start({ from: shop, replyTo: [help] });
    const first = await ask();
    if (first.type !== "prepareReply") throw new Error("unexpected");
    await storage.drafts.put({
      ...first.content,
      id: "d1",
      version: 1,
      fingerprint: "f".repeat(64),
      updatedAtMs: 1,
    });
    const again = await ask();
    if (again.type !== "prepareReply") throw new Error("unexpected");
    expect(again.existing?.id).toBe("d1");
    expect(again.redirect).toBeNull();
  });
});

describe("the composer session (ADR 0042)", () => {
  const backend = {
    onEvent: () => () => {},
    getDraft: vi.fn(),
    saveDraft: vi.fn(),
    renderPreview: vi.fn(async () => ""),
    listAttachments: vi.fn(async () => []),
  };
  const base = {
    accountId: "acc1",
    from: { address: "me@example.com" },
    to: [help],
    cc: [],
    bcc: [],
    subject: "Re: x",
    bodyMarkdown: "",
    inReplyTo: "<m@x>",
    references: [],
  };
  const make = (input: Partial<Parameters<typeof createComposerSession>[2]>) =>
    createComposerSession(
      backend as never,
      { subscribe: () => () => {}, operations: () => [] } as never,
      { title: "Reply", content: base, existing: null, ...input },
      () => {},
    );

  it("holds the redirect of a new reply, and none for a draft that exists or a plain one", () => {
    const withLine = make({ redirect });
    expect(withLine.redirect).toEqual(redirect);
    expect(withLine.to()).toBe("Pomoc <help@shop.example>");
    withLine.dispose();

    const plain = make({});
    expect(plain.redirect).toBeNull();
    plain.dispose();

    // The backend sends none for an existing draft; the session does not show one either.
    const draft = { ...base, id: "d1", version: 1, fingerprint: "f", updatedAtMs: 1 };
    const kept = make({ redirect, existing: draft as never });
    expect(kept.redirect).toBeNull();
    kept.dispose();
  });
});
