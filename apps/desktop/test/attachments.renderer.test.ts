import type { AttachmentInfo, BackendEvent, PickedFile } from "@matters/contracts";
import type { Draft, DraftContent, SendOperation, SendState } from "@matters/core";
import { approve, LARGE_LANE_BYTES, newSendOperation, notifyIfLarge } from "@matters/core";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
  applyInfo,
  chipFromInfo,
  chipNote,
  extensionOf,
  provisionalChip,
} from "../src/renderer/chips.ts";
import type { Backend } from "../src/renderer/client.ts";
import { createComposerSession } from "../src/renderer/compose.ts";
import {
  createDragTracker,
  createDropRouter,
  DRAGGING_CLASS,
  hasFiles,
  installFileDrop,
} from "../src/renderer/fileDrop.ts";
import { fileSize, megabytes } from "../src/renderer/format.ts";
import { isAttachShortcut } from "../src/renderer/keys.ts";
import { createOutboxStore, sentOf } from "../src/renderer/outbox.ts";
import { chipKey, createProgressSink, sendKey } from "../src/renderer/progress.ts";
import { describeSend, type SendContext } from "../src/renderer/sendView.ts";

// The page's side of the preload messages: the tests answer them directly.
const asked = vi.hoisted(() => ({
  pickFiles: vi.fn(async (): Promise<unknown[]> => []),
  pasteImage: vi.fn(async (_blob: Blob): Promise<unknown> => null),
}));
vi.mock("../src/renderer/files.ts", () => ({
  pickFiles: asked.pickFiles,
  pasteImage: asked.pasteImage,
  onDropped: () => () => {},
}));

// --- Fakes ---

const me = { name: "Me", address: "me@example.com" };
const content = (over: Partial<DraftContent> = {}): DraftContent => ({
  accountId: "a1",
  from: me,
  to: [{ name: "Ann", address: "ann@example.com" }],
  cc: [],
  bcc: [],
  subject: "Hello",
  bodyMarkdown: "Hi",
  inReplyTo: "",
  references: [],
  ...over,
});

const info = (id: string, over: Partial<AttachmentInfo> = {}): AttachmentInfo => ({
  id,
  name: `${id}.pdf`,
  size: 1000,
  state: "ready",
  reason: null,
  canRetry: false,
  forwarded: false,
  ...over,
});

// The grant carries the name and size, so the fake can answer like the real rows do.
const picked = (name: string, size: number, kind: PickedFile["kind"] = "file"): PickedFile => ({
  grantId: kind === "file" ? `g-${name}|${size}` : "",
  name,
  size,
  kind,
});

/** A backend that records what the composer asks, in order. */
function fakeBackend(options: { limitBytes?: number | null } = {}) {
  const calls: string[] = [];
  const listeners = new Set<(e: BackendEvent) => void>();
  const saved: DraftContent[] = [];
  let draft: Draft | null = null;
  let addGate: Promise<void> | null = null;
  const backend = {
    onEvent: (l: (e: BackendEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async saveDraft(args: { id?: string; content: DraftContent }) {
      calls.push(`save(${(args.content.attachments ?? []).map((a) => a.id).join(",")})`);
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
    async addAttachments(draftId: string, files: readonly { id: string; grantId: string }[]) {
      calls.push(`add(${draftId}:${files.map((f) => f.id).join(",")})`);
      await addGate;
      return files.map((f) => {
        const [name = "", size = "0"] = f.grantId.slice(2).split("|");
        return info(f.id, { name, size: Number(size), state: "reading" });
      });
    },
    async requestSend(draftId: string) {
      calls.push(`send(${draftId})`);
      return newOp();
    },
    async deleteDraft(id: string) {
      calls.push(`delete(${id})`);
    },
    async renderPreview() {
      return "";
    },
    listAttachments: vi.fn(async () => [] as AttachmentInfo[]),
    checkAttachmentSources: vi.fn(async () => [] as string[]),
    recaptureAttachment: vi.fn(async (_d: string, id: string) =>
      info(`${id}-new`, { name: "a.pdf", size: 5, state: "reading" }),
    ),
    prepareNew: vi.fn(async () => ({ messageLimitBytes: options.limitBytes ?? null })),
    getDraft: vi.fn(),
  };
  return {
    backend: backend as unknown as Backend,
    raw: backend,
    calls,
    saved,
    emit: (e: BackendEvent) => {
      for (const l of listeners) l(e);
    },
    gateAdds: () => {
      let open!: () => void;
      addGate = new Promise<void>((r) => {
        open = r;
      });
      return () => open();
    },
  };
}

function newOp(over: Partial<SendOperation> = {}, state?: SendState): SendOperation {
  const draft = { id: "d1", version: 1, fingerprint: "f" } as Draft;
  return {
    ...newSendOperation({
      id: "op1",
      approval: approve(draft, null, 0),
      accountId: "a1",
      summary: "Hello to Ann",
      nowMs: 0,
      notBeforeMs: 10_000,
      encodedBytes: 0,
    }),
    ...(state ? { state } : {}),
    ...over,
  };
}

function setup(options: { limitBytes?: number | null; existing?: Draft | null } = {}) {
  const fake = fakeBackend(options);
  const outbox = createRoot(() => createOutboxStore(fake.backend));
  const sink = createProgressSink();
  const closed = vi.fn();
  const session = createRoot(() =>
    createComposerSession(
      fake.backend,
      outbox,
      {
        title: "New message",
        content: content(),
        existing: options.existing ?? null,
        limitBytes: options.limitBytes ?? null,
      },
      closed,
      sink,
    ),
  );
  return { ...fake, session, sink, closed, outbox };
}

const later = () => new Promise((r) => setTimeout(r, 0));

// --- Chips and their states ---

describe("chips", () => {
  it("names a file by its extension, and 'FILE' when it has none", () => {
    expect(extensionOf("report.final.PDF")).toBe("PDF");
    expect(extensionOf("archive.tar.gz")).toBe("GZ");
    expect(extensionOf("Makefile")).toBe("FILE");
    expect(extensionOf(".env")).toBe("FILE");
    expect(extensionOf("photo.jpeg")).toBe("JPEG");
  });

  it("says in words what is the matter with a chip, and nothing for a plain one", () => {
    const base = chipFromInfo(info("a"));
    expect(chipNote(base)).toBeNull();
    expect(chipNote({ ...base, size: 0 })).toEqual({ text: "Empty, 0 bytes", tone: "plain" });
    expect(chipNote({ ...base, changed: true })).toEqual({
      text: "Changed since you attached it",
      tone: "plain",
    });
    expect(
      chipNote({ ...base, state: "failed", reason: "Not enough disk space", canRetry: true }),
    ).toEqual({
      text: "Not enough disk space",
      tone: "late",
    });
    expect(chipNote({ ...base, state: "failed", reason: null })?.text).toBe("Can't read this file");
    expect(
      chipNote({ ...base, state: "tooLarge", reason: "Larger than your server takes" }),
    ).toEqual({
      text: "Larger than your server takes",
      tone: "late",
    });
    // reading has its own words, written by progress directly
    expect(chipNote({ ...base, state: "reading" })).toBeNull();
  });

  it("never lets a trailing 'reading' undo a known outcome, and keeps 'changed' while it is ready", () => {
    const ready = { ...chipFromInfo(info("a")), changed: true };
    expect(applyInfo(ready, info("a", { state: "reading" })).state).toBe("ready");
    expect(applyInfo(ready, info("a")).changed).toBe(true);
    const failed = { ...ready, state: "failed" as const, reason: "Can't read this file" };
    expect(applyInfo(failed, info("a", { state: "reading" }))).toMatchObject({
      state: "failed",
      reason: "Can't read this file",
    });
    const reading = provisionalChip("a", "a.pdf", 10);
    expect(applyInfo(reading, info("a", { size: 12 }))).toMatchObject({
      state: "ready",
      size: 12,
      added: true,
    });
  });

  it("formats sizes the way Finder counts them", () => {
    expect(fileSize(0)).toBe("0 B");
    expect(fileSize(999)).toBe("999 B");
    expect(fileSize(12_345)).toBe("12 KB");
    expect(fileSize(2_400_000)).toBe("2.4 MB");
    expect(megabytes(13_600_000)).toBe("13.6 MB");
    expect(megabytes(25_000_000)).toBe("25 MB");
    expect(sentOf(14_000_000, 34_000_000)).toBe("14 of 34 MB");
    expect(sentOf(40_000_000, 34_000_000)).toBe("34 of 34 MB");
  });
});

// --- Attaching: the chip first, the grant after ---

describe("a dropped file", () => {
  it("is a chip in the same frame, before the draft exists or any grant arrived", () => {
    const t = setup();
    const batch = t.session.attachDropped([{ name: "report.pdf", size: 2_400_000 }]);
    // Synchronous: nothing was awaited, nothing was asked of the backend.
    expect(t.session.attachments()).toHaveLength(1);
    expect(t.session.attachments()[0]).toMatchObject({
      name: "report.pdf",
      size: 2_400_000,
      added: false,
    });
    expect(t.calls).toEqual([]);
    expect(t.session.draft()).toBeNull();
    expect(batch).toBeDefined();
  });

  it("then takes its grant: the draft is saved first, then the file is added, then saved with it", async () => {
    const t = setup();
    const batch = t.session.attachDropped([{ name: "report.pdf", size: 2_400_000 }]);
    const id = t.session.attachments()[0]?.id as string;
    batch.fill([picked("report.pdf", 2_400_000)]);
    await later();
    await later();
    expect(t.calls[0]).toBe("save()");
    expect(t.calls[1]).toBe(`add(d1:${id})`);
    // The row is added; only now does the draft list the file.
    await t.session.flush();
    expect(t.calls.at(-1)).toBe(`save(${id})`);
    expect(t.session.attachments()[0]).toMatchObject({ added: true, state: "reading" });
  });

  it("pairs drops with grants by their number, whichever the grants arrive in", () => {
    const first = { fill: vi.fn() };
    const second = { fill: vi.fn() };
    const batches = [first, second];
    const router = createDropRouter({
      session: () => ({ attachDropped: () => batches.shift() }) as never,
      open: async () => {},
    });
    router.drop([{ name: "a", size: 1 }], "new");
    router.drop([{ name: "b", size: 1 }], "new");
    router.granted(2, [picked("b", 1)]);
    expect(second.fill).toHaveBeenCalledWith([picked("b", 1)]);
    expect(first.fill).not.toHaveBeenCalled();
    router.granted(1, [picked("a", 1)]);
    expect(first.fill).toHaveBeenCalledWith([picked("a", 1)]);
    expect(router.waiting()).toBe(0);
  });

  it("opens the composer the drop asked for, and attaches once it is there", async () => {
    let session: unknown = null;
    const batch = { fill: vi.fn() };
    const open = vi.fn(async (target: string) => {
      session = { attachDropped: vi.fn(() => batch), target };
    });
    const router = createDropRouter({ session: () => session as never, open });
    router.drop([{ name: "a", size: 1 }], "reply");
    router.granted(1, [picked("a", 1)]);
    await later();
    expect(open).toHaveBeenCalledWith("reply");
    expect(batch.fill).toHaveBeenCalledWith([picked("a", 1)]);
  });

  it("a folder loses its chip and says why; the files with it continue", async () => {
    const t = setup();
    const batch = t.session.attachDropped([
      { name: "photos", size: 0 },
      { name: "a.pdf", size: 5 },
    ]);
    expect(t.session.attachments()).toHaveLength(2);
    batch.fill([picked("photos", 0, "directory"), picked("a.pdf", 5)]);
    expect(t.session.attachments().map((c) => c.name)).toEqual(["a.pdf"]);
    expect(t.session.attachStatus()).toBe("Folders can't be attached. Zip it first.");
    await later();
    expect(t.calls.some((c) => c.startsWith("add("))).toBe(true);
  });

  it("the same file twice gets one chip and a line; a missing one and an oversized paste too", () => {
    const t = setup();
    t.session.attachDropped([{ name: "x.pdf", size: 5 }]);
    t.session.attachDropped([{ name: "x.pdf", size: 5 }]);
    expect(t.session.attachments()).toHaveLength(1);
    expect(t.session.attachStatus()).toBe("x.pdf is already attached.");
    // the second drop's grant pairs with no chip and is ignored
    const batch = t.session.attachDropped([{ name: "gone.txt", size: 1 }]);
    batch.fill([picked("gone.txt", 0, "missing")]);
    expect(t.session.attachStatus()).toBe("gone.txt could not be found.");
    t.session.attachPicked([picked("shot.png", 0, "tooLarge")]);
    expect(t.session.attachStatus()).toContain("over 50 MB");
    expect(t.session.attachments().map((c) => c.name)).toEqual(["x.pdf"]);
  });

  it("an empty file is allowed and says so", () => {
    const t = setup();
    t.session.attachPicked([picked("empty.txt", 0)]);
    expect(t.session.attachments()[0]?.size).toBe(0);
    expect(t.session.problems()).toEqual([]);
  });

  it("a chip removed while its file is read stays removed when an event about it arrives", async () => {
    const t = setup();
    t.session.attachPicked([picked("a.pdf", 5)]);
    const id = t.session.attachments()[0]?.id as string;
    await later();
    await later();
    t.session.removeAttachment(id);
    expect(t.session.attachments()).toEqual([]);
    t.emit({
      type: "attachments",
      draftId: "d1",
      attachments: [info(id, { name: "a.pdf", size: 5 })],
    });
    expect(t.session.attachments()).toEqual([]);
    await t.session.flush();
    expect(t.saved.at(-1)?.attachments).toBeUndefined();
  });

  it("a state change from the backend reaches the chip, and a screen reader hears it", async () => {
    const t = setup();
    t.session.attachPicked([picked("a.pdf", 5)]);
    const id = t.session.attachments()[0]?.id as string;
    await later();
    await later();
    t.emit({
      type: "attachments",
      draftId: "d1",
      attachments: [info(id, { name: "a.pdf", size: 6 })],
    });
    expect(t.session.attachments()[0]).toMatchObject({ state: "ready", size: 6 });
    expect(t.session.announcement()).toBe("a.pdf is attached.");
    t.emit({
      type: "attachments",
      draftId: "d1",
      attachments: [info(id, { name: "a.pdf", state: "failed", reason: "Can't read this file" })],
    });
    expect(t.session.announcement()).toBe("a.pdf: Can't read this file");
    expect(t.session.announcement()).not.toMatch(/%/);
  });

  it("a failed chip blocks Send in words, and Try again reads the original as a new file", async () => {
    const t = setup();
    t.session.attachPicked([picked("a.pdf", 5)]);
    const id = t.session.attachments()[0]?.id as string;
    await later();
    await later();
    t.emit({
      type: "attachments",
      draftId: "d1",
      attachments: [info(id, { name: "a.pdf", state: "failed", reason: "Not enough disk space" })],
    });
    expect(t.session.problems()).toEqual(["a.pdf: Not enough disk space"]);
    await t.session.recapture(id);
    expect(t.raw.recaptureAttachment).toHaveBeenCalledWith("d1", id);
    expect(t.session.attachments().map((c) => c.id)).toEqual([`${id}-new`]);
    expect(t.session.problems()).toEqual([]);
  });

  it("notices a changed original, and 'Use new version' replaces it", async () => {
    const t = setup();
    t.session.attachPicked([picked("a.pdf", 5)]);
    const id = t.session.attachments()[0]?.id as string;
    await later();
    await later();
    t.emit({
      type: "attachments",
      draftId: "d1",
      attachments: [info(id, { name: "a.pdf", size: 5 })],
    });
    t.raw.checkAttachmentSources.mockResolvedValueOnce([id]);
    await t.session.checkSources();
    expect(t.session.attachments()[0]?.changed).toBe(true);
    await t.session.recapture(id);
    expect(t.session.attachments().map((c) => c.id)).toEqual([`${id}-new`]);
  });

  it("a draft kept from before lists its files, read again from the backend", async () => {
    const existing = {
      ...content({
        attachments: [{ id: "k", name: "k.pdf", size: 9, delivery: { kind: "inline" } }],
      }),
      id: "d9",
      version: 2,
      fingerprint: "f",
      updatedAtMs: 0,
    } as Draft;
    const t = setup({ existing });
    expect(t.session.attachments().map((c) => c.name)).toEqual(["k.pdf"]);
    t.raw.listAttachments.mockResolvedValueOnce([
      info("k", { state: "failed", reason: "Can't read this file" }),
    ]);
    // a new session reads the rows on creation
    const again = createRoot(() =>
      createComposerSession(
        t.backend,
        t.outbox,
        { title: "Reply", content: existing, existing },
        () => {},
        t.sink,
      ),
    );
    await later();
    expect(t.raw.listAttachments).toHaveBeenCalledWith("d9");
    expect(again.attachments()[0]).toMatchObject({ state: "failed" });
  });
});

// --- The footer: heavy and too large ---

describe("large messages", () => {
  it("says 'heavy' from 10 MB, blocks nothing, and has no word for a small one", () => {
    const t = setup({ limitBytes: 50_000_000 });
    t.session.attachPicked([picked("small.pdf", 1_000_000)]);
    expect(t.session.notice()).toBeNull();
    t.session.attachPicked([picked("big.zip", 12_000_000)]);
    expect(t.session.notice()?.kind).toBe("heavy");
    expect(t.session.problems()).toEqual([]);
  });

  it("is 'too large' over the account's limit, and that blocks Send with the core's words", async () => {
    const t = setup({ limitBytes: 25_000_000 });
    t.session.attachPicked([picked("a.zip", 20_000_000), picked("b.zip", 10_000_000)]);
    await later();
    await later();
    expect(t.session.notice()?.kind).toBe("tooLarge");
    // Rows exist now, so the draft lists the files and the blocker applies.
    expect(t.session.problems()).toHaveLength(1);
    expect(t.session.problems()[0]).toMatch(/to send, your server takes 25 MB\. Remove a file\.$/);
    expect(await t.session.send()).toBeNull();
    expect(t.calls.some((c) => c.startsWith("send("))).toBe(false);
  });

  it("learns the limit from the event, for the account it belongs to", async () => {
    const t = setup({ limitBytes: null });
    t.session.attachPicked([picked("a.zip", 30_000_000)]);
    await later();
    await later();
    expect(t.session.notice()?.kind).toBe("heavy");
    t.emit({ type: "messageLimit", accountId: "other", limitBytes: 1 });
    expect(t.session.notice()?.kind).toBe("heavy");
    t.emit({ type: "messageLimit", accountId: "a1", limitBytes: 25_000_000 });
    expect(t.session.notice()?.kind).toBe("tooLarge");
  });

  it("asks nobody else whether a size is over a limit", () => {
    // The composer's own notice is the core's function, nothing more.
    expect(notifyIfLarge([], 10, [])).toBeNull();
    expect(LARGE_LANE_BYTES).toBe(1_048_576);
  });
});

// --- Send, with a file still being read ---

describe("Send with a file being read", () => {
  it("waits for the rows, not the copy: add, then save with the file, then request", async () => {
    const t = setup();
    t.session.attachPicked([picked("a.pdf", 5)]);
    const id = t.session.attachments()[0]?.id as string;
    // The chip is `reading` and no event ever says otherwise in this test.
    const op = await t.session.send();
    expect(op).not.toBeNull();
    const order = t.calls.filter((c) => !c.startsWith("delete"));
    const iAdd = order.findIndex((c) => c.startsWith("add("));
    const iSave = order.findIndex((c, i) => i > iAdd && c.startsWith("save("));
    const iSend = order.findIndex((c) => c.startsWith("send("));
    expect(iAdd).toBeGreaterThan(-1);
    expect(iSave).toBeGreaterThan(iAdd);
    expect(iSend).toBeGreaterThan(iSave);
    expect(order[iSave]).toBe(`save(${id})`);
    expect(t.session.attachments()[0]?.state).toBe("reading");
    expect(t.closed).toHaveBeenCalled();
  });

  it("holds Send only for the add that is in flight", async () => {
    const t = setup();
    const release = t.gateAdds();
    t.session.attachPicked([picked("a.pdf", 5)]);
    await later();
    let sent = false;
    const sending = t.session.send().then(() => {
      sent = true;
    });
    await later();
    expect(sent).toBe(false);
    expect(t.calls.some((c) => c.startsWith("send("))).toBe(false);
    release();
    await sending;
    expect(t.calls.at(-1)).toMatch(/^send\(/);
  });

  it("waits for the grant of a file just dropped, then sends it", async () => {
    const t = setup();
    const batch = t.session.attachDropped([{ name: "a.pdf", size: 5 }]);
    let sent = false;
    const sending = t.session.send().then((op) => {
      sent = op !== null;
    });
    await later();
    expect(sent).toBe(false);
    batch.fill([picked("a.pdf", 5)]);
    await sending;
    expect(sent).toBe(true);
    const order = t.calls;
    expect(order.findIndex((c) => c.startsWith("add("))).toBeLessThan(
      order.findIndex((c) => c.startsWith("send(")),
    );
  });

  it("a file that failed to attach never goes unmentioned", async () => {
    const t = setup();
    t.raw.listAttachments.mockResolvedValue([]);
    (t.raw as unknown as { addAttachments: unknown }).addAttachments = async () => {
      throw new Error("expired");
    };
    t.session.attachPicked([picked("a.pdf", 5)]);
    await later();
    await later();
    expect(t.session.attachments()[0]).toMatchObject({ state: "failed", added: false });
    expect(await t.session.send()).toBeNull();
    expect(t.session.error()).toContain("a.pdf");
  });

  it("closing keeps the files that were being added", async () => {
    const t = setup();
    t.session.attachPicked([picked("a.pdf", 5)]);
    await t.session.close();
    const id = t.saved.at(-1)?.attachments?.[0]?.id;
    expect(id).toBeDefined();
  });
});

// --- Pick and paste ---

describe("the dialog and the clipboard", () => {
  it("a pick becomes chips and rows; a cancelled dialog changes nothing", async () => {
    const t = setup();
    asked.pickFiles.mockResolvedValueOnce([]);
    await t.session.pick();
    expect(t.session.attachments()).toEqual([]);
    asked.pickFiles.mockResolvedValueOnce([picked("a.pdf", 5), picked("dir", 0, "directory")]);
    await t.session.pick();
    expect(t.session.attachments().map((c) => c.name)).toEqual(["a.pdf"]);
    expect(t.session.attachStatus()).toBe("Folders can't be attached. Zip it first.");
    await later();
    await later();
    expect(t.calls.some((c) => c.startsWith("add("))).toBe(true);
  });

  it("a pasted image is a chip at once, named by main when it answers", async () => {
    const t = setup();
    let answer!: (file: unknown) => void;
    asked.pasteImage.mockImplementationOnce(
      () =>
        new Promise((r) => {
          answer = r;
        }),
    );
    const pasting = t.session.pasteImages([new Blob(["x"], { type: "image/png" })]);
    await later();
    expect(t.session.attachments()[0]).toMatchObject({ name: "Pasted image", added: false });
    answer(picked("Pasted image 1.png", 1));
    await pasting;
    expect(t.session.attachments()[0]?.name).toBe("Pasted image 1.png");
    await later();
    await later();
    expect(t.calls.some((c) => c.startsWith("add("))).toBe(true);
  });

  it("a paste main refused takes its chip away", async () => {
    const t = setup();
    asked.pasteImage.mockResolvedValueOnce(null);
    await t.session.pasteImages([new Blob(["x"], { type: "image/png" })]);
    expect(t.session.attachments()).toEqual([]);
  });
});

// --- Progress ---

describe("progress", () => {
  it("sets the variable and the words on the element asked, and renders nothing else", () => {
    const sink = createProgressSink();
    const style = { setProperty: vi.fn() };
    const text = { textContent: "Reading 0%" };
    const off = sink.bind(chipKey("a"), { ring: { style } as never, text });
    sink.report(chipKey("a"), 0.4, "Reading 40%");
    expect(style.setProperty).toHaveBeenLastCalledWith("--p", "0.4");
    expect(text.textContent).toBe("Reading 40%");
    off();
    sink.report(chipKey("a"), 0.9, "Reading 90%");
    expect(text.textContent).toBe("Reading 40%");
    // a late element gets the last report at once
    const late = { style: { setProperty: vi.fn() } };
    sink.bind(chipKey("a"), { ring: late as never });
    expect(late.style.setProperty).toHaveBeenCalledWith("--p", "0.9");
    sink.forget(chipKey("a"));
    const after = { style: { setProperty: vi.fn() } };
    sink.bind(chipKey("a"), { ring: after as never });
    expect(after.style.setProperty).not.toHaveBeenCalled();
  });

  it("a chip's progress changes no list: the chips are the same array before and after", async () => {
    const t = setup();
    t.session.attachPicked([picked("a.pdf", 5)]);
    const id = t.session.attachments()[0]?.id as string;
    await later();
    await later();
    const before = t.session.attachments();
    const style = { setProperty: vi.fn() };
    t.sink.bind(chipKey(id), { ring: { style } as never });
    t.emit({ type: "attachmentProgress", id, fraction: 0.5 });
    expect(style.setProperty).toHaveBeenCalledWith("--p", "0.5");
    expect(t.session.attachments()).toBe(before);
    expect(t.session.announcement()).toBe("");
  });

  it("ignores a trailing report for a chip that is no longer reading", async () => {
    const t = setup();
    t.session.attachPicked([picked("a.pdf", 5)]);
    const id = t.session.attachments()[0]?.id as string;
    await later();
    await later();
    t.emit({
      type: "attachments",
      draftId: "d1",
      attachments: [info(id, { name: "a.pdf", size: 5 })],
    });
    const style = { setProperty: vi.fn() };
    t.sink.bind(chipKey(id), { ring: { style } as never });
    t.emit({ type: "attachmentProgress", id, fraction: 0.99 });
    expect(style.setProperty).not.toHaveBeenCalled();
  });

  it("a send's progress goes to its dot, and the outbox keeps the same operations", () => {
    const fake = fakeBackend();
    const sink = createProgressSink();
    const outbox = createRoot(() => createOutboxStore(fake.backend, Date.now, sink));
    const op = newOp({ encodedBytes: 5_000_000, mimeBytes: 5_000_000 }, { kind: "running" });
    fake.emit({ type: "outbox", operations: [op] });
    const operations = outbox.operations();
    const style = { setProperty: vi.fn() };
    const text = { textContent: "0 of 5 MB" };
    sink.bind(sendKey("op1"), { ring: { style } as never, text });
    fake.emit({
      type: "sendProgress",
      operationId: "op1",
      sentBytes: 2_500_000,
      totalBytes: 5_000_000,
    });
    expect(style.setProperty).toHaveBeenCalledWith("--p", "0.5");
    expect(text.textContent).toBe("2.5 of 5 MB");
    expect(outbox.operations()).toBe(operations);
  });

  it("names the file a waiting send is waiting for, from the attachments events", () => {
    const fake = fakeBackend();
    const outbox = createRoot(() =>
      createOutboxStore(fake.backend, Date.now, createProgressSink()),
    );
    fake.emit({
      type: "attachments",
      draftId: "d1",
      attachments: [info("a", { state: "reading" }), info("b")],
    });
    expect(outbox.readingFiles("d1")).toEqual(["a.pdf"]);
    expect(outbox.readingFiles("other")).toEqual([]);
  });
});

// --- The dot and its line, for every state ---

describe("the send tray", () => {
  const big = { encodedBytes: 34_000_000 };
  const ctx = (over: Partial<SendContext> = {}): SendContext => ({
    secondsLeft: 0,
    reading: [],
    ...over,
  });
  const view = (op: Partial<SendOperation>, state: SendState, c: Partial<SendContext> = {}) =>
    describeSend(newOp({ ...big, ...op }, state), ctx(c));

  it("keeps today's dot and words for a message under 1 MiB", () => {
    const small = (state: SendState, c: Partial<SendContext> = {}) =>
      describeSend(newOp({ encodedBytes: 1000 }, state), ctx(c));
    expect(small({ kind: "pending" }, { secondsLeft: 7 })).toMatchObject({
      small: true,
      dot: "pulse",
      line: "Sending…",
      actions: ["undo"],
    });
    expect(small({ kind: "running" })).toMatchObject({
      dot: "pulse",
      line: "Sending…",
      actions: [],
    });
    expect(small({ kind: "succeeded", providerMessageId: "x" })).toMatchObject({
      dot: "good",
      line: "Sent",
      actions: ["dismiss"],
    });
    expect(small({ kind: "held" })).toMatchObject({
      dot: "late",
      line: "Not sent yet",
      actions: ["sendNow", "discard"],
    });
    expect(small({ kind: "failed", reason: "no" })).toMatchObject({
      line: "Not sent",
      reason: "no",
      actions: ["retry", "discard"],
    });
    expect(small({ kind: "unknown" })).toMatchObject({
      line: "Not sure it was sent",
      actions: ["sendAgain", "markSent"],
    });
    expect(small({ kind: "cancelled" })).toMatchObject({ line: "Cancelled", dot: "none" });
    // an old pending with the window over shows no Undo, as before
    expect(small({ kind: "pending" }, { secondsLeft: 0 }).actions).toEqual([]);
    // a connection lost on a small message is not the tray's business: same words
    expect(
      describeSend(newOp({ encodedBytes: 1000, autoRetries: 1 }, { kind: "pending" }), ctx()).line,
    ).toBe("Sending…");
  });

  it("undo window: the dot drains and the line counts down in the button", () => {
    expect(view({}, { kind: "pending" }, { secondsLeft: 7 })).toMatchObject({
      small: false,
      dot: "drain",
      line: "Sending…",
      actions: ["undo"],
    });
  });

  it("waiting for a file: a breathing ring, the file's name, Undo", () => {
    expect(view({}, { kind: "pending" }, { reading: ["report.pdf"] })).toMatchObject({
      dot: "breathe",
      line: "Waiting for report.pdf",
      actions: ["undo"],
    });
    expect(view({}, { kind: "pending" }, { reading: ["a", "b", "c"] }).line).toBe(
      "Waiting for 3 files",
    );
    // the window still drains, and the words say what the send is waiting for
    expect(view({}, { kind: "pending" }, { secondsLeft: 4, reading: ["a"] })).toMatchObject({
      dot: "drain",
      line: "Waiting for a",
      actions: ["undo"],
    });
  });

  it("building: 'Preparing…' with a breathing ring and no action", () => {
    expect(view({ mimeBytes: null }, { kind: "running" })).toMatchObject({
      dot: "breathe",
      line: "Preparing…",
      actions: [],
    });
    expect(view({}, { kind: "pending" })).toMatchObject({ line: "Preparing…", actions: ["undo"] });
  });

  it("uploading: a ring with the bytes in words, and Stop", () => {
    const v = view({ mimeBytes: 34_000_000 }, { kind: "running" });
    expect(v).toMatchObject({
      dot: "ring",
      line: "Sending…",
      live: "0 of 34 MB",
      actions: ["stop"],
    });
    // the words that change are not in the line a screen reader is told
    expect(v.announce).toBe("Sending");
  });

  it("waiting for the answer: a full ring and no action, since it can no longer be stopped", () => {
    expect(view({ mimeBytes: 34_000_000, dataEnded: true }, { kind: "running" })).toMatchObject({
      dot: "full",
      line: "Waiting for the server…",
      actions: [],
    });
  });

  it("delivered: solid good, 'Sent', Dismiss, and the warning after it", () => {
    expect(
      view({ warning: "Not saved to Sent" }, { kind: "succeeded", providerMessageId: "x" }),
    ).toMatchObject({
      dot: "good",
      line: "Sent",
      reason: "Not saved to Sent",
      actions: ["dismiss"],
    });
  });

  it("connection lost: a hollow dot, the seconds, Retry now, and Discard as an undo", () => {
    expect(view({ autoRetries: 1 }, { kind: "pending" }, { secondsLeft: 28 })).toMatchObject({
      dot: "hollow",
      line: "Connection lost · trying again in 28 s",
      actions: ["retryNow", "discard"],
      bad: true,
    });
    expect(view({ autoRetries: 2 }, { kind: "pending" }, { secondsLeft: 0 }).line).toBe(
      "Connection lost · trying again",
    );
  });

  it("failed: solid late, the reason, Retry; or Open draft when only the draft can help", () => {
    expect(view({}, { kind: "failed", reason: "Connection refused" })).toMatchObject({
      dot: "late",
      line: "Not sent",
      reason: "Connection refused",
      actions: ["retry", "discard"],
    });
    expect(
      view({}, { kind: "failed", reason: "report.pdf is missing", action: "openDraft" }),
    ).toMatchObject({ reason: "report.pdf is missing", actions: ["openDraft", "discard"] });
  });

  it("unknown: half late, Send again or Mark as sent", () => {
    expect(view({}, { kind: "unknown" })).toMatchObject({
      dot: "half",
      line: "Not sure it was sent",
      actions: ["sendAgain", "markSent"],
    });
  });

  it("held (the app was closed): Send now or Discard; voided: Dismiss", () => {
    expect(view({}, { kind: "held" })).toMatchObject({
      line: "Not sent yet",
      actions: ["sendNow", "discard"],
    });
    expect(view({}, { kind: "voided", reason: "Edited" })).toMatchObject({
      line: "Not sent",
      reason: "Edited",
      actions: ["dismiss"],
    });
  });

  it("never puts a number in what a screen reader is told", () => {
    const states: [Partial<SendOperation>, SendState, Partial<SendContext>][] = [
      [{ autoRetries: 1 }, { kind: "pending" }, { secondsLeft: 28 }],
      [{}, { kind: "pending" }, { secondsLeft: 7 }],
      [{ mimeBytes: 34_000_000 }, { kind: "running" }, {}],
      [{}, { kind: "held" }, {}],
    ];
    for (const [op, state, c] of states) expect(view(op, state, c).announce).not.toMatch(/\d/);
  });
});

// --- Dragging files over the window ---

describe("the drag overlay", () => {
  const body = () => {
    const classes = new Set<string>();
    return {
      classes,
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
    };
  };
  const drag = (
    types: string[],
    extra: { clientX?: number; clientY?: number; count?: number } = {},
  ) => ({
    dataTransfer: { types, items: { length: extra.count ?? 0 }, dropEffect: "none" },
    clientX: extra.clientX ?? 100,
    clientY: extra.clientY ?? 100,
    preventDefault: vi.fn(),
  });

  it("only files count: text dragged inside the editor is left alone", () => {
    expect(hasFiles({ types: ["Files"] })).toBe(true);
    expect(hasFiles({ types: ["text/plain", "Files"] })).toBe(true);
    expect(hasFiles({ types: ["text/plain"] })).toBe(false);
    expect(hasFiles(null)).toBe(false);
    const b = body();
    const tracker = createDragTracker(b);
    tracker.enter(drag(["text/plain"]));
    expect(b.classes.has(DRAGGING_CLASS)).toBe(false);
  });

  it("counts the children it enters and leaves: one class, off only when the last one is left", () => {
    const b = body();
    const tracker = createDragTracker(b);
    tracker.enter(drag(["Files"])); // the window
    tracker.enter(drag(["Files"])); // a child of it
    expect(b.classes.has(DRAGGING_CLASS)).toBe(true);
    tracker.leave(drag(["Files"])); // leaves the window's own element for the child
    expect(b.classes.has(DRAGGING_CLASS)).toBe(true);
    tracker.leave(drag(["Files"]));
    expect(b.classes.has(DRAGGING_CLASS)).toBe(false);
    expect(tracker.active()).toBe(false);
    // a stray leave does not go below zero or turn anything on
    tracker.leave(drag(["Files"]));
    tracker.enter(drag(["Files"]));
    expect(b.classes.has(DRAGGING_CLASS)).toBe(true);
  });

  it("reports how many files are dragged, once", () => {
    const counts: number[] = [];
    const tracker = createDragTracker(body(), { onEnter: (n) => counts.push(n) });
    tracker.enter(drag(["Files"], { count: 3 }));
    tracker.enter(drag(["Files"], { count: 3 }));
    expect(counts).toEqual([3]);
  });

  it("ends when the drag leaves through the window's edge, even with children left in the count", () => {
    const b = body();
    const tracker = createDragTracker(b, { bounds: () => ({ width: 800, height: 600 }) });
    for (let i = 0; i < 4; i++) tracker.enter(drag(["Files"]));
    tracker.leave(drag(["Files"], { clientX: 0, clientY: 300 }));
    expect(b.classes.has(DRAGGING_CLASS)).toBe(false);
  });

  it("changes nothing on dragover but the drop effect, and only for files", () => {
    const b = body();
    const tracker = createDragTracker(b);
    const over = drag(["Files"]);
    tracker.over(over);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe("copy");
    expect(tracker.active()).toBe(false);
    expect(b.classes.size).toBe(0);
    const text = drag(["text/plain"]);
    tracker.over(text);
    expect(text.preventDefault).not.toHaveBeenCalled();
  });

  function page() {
    const listeners = new Map<string, ((e: never) => void)[]>();
    const w = {
      innerWidth: 800,
      innerHeight: 600,
      addEventListener: (type: string, fn: (e: never) => void) =>
        listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      removeEventListener: (type: string, fn: (e: never) => void) =>
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((f) => f !== fn),
        ),
    };
    return {
      w: w as never,
      fire: (type: string, e: object) => {
        for (const fn of listeners.get(type) ?? []) fn(e as never);
      },
      count: (type: string) => (listeners.get(type) ?? []).length,
    };
  }

  function install() {
    const p = page();
    const b = body();
    let granted: (d: { dropId: number; files: readonly PickedFile[] }) => void = () => {};
    const batch = { fill: vi.fn() };
    const attachDropped = vi.fn(() => batch);
    const session = { attachDropped };
    const counts: number[] = [];
    const hovers: unknown[] = [];
    const installed = installFileDrop(
      {
        session: () => session as never,
        open: async () => {},
        onGranted: (l) => {
          granted = l;
          return () => {};
        },
        page: p.w,
        body: b,
      },
      { setCount: (n) => counts.push(n), setHover: (h) => hovers.push(h) },
    );
    return {
      p,
      b,
      batch,
      attachDropped,
      counts,
      hovers,
      installed,
      grant: (d: number, f: PickedFile[]) => granted({ dropId: d, files: f }),
    };
  }

  const dropEvent = (over: Record<string, unknown> = {}) => ({
    isTrusted: true,
    dataTransfer: {
      types: ["Files"],
      files: [{ name: "a.pdf", size: 5 }],
      items: { length: 1 },
      dropEffect: "none",
    },
    target: null,
    composedPath: () => [],
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...over,
  });

  it("a trusted drop of files makes chips at once, hides nothing from the preload and stops the editor", () => {
    const t = install();
    t.p.fire("dragenter", drag(["Files"], { count: 1 }));
    expect(t.b.classes.has(DRAGGING_CLASS)).toBe(true);
    const e = dropEvent();
    t.p.fire("drop", e);
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(t.attachDropped).toHaveBeenCalledWith([{ name: "a.pdf", size: 5 }]);
    expect(t.b.classes.has(DRAGGING_CLASS)).toBe(false);
    t.grant(1, [picked("a.pdf", 5)]);
    expect(t.batch.fill).toHaveBeenCalledWith([picked("a.pdf", 5)]);
  });

  it("does not count a script's drop or a drop of text, so the numbers stay in step with the preload's", () => {
    const t = install();
    t.p.fire("drop", dropEvent({ isTrusted: false }));
    t.p.fire(
      "drop",
      dropEvent({ dataTransfer: { types: ["text/plain"], files: [], dropEffect: "none" } }),
    );
    expect(t.attachDropped).not.toHaveBeenCalled();
    t.p.fire("drop", dropEvent());
    t.grant(1, [picked("a.pdf", 5)]);
    expect(t.batch.fill).toHaveBeenCalled();
  });

  it("Escape and a lost window end the overlay; disposing removes every listener", () => {
    const t = install();
    t.p.fire("dragenter", drag(["Files"]));
    t.p.fire("keydown", { key: "Escape" });
    expect(t.b.classes.has(DRAGGING_CLASS)).toBe(false);
    t.p.fire("dragenter", drag(["Files"]));
    t.p.fire("blur", {});
    expect(t.b.classes.has(DRAGGING_CLASS)).toBe(false);
    expect(t.hovers).toContain(null);
    t.installed.dispose();
    for (const type of ["dragenter", "dragleave", "dragover", "drop", "keydown", "blur"]) {
      expect(t.p.count(type)).toBe(0);
    }
  });
});

// --- Keys ---

describe("⇧⌘A", () => {
  const press = (over: Record<string, unknown>) => ({
    key: "a",
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

  it("is attach with shift and the command key, either spelling of the letter", () => {
    expect(isAttachShortcut(press({ key: "A", metaKey: true, shiftKey: true }))).toBe(true);
    expect(isAttachShortcut(press({ key: "a", ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("is not ⌘A (select all), nor ⌘Z or ⇧⌘Z, nor typing, nor an input method's key", () => {
    expect(isAttachShortcut(press({ metaKey: true }))).toBe(false);
    expect(isAttachShortcut(press({ key: "z", metaKey: true }))).toBe(false);
    expect(isAttachShortcut(press({ key: "Z", metaKey: true, shiftKey: true }))).toBe(false);
    expect(isAttachShortcut(press({ shiftKey: true }))).toBe(false);
    expect(
      isAttachShortcut(press({ key: "A", metaKey: true, shiftKey: true, isComposing: true })),
    ).toBe(false);
    expect(isAttachShortcut(press({ key: "A", metaKey: true, shiftKey: true, altKey: true }))).toBe(
      false,
    );
  });
});

// --- Open draft ---

describe("Open draft", () => {
  it("reopens the composer on that draft, with its files and the account's limit", async () => {
    const { createComposeStore } = await import("../src/renderer/compose.ts");
    const fake = fakeBackend({ limitBytes: 25_000_000 });
    const draft = {
      ...content({
        attachments: [{ id: "k", name: "k.pdf", size: 9, delivery: { kind: "inline" } }],
        inReplyTo: "<m@x>",
      }),
      id: "d7",
      version: 3,
      fingerprint: "f",
      updatedAtMs: 0,
    } as Draft;
    fake.raw.getDraft.mockResolvedValue(draft);
    fake.raw.listAttachments.mockResolvedValue([
      info("k", { state: "failed", reason: "Can't read this file" }),
    ]);
    const outbox = createRoot(() => createOutboxStore(fake.backend));
    const store = createRoot(() => createComposeStore(fake.backend, outbox));
    await store.openDraft("d7");
    const session = store.session();
    expect(session?.title).toBe("Reply");
    expect(session?.draft()?.id).toBe("d7");
    expect(session?.attachments().map((c) => c.name)).toEqual(["k.pdf"]);
    await later();
    expect(session?.attachments()[0]?.state).toBe("failed");
    expect(session?.problems()).toEqual(["k.pdf: Can't read this file"]);
    expect(fake.raw.prepareNew).toHaveBeenCalledWith("a1");
  });
});

describe("choosing the sender (ADR 0050)", () => {
  const other = { id: "a2", address: "other@example.com", displayName: "Other" };
  const otherSender = { accountId: "a2", from: { name: "Other", address: "other@example.com" } };

  it("what is saved next goes out from the chosen account", async () => {
    const t = setup();
    t.session.setSubject("Hi");
    await t.session.setSender(other);
    expect(t.session.sender()).toEqual(otherSender);
    await t.session.flush();
    expect(t.saved.at(-1)).toMatchObject(otherSender);
  });

  it("choosing a sender is not writing: nothing is saved for a message nobody touched", async () => {
    const t = setup();
    await t.session.setSender(other);
    await t.session.close();
    expect(t.saved).toEqual([]);
  });

  it("a reply stays with the account of its thread", async () => {
    const fake = fakeBackend();
    const outbox = createRoot(() => createOutboxStore(fake.backend));
    const session = createRoot(() =>
      createComposerSession(
        fake.backend,
        outbox,
        {
          title: "Reply",
          content: content({ threadId: "t1", inReplyTo: "<m@x>" }),
          existing: null,
        },
        () => {},
      ),
    );
    expect(session.canChangeSender).toBe(false);
    await session.setSender(other);
    expect(session.sender().accountId).toBe("a1");
  });

  it("the new account's limit applies, and limit news about the old one no longer does", async () => {
    const t = setup({ limitBytes: 100_000 });
    t.raw.prepareNew.mockResolvedValueOnce({ messageLimitBytes: 50 });
    t.session.attachPicked([picked("a.pdf", 500)]);
    await later();
    expect(t.session.notice()).toBeNull();
    await t.session.setSender(other);
    expect(t.raw.prepareNew).toHaveBeenCalledWith("a2");
    expect(t.session.notice()?.kind).toBe("tooLarge");
    t.emit({ type: "messageLimit", accountId: "a1", limitBytes: 100_000 });
    expect(t.session.notice()?.kind).toBe("tooLarge");
  });

  it("a file the old server refused is read again when the new one takes it", async () => {
    const t = setup({ limitBytes: 100 });
    t.session.attachPicked([picked("a.pdf", 500)]);
    await later();
    t.emit({
      type: "attachments",
      draftId: "d1",
      attachments: [
        info(t.session.attachments()[0]?.id ?? "", { name: "a.pdf", size: 500, state: "tooLarge" }),
      ],
    });
    const id = t.session.attachments()[0]?.id ?? "";
    t.raw.prepareNew.mockResolvedValueOnce({ messageLimitBytes: 10_000 });
    await t.session.setSender(other);
    await later();
    expect(t.raw.recaptureAttachment).toHaveBeenCalledWith("d1", id);
    expect(t.session.attachments().map((c) => c.state)).toEqual(["reading"]);
  });

  it("the answer about a sender changed again since is ignored", async () => {
    const t = setup({ limitBytes: 1000 });
    let answerFirst!: (v: { messageLimitBytes: number }) => void;
    t.raw.prepareNew.mockImplementationOnce(() => new Promise((r) => (answerFirst = r)) as never);
    const first = t.session.setSender(other);
    t.raw.prepareNew.mockResolvedValueOnce({ messageLimitBytes: 5000 });
    await t.session.setSender({ id: "a3", address: "third@example.com", displayName: "Third" });
    answerFirst({ messageLimitBytes: 1 });
    await first;
    t.session.attachPicked([picked("a.pdf", 500)]);
    await later();
    expect(t.session.notice()).toBeNull();
  });
});
