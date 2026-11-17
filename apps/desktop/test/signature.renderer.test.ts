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

  it("follows the sender with a blockquote of the person's above it", async () => {
    const t = newMessage();
    const mine = "As agreed:\n\n> Paid in 14 days.\n\n```\n> not a quote\n```";
    t.session.setBody(`${mine}${t.session.body()}`);
    expect(await t.session.setSender(home)).toBe(`${mine}\n\n-- \nMe, at home`);
    expect(await t.session.setSender(work)).toBe(`${mine}\n\n-- \nMe\nWork Ltd`);
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

describe("the sender and its signature change together (rule 5)", () => {
  /** A backend that can be told to fail the next preparation of a sender, and that sends. */
  function failingBackend() {
    const fake = fakeBackend();
    const backend = fake.backend as unknown as Record<string, unknown>;
    const prepare = backend.prepareNew as (id?: string) => Promise<unknown>;
    const state = { fail: false };
    backend.prepareNew = vi.fn(async (id?: string) => {
      if (state.fail) throw new Error("offline");
      return prepare(id);
    });
    const sent: string[] = [];
    backend.requestSend = async (id: string) => {
      sent.push(id);
      return { id: "op1" };
    };
    return { ...fake, state, sent, prepareNew: backend.prepareNew as ReturnType<typeof vi.fn> };
  }

  it("a sender whose preparation fails is not taken, says so, and is tried again when chosen again", async () => {
    const fake = failingBackend();
    const t = newMessage(fake, { to: [{ address: "anna@example.org" }], subject: "Tuesday" });
    fake.state.fail = true;
    expect(await t.session.setSender(home)).toBeNull();
    expect(t.session.sender().accountId).toBe("a1");
    expect(t.session.body()).toBe("\n\n-- \nMe\nWork Ltd");
    expect(t.session.error()).toContain(home.address);
    // Chosen again, it is asked for again; this time it comes, and the line goes.
    fake.state.fail = false;
    expect(await t.session.setSender(home)).toBe("\n\n-- \nMe, at home");
    expect(t.session.sender().accountId).toBe("a2");
    expect(t.session.error()).toBe("");
    expect(fake.prepareNew).toHaveBeenCalledTimes(2);
  });

  it("Send stops when the sender it waited for could not be prepared, and sends no mismatched pair", async () => {
    const fake = failingBackend();
    const t = newMessage(fake, { to: [{ address: "anna@example.org" }], subject: "Tuesday" });
    fake.state.fail = true;
    const following = t.session.setSender(home);
    expect(await t.session.send()).toBeNull();
    await following;
    expect(fake.sent).toEqual([]);
    expect(t.session.sender().accountId).toBe("a1");
    expect(t.session.error()).toContain(home.address);
    // Nothing saved went from the new sender with the old signature.
    expect(t.saved.every((c) => c.accountId === "a1")).toBe(true);
    expect(t.session.senderLocked()).toBe(false);
  });

  it("after a sender that could not be prepared, the next Send goes from the sender shown, and the line stays until then", async () => {
    const fake = failingBackend();
    const t = newMessage(fake, { to: [{ address: "anna@example.org" }], subject: "Tuesday" });
    t.session.setBody(`Hello Anna,${t.session.body()}`);
    fake.state.fail = true;
    expect(await t.session.setSender(home)).toBeNull();
    // A saved draft does not take the line away: the choice still failed.
    await t.session.flush();
    expect(t.saved.length).toBeGreaterThan(0);
    expect(t.session.error()).toContain(home.address);
    // The composer is as it was before the choice: Send goes, from the sender and signature shown.
    expect(await t.session.send()).not.toBeNull();
    expect(fake.sent).toEqual(["d1"]);
    const last = t.saved.at(-1);
    expect(last?.accountId).toBe("a1");
    expect(last?.bodyMarkdown).toBe("Hello Anna,\n\n-- \nMe\nWork Ltd");
    expect(t.session.error()).toBe("");
  });

  it("a sender removed before its answer came is not taken with another account's signature", async () => {
    const fake = failingBackend();
    const t = newMessage(fake, { to: [{ address: "anna@example.org" }], subject: "Tuesday" });
    t.session.setBody(`Hello Anna,${t.session.body()}`);
    // The backend falls back to the first account left when the one asked for is gone.
    const gone = { id: "a3", address: "me@gone.example", displayName: "Me" };
    expect(await t.session.setSender(gone)).toBeNull();
    expect(fake.prepareNew).toHaveBeenCalledWith("a3");
    expect(t.session.sender().accountId).toBe("a1");
    expect(t.session.body()).toBe("Hello Anna,\n\n-- \nMe\nWork Ltd");
    expect(t.session.error()).toContain(gone.address);
    // Send goes from the sender shown, with its own signature.
    expect(await t.session.send()).not.toBeNull();
    const last = t.saved.at(-1);
    expect(last?.accountId).toBe("a1");
    expect(last?.bodyMarkdown).toBe("Hello Anna,\n\n-- \nMe\nWork Ltd");
  });

  it("no sender can be chosen while Send waits for the files, so it goes with the pair it had", async () => {
    const fake = failingBackend();
    const t = newMessage(fake, { to: [{ address: "anna@example.org" }], subject: "Tuesday" });
    t.session.setBody(`Hello Anna,${t.session.body()}`);
    // A drop whose grants have not come: Send passes the sender's wait, then waits for these.
    const drop = t.session.attachDropped([{ name: "a.pdf", size: 10 }]);
    const sending = t.session.send();
    await Promise.resolve();
    expect(t.session.senderLocked()).toBe(true);
    expect(await t.session.setSender(home)).toBeNull();
    expect(fake.prepareNew).not.toHaveBeenCalled();
    drop.fill([]);
    await sending;
    expect(fake.sent).toEqual(["d1"]);
    const last = t.saved.at(-1);
    expect(last?.accountId).toBe("a1");
    expect(last?.bodyMarkdown).toBe("Hello Anna,\n\n-- \nMe\nWork Ltd");
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

  it("cuts a signature block the model wrote, and puts the person's under the words", async () => {
    const fake = fakeBackend();
    const outbox = createRoot(() => createOutboxStore(fake.backend));
    const store = createRoot(() => createComposeStore(fake.backend, outbox));
    await store.open("new", "a1", undefined, undefined, {
      to: ["anna@example.com"],
      subject: "Review",
      body: "Hello Anna,\n\nsee you then.\n\n-- \nThe Assistant",
    });
    expect(store.session()?.body()).toBe("Hello Anna,\n\nsee you then.\n\n-- \nMe\nWork Ltd");
  });
});
