// The page's side of forwarding (ADR 0045): the key, the button, the chips that exist in the frame
// of the composer, what a forward says it leaves behind, how it is titled again, and when closing
// it throws it away.
import type { AttachmentInfo, BackendEvent, ThreadMessage } from "@matters/contracts";
import type { Draft, DraftContent } from "@matters/core";
import { FORWARD_AS_TEXT, FORWARD_MARK, FORWARD_UNKNOWN_FILES, messageKey } from "@matters/core";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
  chipFromInfo,
  chipNote,
  drawsReadingRing,
  provisionalChip,
  readingText,
} from "../src/renderer/chips.ts";
import type { Backend } from "../src/renderer/client.ts";
import {
  type ComposerSession,
  createComposerSession,
  createComposeStore,
  titleOfDraft,
} from "../src/renderer/compose.ts";
import { planForward } from "../src/renderer/forward.ts";
import { plainKey, writeKeyOf } from "../src/renderer/keys.ts";
import { createOutboxStore } from "../src/renderer/outbox.ts";
import { chipKey, createProgressSink } from "../src/renderer/progress.ts";

vi.mock("../src/renderer/files.ts", () => ({
  pickFiles: async () => [],
  pasteImage: async () => null,
  onDropped: () => () => {},
}));

const later = () => new Promise((r) => setTimeout(r, 0));
const me = { name: "Me", address: "me@example.com" };
const MB = 1_000_000;

// --- keys ---

describe("the keys of the reader (rule 1)", () => {
  it("r replies, a replies to all, f forwards, and nothing else is one of them", () => {
    expect(writeKeyOf("r")).toBe("reply");
    expect(writeKeyOf("a")).toBe("replyAll");
    expect(writeKeyOf("f")).toBe("forward");
    for (const key of ["F", "R", "c", "e", "Enter", "", "fw"]) expect(writeKeyOf(key)).toBeNull();
  });

  it("f is a key of the window only where the others are: not in a field, not with a modifier, not in the composer", () => {
    const press = (over = {}) => ({
      key: "f",
      isComposing: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      ...over,
    });
    const place = { composeOpen: false, inSearch: false, textTarget: false };
    expect(plainKey(press(), place)).toBe("f");
    expect(plainKey(press(), { ...place, textTarget: true })).toBeNull();
    expect(plainKey(press(), { ...place, inSearch: true })).toBeNull();
    expect(plainKey(press(), { ...place, composeOpen: true })).toBeNull();
    expect(plainKey(press({ metaKey: true }), place)).toBeNull();
    expect(plainKey(press({ ctrlKey: true }), place)).toBeNull();
    expect(plainKey(press({ isComposing: true }), place)).toBeNull();
  });
});

// --- What the open thread knows ---

const file = (partId: string, name: string, size: number) => ({
  partId,
  name,
  mimeType: "application/pdf",
  size,
  inline: false,
});

function threadMessage(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    key: messageKey(1_800_000_000_000, 0),
    accountId: "a1",
    providerId: "p1",
    threadId: "t1",
    messageIdHeader: "<m1@x>",
    dateMs: 1_800_000_000_000,
    from: { name: "Anna", address: "anna@example.com" },
    to: [me],
    cc: [],
    subject: "Faktury",
    snippet: "",
    flags: { seen: true, flagged: false, answered: false, draft: false },
    labelIds: [],
    hasAttachments: true,
    senderAuth: "unknown",
    bodyText: "Zobacz.",
    attachments: [file("2", "Faktura.pdf", 212_000), file("3", "Regulamin.pdf", 640_000)],
    attachmentsKnown: true,
    hasInline: false,
    ...over,
  };
}

describe("planForward (rules 6, 11 and 12)", () => {
  const ids = () => {
    let n = 0;
    return () => `id${++n}`;
  };

  it("makes a chip for each listed file, in order, each with an id of its own", () => {
    const message = threadMessage();
    const plan = planForward(message, ids());
    expect(plan.files).toEqual([
      { id: "id1", messageKey: message.key, partId: "2", name: "Faktura.pdf", size: 212_000 },
      { id: "id2", messageKey: message.key, partId: "3", name: "Regulamin.pdf", size: 640_000 },
    ]);
    expect(plan.notices).toEqual([]);
  });

  it("adds nothing and says so when the files of the message are not known yet", () => {
    const plan = planForward(threadMessage({ attachmentsKnown: false, attachments: [] }), ids());
    expect(plan.files).toEqual([]);
    expect(plan.notices).toEqual([FORWARD_UNKNOWN_FILES]);
  });

  it("does the same for a message the page does not have", () => {
    const plan = planForward(undefined, ids());
    expect(plan.files).toEqual([]);
    expect(plan.notices).toEqual([FORWARD_UNKNOWN_FILES]);
  });

  it("says the layout stays behind for a designed message, and carries its files", () => {
    const plan = planForward(threadMessage({ htmlKind: "designed" }), ids());
    expect(plan.notices).toEqual([FORWARD_AS_TEXT]);
    expect(plan.files).toHaveLength(2);
  });

  it("says it for inline parts, and for a message with no files at all", () => {
    const plan = planForward(threadMessage({ hasInline: true, attachments: [] }), ids());
    expect(plan.notices).toEqual([FORWARD_AS_TEXT]);
    expect(plan.files).toEqual([]);
  });

  it("says nothing for a simple message without files", () => {
    expect(
      planForward(
        threadMessage({ htmlKind: "simple", attachments: [], hasAttachments: false }),
        ids(),
      ).notices,
    ).toEqual([]);
  });

  it("keeps two files with the same name and size: they are not a dropped duplicate", () => {
    const plan = planForward(
      threadMessage({ attachments: [file("2", "scan.pdf", 10), file("3", "scan.pdf", 10)] }),
      ids(),
    );
    expect(plan.files.map((f) => f.id)).toEqual(["id1", "id2"]);
  });
});

// --- A backend that records what a forward asks of it ---

const info = (id: string, over: Partial<AttachmentInfo> = {}): AttachmentInfo => ({
  id,
  name: `${id}.pdf`,
  size: 1000,
  state: "reading",
  reason: null,
  canRetry: true,
  forwarded: true,
  ...over,
});

function fakeBackend() {
  const calls: string[] = [];
  const listeners = new Set<(e: BackendEvent) => void>();
  const saved: DraftContent[] = [];
  let draft: Draft | null = null;
  const forwardedAsked: { draftId: string; files: unknown[] }[] = [];
  const rows = new Map<string, { name: string; size: number }>();
  const backend = {
    onEvent: (l: (e: BackendEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async saveDraft(args: { id?: string; content: DraftContent }) {
      calls.push(
        `save(${(args.content.attachments ?? []).map((a) => `${a.id}:${a.size}`).join(",")})`,
      );
      saved.push(args.content);
      draft = {
        ...args.content,
        id: args.id ?? "d1",
        version: (draft?.version ?? 0) + 1,
        fingerprint: "f",
        updatedAtMs: 0,
      };
      return draft;
    },
    async addForwardedAttachments(
      draftId: string,
      files: readonly { id: string; messageKey: number; partId: string }[],
    ) {
      calls.push(`addForwarded(${files.map((f) => f.id).join(",")})`);
      forwardedAsked.push({ draftId, files: [...files] });
      // The rows say what the message said: its names and its estimates.
      return files.map((f) => info(f.id, rows.get(f.id) ?? {}));
    },
    async deleteDraft(id: string) {
      calls.push(`delete(${id})`);
    },
    async requestSend(draftId: string) {
      calls.push(`send(${draftId})`);
      return {} as never;
    },
    async renderPreview() {
      return "";
    },
    listAttachments: vi.fn(async () => [] as AttachmentInfo[]),
    checkAttachmentSources: vi.fn(async () => [] as string[]),
    recaptureAttachment: vi.fn(async (_d: string, id: string) =>
      info(`${id}-again`, { name: "a.pdf", size: 5 }),
    ),
    prepareNew: vi.fn(async () => ({ messageLimitBytes: null })),
    prepareForward: vi.fn(async (_threadId: string, _hidden: boolean) => ({
      content: forwardContent(),
      existing: null,
      redirect: null,
      messageLimitBytes: 25_000_000,
      forwardedKey: threadMessage().key,
    })),
    getDraft: vi.fn(async (_id: string): Promise<Draft> => {
      throw new Error("no draft");
    }),
  };
  return {
    backend: backend as unknown as Backend,
    raw: backend,
    calls,
    saved,
    rows,
    forwardedAsked,
    emit: (e: BackendEvent) => {
      for (const l of listeners) l(e);
    },
  };
}

function forwardContent(over: Partial<DraftContent> = {}): DraftContent {
  return {
    accountId: "a1",
    from: me,
    to: [],
    cc: [],
    bcc: [],
    subject: "Fwd: Faktury",
    bodyMarkdown: `\n\n${FORWARD_MARK}\n> From: Anna\n>\n> Zobacz.\n`,
    inReplyTo: "",
    references: [],
    forwarded: true,
    ...over,
  };
}

function open(
  message: ThreadMessage | undefined = threadMessage(),
  options: { content?: DraftContent; existing?: Draft | null } = {},
) {
  const fake = fakeBackend();
  const outbox = createRoot(() => createOutboxStore(fake.backend));
  const sink = createProgressSink();
  const closed = vi.fn();
  let n = 0;
  const forward = planForward(message, () => `chip${++n}`);
  for (const f of forward.files) fake.rows.set(f.id, { name: f.name, size: f.size });
  const session = createRoot(() =>
    createComposerSession(
      fake.backend,
      outbox,
      {
        title: "Forward",
        content: options.content ?? forwardContent(),
        existing: options.existing ?? null,
        limitBytes: 25_000_000,
        ...(options.existing ? {} : { forward }),
      },
      closed,
      sink,
    ),
  );
  return { ...fake, session, sink, closed, outbox, forward };
}

describe("a forward's chips (rule 6)", () => {
  it("exist in the frame of the composer, before anything was asked of the backend", () => {
    const t = open();
    expect(t.session.attachments().map((c) => [c.id, c.name, c.size, c.state, c.added])).toEqual([
      ["chip1", "Faktura.pdf", 212_000, "reading", false],
      ["chip2", "Regulamin.pdf", 640_000, "reading", false],
    ]);
    expect(t.session.attachments().every((c) => c.forwarded)).toBe(true);
    // Nothing has been awaited yet.
    expect(t.calls).toEqual([]);
  });

  it("then make the draft, put the files on it, and are listed in it", async () => {
    const t = open();
    await later();
    await later();
    await later();
    expect(t.calls.slice(0, 2)).toEqual(["save()", "addForwarded(chip1,chip2)"]);
    expect(t.forwardedAsked[0]?.files).toEqual([
      { id: "chip1", messageKey: threadMessage().key, partId: "2" },
      { id: "chip2", messageKey: threadMessage().key, partId: "3" },
    ]);
    expect(t.session.attachments().every((c) => c.added)).toBe(true);
    await t.session.flush();
    expect(t.saved.at(-1)?.attachments?.map((a) => a.id)).toEqual(["chip1", "chip2"]);
    expect(t.saved.at(-1)?.forwarded).toBe(true);
  });

  it("send waits for the rows, never for the downloads", async () => {
    const t = open(threadMessage(), {
      content: forwardContent({ to: [{ name: "Jan", address: "jan@example.com" }] }),
    });
    await t.session.send();
    // The rows were made, the draft saved with them, and then the approval asked for.
    const order = t.calls.filter((c) => !c.startsWith("save()"));
    expect(order[0]).toBe("addForwarded(chip1,chip2)");
    expect(t.calls.at(-1)).toBe("send(d1)");
    expect(t.session.attachments().every((c) => c.state === "reading")).toBe(true);
  });

  it("a forward of a message with no files makes no draft until something is written", async () => {
    const t = open(threadMessage({ attachments: [], hasAttachments: false }));
    await later();
    await later();
    expect(t.calls).toEqual([]);
    expect(t.session.attachments()).toEqual([]);
  });

  it("removing one leaves the others, and the next save lists the rest", async () => {
    const t = open();
    await later();
    await later();
    t.session.removeAttachment("chip1");
    expect(t.session.attachments().map((c) => c.id)).toEqual(["chip2"]);
    await t.session.flush();
    expect(t.saved.at(-1)?.attachments?.map((a) => a.id)).toEqual(["chip2"]);
  });

  it("removing one before the draft has the rows keeps it out of the request", async () => {
    const t = open();
    t.session.removeAttachment("chip2");
    await later();
    await later();
    await later();
    expect(t.forwardedAsked[0]?.files).toEqual([
      { id: "chip1", messageKey: threadMessage().key, partId: "2" },
    ]);
  });

  it("a failed add is a chip that blocks Send, with the words of a download", async () => {
    const t = open();
    t.raw.addForwardedAttachments = async () => {
      throw new Error("db");
    };
    await later();
    await later();
    await later();
    const [first] = t.session.attachments();
    expect(first).toMatchObject({ state: "failed", reason: "Couldn’t download" });
    expect(t.session.problems().join(" ")).toContain("Faktura.pdf: Couldn’t download");
  });
});

describe("what the ring and the words say while a forwarded file downloads (rule 10)", () => {
  it("draws a ring from 1 MiB, and only the size below it", () => {
    const small = { ...provisionalChip("a", "a.pdf", 900_000, true), added: true };
    const big = { ...provisionalChip("b", "b.zip", 34 * MB, true), added: true };
    expect(drawsReadingRing(small)).toBe(false);
    expect(drawsReadingRing(big)).toBe(true);
    // An ordinary file being read always has its ring.
    expect(drawsReadingRing({ ...small, forwarded: false })).toBe(true);
    // A chip with no row yet has no progress to draw.
    expect(drawsReadingRing({ ...big, added: false })).toBe(false);
    expect(readingText(small)).toBe("900 KB");
    expect(readingText(big)).toBe("0 of 34 MB");
    expect(readingText({ ...big, forwarded: false })).toBe("Reading 0%");
  });

  it("reports the true bytes as '14 of 34 MB' for a big file and nothing for a small one", async () => {
    const message = threadMessage({
      attachments: [file("2", "Projekt.zip", 34 * MB), file("3", "Notatka.pdf", 100_000)],
    });
    const t = open(message);
    await later();
    await later();
    await later();
    // The rows say what the message said.
    t.emit({
      type: "attachments",
      draftId: "d1",
      attachments: [
        info("chip1", { name: "Projekt.zip", size: 34 * MB }),
        info("chip2", { name: "Notatka.pdf", size: 100_000 }),
      ],
    });
    const seen: string[] = [];
    const text = { textContent: "" };
    t.sink.bind(chipKey("chip1"), { ring: { style: { setProperty: () => {} } as never }, text });
    t.emit({ type: "attachmentProgress", id: "chip1", fraction: 14 / 34 });
    seen.push(text.textContent);
    expect(seen).toEqual(["14 of 34 MB"]);

    const small = { textContent: "unchanged" };
    t.sink.bind(chipKey("chip2"), {
      ring: { style: { setProperty: () => {} } as never },
      text: small,
    });
    t.emit({ type: "attachmentProgress", id: "chip2", fraction: 0.5 });
    expect(small.textContent).toBe("unchanged");
  });
});

describe("a forwarded file that did not arrive (rule 10)", () => {
  const base = { ...chipFromInfo(info("a")), state: "failed" as const };

  it("offline or failed: its words, in the late tone, and Try again can help", () => {
    const chip = { ...base, reason: "Couldn’t download", canRetry: true };
    expect(chipNote(chip)).toEqual({ text: "Couldn’t download", tone: "late" });
  });

  it("no longer on the server: quiet, and nothing to try again", () => {
    const chip = { ...base, reason: "No longer on the server", canRetry: false };
    expect(chipNote(chip)).toEqual({ text: "No longer on the server", tone: "plain" });
  });

  it("over the limit: the notice of ADR 0040", () => {
    const chip = { ...base, state: "tooLarge" as const, reason: "Larger than your server takes" };
    expect(chipNote(chip)).toEqual({ text: "Larger than your server takes", tone: "late" });
  });

  it("try again makes a new chip in the place of the old one, from the origin", async () => {
    const t = open();
    await later();
    await later();
    await later();
    t.emit({
      type: "attachments",
      draftId: "d1",
      attachments: [info("chip1", { state: "failed", reason: "Couldn’t download" })],
    });
    await t.session.recapture("chip1");
    expect(t.raw.recaptureAttachment).toHaveBeenCalledWith("d1", "chip1");
    expect(t.session.attachments().map((c) => c.id)).toEqual(["chip1-again", "chip2"]);
    expect(t.session.attachments()[0]?.forwarded).toBe(true);
  });

  it("the true size replaces the estimate, and the draft is saved with it", async () => {
    const t = open();
    await later();
    await later();
    await later();
    await t.session.flush();
    expect(t.saved.at(-1)?.attachments?.map((a) => a.size)).toEqual([212_000, 640_000]);
    t.emit({
      type: "attachments",
      draftId: "d1",
      attachments: [
        info("chip1", { name: "Faktura.pdf", size: 215_432, state: "ready", canRetry: false }),
      ],
    });
    expect(t.session.attachments()[0]).toMatchObject({ size: 215_432, state: "ready" });
    await t.session.flush();
    expect(t.saved.at(-1)?.attachments?.map((a) => a.size)).toEqual([215_432, 640_000]);
  });
});

// --- What it says it leaves behind ---

describe("notices of a forward (rules 11 and 12)", () => {
  it("are on the session, in lines of their own", () => {
    expect(open(threadMessage({ htmlKind: "designed" })).session.notices).toEqual([
      FORWARD_AS_TEXT,
    ]);
    expect(
      open(threadMessage({ attachmentsKnown: false, attachments: [], htmlKind: "designed" }))
        .session.notices,
    ).toEqual([FORWARD_UNKNOWN_FILES, FORWARD_AS_TEXT]);
    expect(open().session.notices).toEqual([]);
  });

  it("are not repeated for a draft that is opened again", () => {
    const existing = {
      ...forwardContent(),
      id: "d9",
      version: 2,
      fingerprint: "f",
      updatedAtMs: 0,
    };
    const t = open(threadMessage({ htmlKind: "designed" }), { existing });
    expect(t.session.notices).toEqual([]);
  });
});

// --- The title ---

describe("the title of a forward, and of one opened again (rule 1, rule 13)", () => {
  const stored = (over: Partial<Draft> = {}): Draft => ({
    ...forwardContent(),
    id: "d9",
    version: 2,
    fingerprint: "f",
    updatedAtMs: 0,
    ...over,
  });

  it("titleOfDraft knows a forward, a reply and a new message", () => {
    expect(titleOfDraft(stored())).toBe("Forward");
    expect(titleOfDraft(stored({ forwarded: false, inReplyTo: "<a@b>" }))).toBe("Reply");
    expect(titleOfDraft(stored({ forwarded: undefined, inReplyTo: "" }))).toBe("New message");
    expect(titleOfDraft(stored({ forwarded: true, inReplyTo: "<a@b>" }))).toBe("Forward");
  });

  it("a forward opened again through the tray is titled Forward", async () => {
    const fake = fakeBackend();
    fake.raw.getDraft.mockResolvedValue(stored());
    const outbox = createRoot(() => createOutboxStore(fake.backend));
    const store = createRoot(() => createComposeStore(fake.backend, outbox));
    await store.openDraft("d9");
    expect(store.session()?.title).toBe("Forward");
    expect(store.session()?.base.forwarded).toBe(true);
  });

  it("a reply and a new message keep their titles", async () => {
    const fake = fakeBackend();
    const outbox = createRoot(() => createOutboxStore(fake.backend));
    const store = createRoot(() => createComposeStore(fake.backend, outbox));
    fake.raw.getDraft.mockResolvedValue(stored({ forwarded: undefined, inReplyTo: "<a@b>" }));
    await store.openDraft("d9");
    expect(store.session()?.title).toBe("Reply");
  });

  it("opening a forward asks for the draft of the thread, with the view it is in", async () => {
    const fake = fakeBackend();
    const outbox = createRoot(() => createOutboxStore(fake.backend));
    const store = createRoot(() => createComposeStore(fake.backend, outbox));
    await store.open("forward", "a1", "t1", { hidden: true, messages: [threadMessage()] });
    expect(fake.raw.prepareForward).toHaveBeenCalledWith("t1", true);
    const session = store.session() as ComposerSession;
    expect(session.title).toBe("Forward");
    expect(session.attachments().map((c) => c.name)).toEqual(["Faktura.pdf", "Regulamin.pdf"]);
    expect(session.base.inReplyTo).toBe("");
    expect(session.base.threadId).toBeUndefined();
  });

  it("takes the files of the message the backend quoted, not of whichever is newest on the page", async () => {
    const fake = fakeBackend();
    const outbox = createRoot(() => createOutboxStore(fake.backend));
    const store = createRoot(() => createComposeStore(fake.backend, outbox));
    const quoted = threadMessage();
    const newer = threadMessage({
      key: quoted.key + 1,
      attachments: [file("2", "Nowsza.pdf", 1)],
    });
    await store.open("forward", "a1", "t1", { hidden: false, messages: [quoted, newer] });
    expect(
      store
        .session()
        ?.attachments()
        .map((c) => c.name),
    ).toEqual(["Faktura.pdf", "Regulamin.pdf"]);
  });

  it("says the files are not known when the page lacks the message the backend quoted", async () => {
    const fake = fakeBackend();
    const outbox = createRoot(() => createOutboxStore(fake.backend));
    const store = createRoot(() => createComposeStore(fake.backend, outbox));
    await store.open("forward", "a1", "t1", { hidden: false, messages: [] });
    expect(store.session()?.attachments()).toEqual([]);
    expect(store.session()?.notices).toEqual([FORWARD_UNKNOWN_FILES]);
  });

  it("a thread with nothing to forward says why and opens nothing", async () => {
    const fake = fakeBackend();
    fake.raw.prepareForward.mockRejectedValue(new Error("There is no message to forward"));
    const outbox = createRoot(() => createOutboxStore(fake.backend));
    const store = createRoot(() => createComposeStore(fake.backend, outbox));
    await store.open("forward", "a1", "t1", { hidden: false, messages: [] });
    expect(store.session()).toBeNull();
    expect(store.problem()).not.toBe("");
  });
});

// --- Closing ---

describe("closing a forward (rule 13)", () => {
  it("with nothing typed and no recipients discards it, along with its copies", async () => {
    const t = open();
    await later();
    await later();
    await later();
    await t.session.close();
    expect(t.calls.at(-1)).toBe("delete(d1)");
    expect(t.closed).toHaveBeenCalledTimes(1);
  });

  it("with only files taken off is still nothing written", async () => {
    const t = open();
    await later();
    await later();
    t.session.removeAttachment("chip1");
    t.session.removeAttachment("chip2");
    await t.session.close();
    expect(t.calls.at(-1)).toBe("delete(d1)");
  });

  it("with words above the quote keeps it", async () => {
    const t = open();
    await later();
    await later();
    t.session.setBody(`Hi Jan, see below.${forwardContent().bodyMarkdown}`);
    await t.session.close();
    expect(t.calls.some((c) => c.startsWith("delete"))).toBe(false);
    expect(t.saved.at(-1)?.bodyMarkdown).toContain("Hi Jan");
  });

  it("with a recipient keeps it", async () => {
    const t = open();
    await later();
    await later();
    t.session.setTo("jan@example.com");
    await t.session.close();
    expect(t.calls.some((c) => c.startsWith("delete"))).toBe(false);
    expect(t.session.to()).toBe("jan@example.com");
  });

  it("with the subject changed keeps it", async () => {
    const t = open();
    await later();
    await later();
    t.session.setSubject("Fwd: Faktury, pilne");
    await t.session.close();
    expect(t.calls.some((c) => c.startsWith("delete"))).toBe(false);
  });

  it("editing the quote is not writing: the quote is not the person's", async () => {
    const t = open();
    await later();
    await later();
    t.session.setBody(`\n\n${FORWARD_MARK}\n> From: Anna\n>\n> Zobacz tylko to.\n`);
    await t.session.close();
    expect(t.calls.at(-1)).toBe("delete(d1)");
  });

  it("deleting the whole quote and writing nothing is nothing written", async () => {
    const t = open();
    await later();
    await later();
    t.session.setBody("");
    await t.session.close();
    expect(t.calls.at(-1)).toBe("delete(d1)");
  });

  it("a forward without files and untouched leaves nothing behind either", async () => {
    const t = open(threadMessage({ attachments: [], hasAttachments: false }));
    await t.session.close();
    expect(t.calls).toEqual([]);
    expect(t.closed).toHaveBeenCalledTimes(1);
  });

  it("a reply that is closed untouched is not discarded by this rule", async () => {
    const fake = fakeBackend();
    const outbox = createRoot(() => createOutboxStore(fake.backend));
    const closed = vi.fn();
    const session = createRoot(() =>
      createComposerSession(
        fake.backend,
        outbox,
        {
          title: "Reply",
          content: forwardContent({ forwarded: false as never, inReplyTo: "<a@b>", to: [me] }),
          existing: null,
        },
        closed,
        createProgressSink(),
      ),
    );
    session.setBody("typed");
    await session.close();
    expect(fake.calls.some((c) => c.startsWith("delete"))).toBe(false);
  });
});
