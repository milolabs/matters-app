// The page's side of the person's signature (ADR 0142): a new message filled in by the agent gets
// it from the code, and it follows a new sender only while it is exactly the one put in (rule 5).
import type { BackendEvent } from "@matters/contracts";
import type { Draft, DraftContent } from "@matters/core";
import { emptyDraftContent, placeSignature } from "@matters/core";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { Backend } from "../src/renderer/client.ts";
import { createComposerSession, createComposeStore } from "../src/renderer/compose.ts";
import { createOutboxStore } from "../src/renderer/outbox.ts";

vi.mock("../src/renderer/files.ts", () => ({
  pickFiles: async () => [],
  pasteImage: async () => null,
  onDropped: () => () => {},
}));

const work = { id: "a1", address: "me@work.example", displayName: "Me" };
const home = { id: "a2", address: "me@home.example", displayName: "Me" };
const SIGNATURES: Record<string, string> = { a1: "Me\nWork Ltd", a2: "Me, at home" };

function fakeBackend() {
  const saved: DraftContent[] = [];
  const backend = {
    onEvent: (_l: (e: BackendEvent) => void) => () => {},
    listOutbox: async () => [],
    async saveDraft(args: { id?: string; content: DraftContent }): Promise<Draft> {
      saved.push(args.content);
      return { ...args.content, id: "d1", version: 1, fingerprint: "f", updatedAtMs: 0 };
    },
    async renderPreview() {
      return "";
    },
    listAttachments: async () => [],
    checkAttachmentSources: async () => [],
    prepareNew: vi.fn(async (accountId?: string) => {
      const account = accountId === "a2" ? home : work;
      const signature = SIGNATURES[account.id] ?? "";
      const content = emptyDraftContent(account);
      return {
        type: "prepareNew",
        ok: true,
        content: { ...content, bodyMarkdown: placeSignature("", signature) },
        signature,
        existing: null,
        redirect: null,
        messageLimitBytes: null,
      };
    }),
  };
  return { backend: backend as unknown as Backend, saved };
}

function newMessage(fake = fakeBackend(), over: Partial<DraftContent> = {}) {
  const outbox = createRoot(() => createOutboxStore(fake.backend));
  const signature = SIGNATURES.a1 ?? "";
  const session = createRoot(() =>
    createComposerSession(
      fake.backend,
      outbox,
      {
        title: "New message",
        content: {
          ...emptyDraftContent(work),
          bodyMarkdown: placeSignature("", signature),
          ...over,
        },
        existing: null,
        signature,
      },
      () => {},
    ),
  );
  return { ...fake, session };
}

describe("the signature follows the sender while untouched (rule 5)", () => {
  it("takes the new account's signature, and saves nothing: choosing is not writing", async () => {
    const t = newMessage();
    expect(t.session.body()).toBe("\n\n-- \nMe\nWork Ltd");
    const text = await t.session.setSender(home);
    expect(text).toBe("\n\n-- \nMe, at home");
    expect(t.session.body()).toBe(text);
    expect(t.saved).toEqual([]);
    // And back again.
    expect(await t.session.setSender(work)).toBe("\n\n-- \nMe\nWork Ltd");
  });

  it("keeps the words the person wrote above it", async () => {
    const t = newMessage();
    t.session.setBody(`Hello Anna,${t.session.body()}`);
    expect(await t.session.setSender(home)).toBe("Hello Anna,\n\n-- \nMe, at home");
  });

  it("leaves a signature the person changed alone, then and after", async () => {
    const t = newMessage();
    const edited = "Hello\n\n-- \nMe\nWork Ltd, sales";
    t.session.setBody(edited);
    expect(await t.session.setSender(home)).toBeNull();
    expect(t.session.body()).toBe(edited);
    expect(await t.session.setSender(work)).toBeNull();
    expect(t.session.body()).toBe(edited);
  });

  it("leaves a deleted signature deleted", async () => {
    const t = newMessage();
    t.session.setBody("Only words");
    expect(await t.session.setSender(home)).toBeNull();
    expect(t.session.body()).toBe("Only words");
  });
});

describe("send and close wait for the new sender's signature (rule 5)", () => {
  /** A backend whose next `prepareNew` waits until `release`. */
  function slowBackend() {
    const fake = fakeBackend();
    const backend = fake.backend as unknown as Record<string, unknown>;
    const prepare = backend.prepareNew as (id?: string) => Promise<unknown>;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    backend.prepareNew = async (id?: string) => {
      await gate;
      return prepare(id);
    };
    const sent: string[] = [];
    backend.requestSend = async (id: string) => {
      sent.push(id);
      return { id: "op1" };
    };
    return { ...fake, release, sent };
  }

  for (const how of ["send", "close"] as const) {
    it(`${how} while the new sender is being prepared saves it with its own signature`, async () => {
      const fake = slowBackend();
      const t = newMessage(fake, { to: [{ address: "anna@example.org" }], subject: "Tuesday" });
      t.session.setBody(`Hello Anna,${t.session.body()}`);
      const following = t.session.setSender(home);
      const done = how === "send" ? t.session.send() : t.session.close();
      fake.release();
      await following;
      await done;
      const last = t.saved.at(-1);
      expect(last?.accountId).toBe("a2");
      expect(last?.bodyMarkdown).toBe("Hello Anna,\n\n-- \nMe, at home");
      if (how === "send") expect(fake.sent).toEqual(["d1"]);
    });
  }
});

describe("a new message the agent offered (rule 6)", () => {
  it("opens with the agent's words and the signature the code put under them", async () => {
    const fake = fakeBackend();
    const outbox = createRoot(() => createOutboxStore(fake.backend));
    const store = createRoot(() => createComposeStore(fake.backend, outbox));
    await store.open("new", "a1", undefined, undefined, {
      to: ["anna@example.com"],
      subject: "Review",
      body: "Hello Anna,\n\nthe review is on [date].",
    });
    expect(store.session()?.body()).toBe(
      "Hello Anna,\n\nthe review is on [date].\n\n-- \nMe\nWork Ltd",
    );
    // Not saved by itself (ADR 0102).
    expect(fake.saved).toEqual([]);
  });
});
