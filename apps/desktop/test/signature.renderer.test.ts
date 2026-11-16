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

function newMessage(fake = fakeBackend()) {
  const outbox = createRoot(() => createOutboxStore(fake.backend));
  const signature = SIGNATURES.a1 ?? "";
  const session = createRoot(() =>
    createComposerSession(
      fake.backend,
      outbox,
      {
        title: "New message",
        content: { ...emptyDraftContent(work), bodyMarkdown: placeSignature("", signature) },
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
