import type { AttachmentInfo, PickedFile, ThreadMessage } from "@matters/contracts";
import type {
  Draft,
  DraftContent,
  LargeNotice,
  ReplyMode,
  ReplyRedirect,
  SendOperation,
} from "@matters/core";
import {
  ATTACHMENT_REASONS,
  describeBlocker,
  emptyDraftContent,
  encodedMessageBytes,
  formatRecipients,
  notifyIfLarge,
  ownWords,
  parseRecipients,
  sendBlockers,
} from "@matters/core";
import { batch, createMemo, createSignal } from "solid-js";
import {
  announceChange,
  applyInfo,
  type Chip,
  chipFromInfo,
  duplicateText,
  isDuplicate,
  listedAttachments,
  provisionalChip,
  refusalText,
  storedLike,
} from "./chips.ts";
import { type Backend, BackendError } from "./client.ts";
import { pasteImage, pickFiles } from "./files.ts";
import { type ForwardedFile, type ForwardPlan, planForward } from "./forward.ts";
import type { OutboxStore } from "./outbox.ts";
import { chipKey, type ProgressSink, progress } from "./progress.ts";
import { drawsRing, progressText } from "./receivedStrip.ts";

const AUTOSAVE_MS = 500;
/** How long the status line keeps a remark about a file (a folder, a duplicate). */
const STATUS_MS = 6000;
/** The longest Send waits for a dropped file's grant; it normally comes in milliseconds. */
const GRANT_WAIT_MS = 3000;

export type ComposeView = "write" | "both" | "preview";
/** A reply is written under its thread; a new message, a forward and an expanded reply cover the reader (ADR 0100). */
export type ComposePlacement = "inline" | "full";
export type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * The files of one drop, as chips that already exist. The grants arrive later, in the order of the
 * files; `fill` turns each chip into a real attachment, or takes it away with the reason.
 */
export interface DropBatch {
  fill(granted: readonly PickedFile[]): void;
}

export interface ComposerSession {
  readonly title: string;
  /** Where a new reply was sent other than to the sender; null for everything else (ADR 0042). */
  readonly redirect: ReplyRedirect | null;
  /** What a forward does not carry, a line each (ADR 0045, rules 11 and 12); empty otherwise. */
  readonly notices: readonly string[];
  readonly base: DraftContent;
  readonly initialBody: string;
  /** The account this goes out from, and the name and address it shows. */
  readonly sender: () => Pick<DraftContent, "accountId" | "from">;
  /** A reply stays with the account its thread belongs to (ADR 0050). */
  readonly canChangeSender: boolean;
  readonly to: () => string;
  readonly cc: () => string;
  readonly bcc: () => string;
  readonly subject: () => string;
  readonly body: () => string;
  readonly showCc: () => boolean;
  readonly view: () => ComposeView;
  /** Where the composer sits; a reply starts inline, under its thread. */
  readonly placement: () => ComposePlacement;
  readonly draft: () => Draft | null;
  readonly saveState: () => SaveState;
  readonly previewHtml: () => string;
  /** Addresses in To/Cc/Bcc that are not addresses. */
  readonly invalid: () => readonly string[];
  /** Why Send is blocked right now; empty when it may be pressed. */
  readonly problems: () => readonly string[];
  /** The files, in the order attached. A chip exists from the frame of the drop. */
  readonly attachments: () => readonly Chip[];
  /** "Heavy" or "too large" for the files and the account's limit; null when neither. */
  readonly notice: () => LargeNotice | null;
  /** A remark about a file the user offered (a folder, a duplicate); "" when there is none. */
  readonly attachStatus: () => string;
  /** What a screen reader hears about the files: state changes, never percentages. */
  readonly announcement: () => string;
  /** The latest send of this draft, if any (for the details). */
  readonly operation: () => SendOperation | undefined;
  readonly error: () => string;
  setTo(v: string): void;
  setCc(v: string): void;
  setBcc(v: string): void;
  setSubject(v: string): void;
  setBody(v: string): void;
  setShowCc(v: boolean): void;
  setView(v: ComposeView): void;
  /** Moves the composer, keeping everything typed (⤢ opens the full composer). */
  setPlacement(p: ComposePlacement): void;
  /** Sends from this account instead; resolves once its message limit is known and applied. */
  setSender(account: { id: string; address: string; displayName: string }): Promise<void>;
  /** The system's file dialog, then the chips. */
  pick(): Promise<void>;
  /** Files whose grants main already minted (a pick). */
  attachPicked(files: readonly PickedFile[]): void;
  /** Files of a drop: their chips now, their grants when `fill` is called. */
  attachDropped(files: readonly { name: string; size: number }[]): DropBatch;
  /** Pasted images: a chip each now, bytes to main, grants back. */
  pasteImages(blobs: readonly Blob[]): Promise<void>;
  /** Removing is immediate, also while the file is being read. */
  removeAttachment(id: string): void;
  /** "Use new version" and "Try again": the original is read again as a new attachment. */
  recapture(id: string): Promise<void>;
  /** Asks which originals changed since they were copied. */
  checkSources(): Promise<void>;
  /** Saves now (if anything was touched) and resolves when the backend has it. */
  flush(): Promise<void>;
  send(): Promise<SendOperation | null>;
  /** Closing keeps what was typed as a draft. */
  close(): Promise<void>;
  /** Deletes the draft too. */
  discard(): Promise<void>;
  dispose(): void;
}

/** Text of a list of people as a header would show it. */
const show = (list: DraftContent["to"]) => formatRecipients(list);

/**
 * One open composer: the fields, autosave (500 ms after the last change, and on close or send),
 * the preview and the send. A draft exists on the backend only after the user touched
 * something, so pressing `r` and then Escape leaves nothing behind. Attaching a file is a touch.
 */
export function createComposerSession(
  backend: Backend,
  outbox: OutboxStore,
  input: {
    title: string;
    content: DraftContent;
    existing: Draft | null;
    /** Set for a new reply that goes elsewhere than to the sender (ADR 0042, rule 5). */
    redirect?: ReplyRedirect | null;
    /** For a new forward: the files it starts with and what it leaves behind (ADR 0045). */
    forward?: ForwardPlan;
    /** The account's message limit; null while unknown. */
    limitBytes?: number | null;
  },
  onClosed: () => void,
  sink: ProgressSink = progress,
): ComposerSession {
  const start = input.existing ?? null;
  const base = start ? { ...start } : input.content;
  const canChangeSender = base.threadId === undefined && base.inReplyTo === "";
  const [sender, setSenderSignal] = createSignal<Pick<DraftContent, "accountId" | "from">>({
    accountId: base.accountId,
    from: base.from,
  });
  const [to, setToSignal] = createSignal(show(base.to));
  const [cc, setCcSignal] = createSignal(show(base.cc));
  const [bcc, setBccSignal] = createSignal(show(base.bcc));
  const [subject, setSubjectSignal] = createSignal(base.subject);
  const [body, setBodySignal] = createSignal(base.bodyMarkdown);
  const [showCc, setShowCc] = createSignal(base.cc.length > 0 || base.bcc.length > 0);
  const [view, setView] = createSignal<ComposeView>("write");
  const [placement, setPlacement] = createSignal<ComposePlacement>(
    base.inReplyTo !== "" && input.forward === undefined && base.forwarded !== true
      ? "inline"
      : "full",
  );
  const [draft, setDraft] = createSignal<Draft | null>(start);
  const [saveState, setSaveState] = createSignal<SaveState>(start ? "saved" : "idle");
  const [previewHtml, setPreviewHtml] = createSignal("");
  const [error, setError] = createSignal("");
  const [chips, setChips] = createSignal<readonly Chip[]>(
    start
      ? // A draft kept from before lists its files; their rows say how they are (read again below).
        (start.attachments ?? []).map((a) =>
          chipFromInfo({
            id: a.id,
            name: a.name,
            size: a.size,
            state: "ready",
            reason: null,
            canRetry: false,
            forwarded: false,
          }),
        )
      : // The files of a new forward are chips in the frame of the composer, before any request.
        (input.forward?.files ?? []).map((f) => provisionalChip(f.id, f.name, f.size, true)),
  );
  const [limitBytes, setLimitBytes] = createSignal<number | null>(input.limitBytes ?? null);
  const [attachStatus, setAttachStatus] = createSignal("");
  const [announcement, setAnnouncement] = createSignal("");

  // Files taken off the list stay off it, even when an event about their row arrives late.
  const removed = new Set<string>();
  // The adds in flight. Send waits for the rows, never for the copies.
  const adds = new Set<Promise<void>>();
  // Drops and pastes whose grants have not arrived yet: their chips have no row.
  const grantWaits = new Set<Promise<void>>();
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  let touched = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> = Promise.resolve();
  let renderSeq = 0;
  let disposed = false;

  const parsed = createMemo(() => ({
    to: parseRecipients(to()),
    cc: parseRecipients(cc()),
    bcc: parseRecipients(bcc()),
  }));

  const content = (): DraftContent => ({
    ...sender(),
    to: parsed().to.participants,
    cc: parsed().cc.participants,
    bcc: parsed().bcc.participants,
    subject: subject(),
    bodyMarkdown: body(),
    inReplyTo: base.inReplyTo,
    references: base.references,
    ...(base.threadId === undefined ? {} : { threadId: base.threadId }),
    ...(base.forwarded === true ? { forwarded: true } : {}),
    // Only files the backend has a row for: the draft is saved with them after they were added,
    // or Send would find a file "not attached yet".
    ...(chips().some((c) => c.added) ? { attachments: listedAttachments(chips()) } : {}),
  });

  const invalid = createMemo(() => [
    ...parsed().to.invalid,
    ...parsed().cc.invalid,
    ...parsed().bcc.invalid,
  ]);
  // Not a memo: it reads the files and the limit too, and it is cheap.
  const problems = () => [
    ...invalid().map((a) => `"${a}" is not a valid address.`),
    // A file whose add failed is on no row; the message must not go without it.
    ...chips()
      .filter((c) => !c.added && c.state === "failed")
      .map((c) => `${c.name}: ${c.reason ?? ATTACHMENT_REASONS.unreadable}`),
    ...sendBlockers(content(), {
      limitBytes: limitBytes(),
      attachments: storedLike(
        chips().filter((c) => c.added),
        sender().accountId,
        draft()?.id ?? "",
      ),
      carriers: [],
    })
      .filter((b) => b.kind !== "invalidAddress")
      .map(describeBlocker),
  ];
  // The one place that says "large" (ADR 0040, rule 3). It counts files not yet on the draft too.
  const notice = () =>
    notifyIfLarge(storedLike(chips(), sender().accountId, draft()?.id ?? ""), limitBytes(), []);

  function touch() {
    touched = true;
    setSaveState("idle");
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), AUTOSAVE_MS);
  }

  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!touched) return saving;
    saving = saving.then(async () => {
      if (disposed && !touched) return;
      setSaveState("saving");
      try {
        const saved = await backend.saveDraft({
          content: content(),
          ...(draft() ? { id: (draft() as Draft).id } : {}),
        });
        batch(() => {
          setDraft(saved);
          setSaveState("saved");
          setError("");
        });
      } catch (e) {
        setSaveState("error");
        setError(e instanceof BackendError ? e.message : "The draft could not be saved.");
      }
    });
    return saving;
  }

  // The preview asks the backend, which builds the message with the very function that sends it.
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  function renderPreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      const seq = ++renderSeq;
      void backend
        .renderPreview(body())
        .then((html) => {
          if (seq === renderSeq && !disposed) setPreviewHtml(html);
        })
        .catch(() => {});
    }, 0);
  }

  function changed() {
    touch();
    if (view() !== "write") renderPreview();
  }

  // --- Files (ADR 0041) ---

  function say(text: string) {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = null;
    setAttachStatus(text);
    if (text !== "") {
      statusTimer = setTimeout(() => {
        statusTimer = null;
        setAttachStatus("");
      }, STATUS_MS);
    }
  }

  /** Replaces chips by id and tells a screen reader about any state that changed. */
  function updateChips(update: (chip: Chip) => Chip) {
    const before = chips();
    const next = before.map(update);
    const notes: string[] = [];
    next.forEach((chip, i) => {
      const was = before[i];
      const note = announceChange(was, chip);
      if (note) notes.push(note);
      if (was?.state === "reading" && chip.state !== "reading") sink.forget(chipKey(chip.id));
    });
    batch(() => {
      setChips(next);
      if (notes.length > 0) setAnnouncement(notes.join(" "));
    });
  }

  function applyInfos(infos: readonly AttachmentInfo[]) {
    const byId = new Map(infos.map((i) => [i.id, i]));
    // A forwarded file is listed with the size its message gave, an estimate; the true size comes
    // when the copy ends, and the draft is saved with it (ADR 0045, rule 10).
    const resized = chips().some((chip) => {
      const info = byId.get(chip.id);
      return chip.added && info?.state === "ready" && info.size !== chip.size;
    });
    updateChips((chip) => {
      const info = byId.get(chip.id);
      return info && !removed.has(chip.id) ? applyInfo(chip, info) : chip;
    });
    if (resized && !disposed) touch();
  }

  function dropChips(ids: ReadonlySet<string>) {
    for (const id of ids) sink.forget(chipKey(id));
    setChips(chips().filter((c) => !ids.has(c.id)));
  }

  /**
   * Puts the rows on the draft. The draft has to exist first: attaching is a touch. `add` is the
   * request that makes the rows, and `reason` what a chip says when it could not be made.
   */
  function commit<T extends { id: string }>(
    items: readonly T[],
    add: (draftId: string, live: T[]) => Promise<readonly AttachmentInfo[]>,
    reason: string = ATTACHMENT_REASONS.unreadable,
  ) {
    const run = (async () => {
      try {
        touched = true;
        await flush();
        const saved = draft();
        if (!saved) throw new Error("The draft could not be saved.");
        const live = items.filter((i) => !removed.has(i.id));
        if (live.length === 0) return;
        applyInfos(await add(saved.id, live));
        touch();
      } catch {
        const ids = new Set(items.map((i) => i.id));
        updateChips((chip) =>
          ids.has(chip.id) && !chip.added ? { ...chip, state: "failed", reason } : chip,
        );
      }
    })();
    adds.add(run);
    void run.finally(() => adds.delete(run));
  }

  /** The files of a forward: their chips are there already, and the draft is made for their rows. */
  function commitForwarded(files: readonly ForwardedFile[]) {
    commit(
      files,
      (draftId, live) =>
        backend.addForwardedAttachments(
          draftId,
          live.map(({ id, messageKey, partId }) => ({ id, messageKey, partId })),
        ),
      ATTACHMENT_REASONS.download,
    );
  }

  /**
   * Waits for the rows of every file offered so far: the grants that are still on their way, and
   * the adds in flight. Never for the copies. A grant that does not come in time is given up on,
   * so Send cannot hang on it; `send` then reports the chip that has no row.
   */
  async function settleAdds() {
    const waits = () => [...adds, ...grantWaits];
    while (waits().length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const gaveUp = new Promise<"late">((r) => {
        timer = setTimeout(() => r("late"), GRANT_WAIT_MS);
      });
      const outcome = await Promise.race([
        Promise.all(waits()).then(() => "done" as const),
        gaveUp,
      ]);
      clearTimeout(timer);
      if (outcome === "late") break;
    }
  }

  /** Chips for files that have a name and a size; the ones already there are reported, not added. */
  function addChips(files: readonly { name: string; size: number }[]): (string | null)[] {
    const fresh: Chip[] = [];
    const notes: string[] = [];
    const ids = files.map((f) => {
      if (isDuplicate([...chips(), ...fresh], f.name, f.size)) {
        notes.push(duplicateText(f.name));
        return null;
      }
      const chip = provisionalChip(crypto.randomUUID(), f.name, f.size);
      fresh.push(chip);
      return chip.id;
    });
    if (fresh.length > 0) setChips([...chips(), ...fresh]);
    say(notes.join(" "));
    return ids;
  }

  /** The grants for chips that exist: the refused ones go, the rest are put on the draft. */
  function grantChips(ids: readonly (string | null)[], granted: readonly PickedFile[]) {
    const items: { id: string; grantId: string }[] = [];
    const gone = new Set<string>();
    const notes: string[] = [];
    ids.forEach((id, i) => {
      if (id === null) return;
      const file = granted[i];
      const refusal = file ? refusalText(file) : "That file could not be read.";
      if (!file || refusal !== null) {
        gone.add(id);
        if (refusal) notes.push(refusal);
        return;
      }
      if (removed.has(id)) return;
      items.push({ id, grantId: file.grantId });
      // The name and size main saw are the true ones.
      setChips(chips().map((c) => (c.id === id ? { ...c, name: file.name, size: file.size } : c)));
    });
    if (gone.size > 0) dropChips(gone);
    if (notes.length > 0) say([...new Set([attachStatus(), ...notes])].filter(Boolean).join(" "));
    if (items.length > 0) commit(items, (draftId, live) => backend.addAttachments(draftId, live));
  }

  function attachPicked(files: readonly PickedFile[]) {
    if (disposed) return;
    // A refused file gets no chip: its words go to the status line.
    const usable = files.filter((f) => f.kind === "file");
    const ids = addChips(usable.map((f) => ({ name: f.name, size: f.size })));
    const refusals = files.map(refusalText).filter((t): t is string => t !== null);
    if (refusals.length > 0)
      say([...new Set([attachStatus(), ...refusals])].filter(Boolean).join(" "));
    grantChips(ids, usable);
  }

  async function refreshFromBackend() {
    const saved = draft();
    if (!saved || chips().length === 0) return;
    try {
      applyInfos(await backend.listAttachments(saved.id));
      await checkSources();
    } catch {
      // The chips stay as the draft listed them.
    }
  }

  async function checkSources() {
    const saved = draft();
    if (!saved || disposed || !chips().some((c) => c.added && c.state === "ready")) return;
    try {
      const changedIds = new Set(await backend.checkAttachmentSources(saved.id));
      updateChips((chip) =>
        chip.changed === changedIds.has(chip.id)
          ? chip
          : { ...chip, changed: changedIds.has(chip.id) },
      );
    } catch {
      // Not knowing is the same as nothing having changed.
    }
  }

  const off = backend.onEvent((event) => {
    if (event.type === "attachments") {
      if (event.draftId === draft()?.id) applyInfos(event.attachments);
    } else if (event.type === "attachmentProgress") {
      // A trailing report can arrive after the `attachments` event that ended the reading.
      const chip = chips().find((c) => c.id === event.id);
      if (chip?.state === "reading") {
        sink.report(chipKey(chip.id), event.fraction, readingLabel(chip, event.fraction));
      }
    } else if (event.type === "messageLimit" && event.accountId === sender().accountId) {
      setLimitBytes(event.limitBytes);
    }
  });
  /** The words beside a ring. A forwarded file is downloaded, and under 1 MiB says only its size. */
  function readingLabel(chip: Chip, fraction: number): string | undefined {
    if (!chip.forwarded) return `Reading ${Math.floor(fraction * 100)}%`;
    return drawsRing(chip.size) ? progressText(fraction * chip.size, chip.size) : undefined;
  }

  // A file edited elsewhere is noticed when the user comes back to the window.
  const onFocus = () => void checkSources();
  if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
  void refreshFromBackend();
  if (!start && input.forward && input.forward.files.length > 0) {
    commitForwarded(input.forward.files);
  }

  /**
   * A forward nobody wrote in (ADR 0045, rule 13): no recipients, nothing typed above the quote,
   * the subject as it came. The quote is ours, so it never counts as what the person wrote, and
   * neither does taking files off.
   */
  const unwritten = () =>
    base.forwarded === true &&
    [to(), cc(), bcc()].every((field) => field.trim() === "") &&
    ownWords(body()) === "" &&
    subject() === (start ? base : input.content).subject;

  return {
    title: input.title,
    // A draft that exists keeps its recipients and says nothing (the backend sends null then).
    redirect: start ? null : (input.redirect ?? null),
    notices: start ? [] : (input.forward?.notices ?? []),
    base,
    initialBody: base.bodyMarkdown,
    sender,
    canChangeSender,
    to,
    cc,
    bcc,
    subject,
    body,
    showCc,
    view,
    placement,
    draft,
    saveState,
    previewHtml,
    invalid,
    problems,
    attachments: chips,
    notice,
    attachStatus,
    announcement,
    operation: () => {
      const d = draft();
      return d ? outbox.forDraft(d.id) : undefined;
    },
    error,
    setTo(v) {
      setToSignal(v);
      changed();
    },
    setCc(v) {
      setCcSignal(v);
      changed();
    },
    setBcc(v) {
      setBccSignal(v);
      changed();
    },
    setSubject(v) {
      setSubjectSignal(v);
      changed();
    },
    setBody(v) {
      if (v === body()) return;
      setBodySignal(v);
      changed();
    },
    setShowCc,
    setPlacement,
    setView(v) {
      setView(v);
      if (v !== "write") renderPreview();
    },
    async setSender(account) {
      if (!canChangeSender || account.id === sender().accountId) return;
      const { accountId, from } = emptyDraftContent(account);
      setSenderSignal({ accountId, from });
      // Choosing a sender is not writing: a message nobody wrote in still leaves nothing behind.
      if (touched || draft() !== null) touch();
      const limit = await backend
        .prepareNew(accountId)
        .then((p) => p.messageLimitBytes)
        .catch(() => null);
      if (disposed || sender().accountId !== accountId) return;
      setLimitBytes(limit);
      // A file the last account's server refused has no copy; this one may take it.
      for (const chip of chips()) {
        if (
          chip.added &&
          chip.state === "tooLarge" &&
          (limit === null || encodedMessageBytes([chip]) <= limit)
        ) {
          void this.recapture(chip.id);
        }
      }
    },
    async pick() {
      attachPicked(await pickFiles());
    },
    attachPicked,
    attachDropped(files) {
      if (disposed) return { fill: () => {} };
      const ids = addChips(files);
      let done!: () => void;
      const wait = new Promise<void>((r) => {
        done = r;
      });
      grantWaits.add(wait);
      return {
        fill: (granted) => {
          grantChips(ids, granted);
          grantWaits.delete(wait);
          done();
        },
      };
    },
    async pasteImages(blobs) {
      if (disposed) return;
      // Every chip first, in this frame; the bytes go to main one after the other.
      const ids = addChips(
        blobs.map((blob) => ({
          name: blob instanceof File && blob.name !== "" ? blob.name : "Pasted image",
          size: blob.size,
        })),
      );
      const waits = ids.map(() => {
        let done!: () => void;
        const wait = new Promise<void>((r) => {
          done = r;
        });
        grantWaits.add(wait);
        return { wait, done };
      });
      for (const [i, blob] of blobs.entries()) {
        const id = ids[i];
        const file = id ? await pasteImage(blob).catch(() => null) : null;
        if (id) grantChips([id], file ? [file] : []);
        const w = waits[i];
        if (w) {
          grantWaits.delete(w.wait);
          w.done();
        }
      }
    },
    removeAttachment(id) {
      removed.add(id);
      dropChips(new Set([id]));
      touch();
    },
    async recapture(id) {
      const saved = draft();
      if (!saved || disposed) return;
      try {
        const info = await backend.recaptureAttachment(saved.id, id);
        removed.add(id);
        setChips(chips().flatMap((c) => (c.id === id ? [chipFromInfo(info)] : [c])));
        sink.forget(chipKey(id));
        touch();
      } catch {
        say("That file could not be read again.");
      }
    },
    checkSources,
    flush,
    async send() {
      setError("");
      // The rows first (never the copies: a file still being read does not hold Send back), then
      // the draft with those files in it, then the approval of exactly that version.
      await settleAdds();
      const lost = chips().filter((c) => !c.added);
      if (problems().length > 0 || lost.length > 0) {
        setError(
          [
            ...problems(),
            ...lost
              .filter((c) => c.state !== "failed")
              .map((c) => `${c.name}: It is not attached yet.`),
          ].join(" "),
        );
        return null;
      }
      touched = true;
      await flush();
      const saved = draft();
      if (!saved || saveState() === "error") return null;
      try {
        const op = await backend.requestSend(saved.id);
        await onClosedAfterSend();
        return op;
      } catch (e) {
        setError(e instanceof BackendError ? e.message : "Sending did not start.");
        return null;
      }
    },
    async close() {
      await settleAdds();
      // Closing a forward nobody wrote in takes the draft and its copies with it.
      if (unwritten()) return this.discard();
      await flush();
      this.dispose();
      onClosed();
    },
    async discard() {
      await settleAdds();
      if (timer) clearTimeout(timer);
      timer = null;
      touched = false;
      await saving;
      const d = draft();
      if (d) await backend.deleteDraft(d.id).catch(() => {});
      this.dispose();
      onClosed();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      teardown();
    },
  };

  /** What the session subscribed to or started, apart from the autosave. */
  function teardown() {
    off();
    if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
    if (previewTimer) clearTimeout(previewTimer);
    if (statusTimer) clearTimeout(statusTimer);
    for (const chip of chips()) sink.forget(chipKey(chip.id));
  }

  async function onClosedAfterSend() {
    disposed = true;
    if (timer) clearTimeout(timer);
    teardown();
    onClosed();
  }
}

/** What a forward needs from the open thread: which view it is in, and the messages it shows. */
export interface ForwardFrom {
  /** The thread is looked at from Trash or Spam (ADR 0044). */
  readonly hidden: boolean;
  readonly messages: readonly ThreadMessage[];
}

/** What a new message may open with, from an offer of the agent (ADR 0102). Never saved by itself. */
export interface NewMessagePrefill {
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
}

export type OpenComposer = (
  mode: ReplyMode | "new" | "forward",
  accountId?: string,
  threadId?: string,
  forward?: ForwardFrom,
  prefill?: NewMessagePrefill,
) => Promise<void>;

const TITLES = { new: "New message", reply: "Reply", replyAll: "Reply to all", forward: "Forward" };

/** The title of a draft that is opened again, which knows no more than what is saved with it. */
export function titleOfDraft(draft: Pick<Draft, "forwarded" | "inReplyTo">): string {
  if (draft.forwarded === true) return TITLES.forward;
  return draft.inReplyTo !== "" ? TITLES.reply : TITLES.new;
}

export function createComposeStore(backend: Backend, outbox: OutboxStore) {
  const [session, setSession] = createSignal<ComposerSession | null>(null);
  const [problem, setProblem] = createSignal("");
  let opening = false;

  const open: OpenComposer = async (mode, accountId, threadId, forward, prefill) => {
    if (session() || opening) return;
    opening = true;
    setProblem("");
    try {
      const prepared =
        mode === "new"
          ? await backend.prepareNew(accountId)
          : mode === "forward"
            ? await backend.prepareForward(threadId ?? "", forward?.hidden === true)
            : await backend.prepareReply(threadId ?? "", mode);
      // The files are the quoted message's, which the open thread already shows.
      const plan =
        mode === "forward"
          ? planForward(
              forward?.messages.find((m) => m.key === prepared.forwardedKey),
              () => crypto.randomUUID(),
            )
          : undefined;
      setSession(
        createComposerSession(
          backend,
          outbox,
          {
            title: TITLES[mode],
            // A filled-in new message is not touched: it is saved only once the person writes.
            content:
              mode === "new" && prefill !== undefined
                ? {
                    ...prepared.content,
                    to: prefill.to.map((address) => ({ address })),
                    subject: prefill.subject,
                    bodyMarkdown: prefill.body,
                  }
                : prepared.content,
            existing: prepared.existing,
            redirect: prepared.redirect ?? null,
            limitBytes: prepared.messageLimitBytes,
            ...(plan ? { forward: plan } : {}),
          },
          () => setSession(null),
        ),
      );
    } catch (e) {
      setProblem(e instanceof BackendError ? e.message : "The message could not be started.");
    } finally {
      opening = false;
    }
  };

  /** "Open draft" in the tray: the composer on that draft, with its files. */
  async function openDraft(draftId: string) {
    if (session() || opening) return;
    opening = true;
    setProblem("");
    try {
      const existing = await backend.getDraft(draftId);
      // The limit is the account's; asking for a fresh message is the way to learn it.
      const limitBytes = await backend
        .prepareNew(existing.accountId)
        .then((p) => p.messageLimitBytes)
        .catch(() => null);
      setSession(
        createComposerSession(
          backend,
          outbox,
          { title: titleOfDraft(existing), content: existing, existing, limitBytes },
          () => setSession(null),
        ),
      );
    } catch (e) {
      setProblem(e instanceof BackendError ? e.message : "The draft could not be opened.");
    } finally {
      opening = false;
    }
  }

  return {
    session,
    open,
    openDraft,
    isOpen: () => session() !== null,
    problem,
    clearProblem: () => setProblem(""),
  };
}

export type ComposeStore = ReturnType<typeof createComposeStore>;
