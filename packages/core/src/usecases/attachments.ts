import type { AttachmentOrigin, StoredAttachment } from "../domain/attachment.ts";
import { ATTACHMENT_REASONS, encodedMessageBytes } from "../domain/attachment.ts";
import { DraftNotFoundError, isFileWorkError } from "../domain/errors.ts";
import type { ReceivedAttachment } from "../domain/received.ts";
import type { SendOperation } from "../domain/send.ts";
import { failSend } from "../domain/send.ts";
import type {
  AccountStorePort,
  AttachmentStorePort,
  CredentialPort,
  DraftStorePort,
  FileWorkPort,
  MailSubmitPort,
  MimeSource,
  OutboxPort,
} from "../ports/index.ts";
import type { FetchOutcome, FetchWatch } from "./receivedDownloads.ts";

/** A message already in memory, as a source: the plain, small case of ADR 0041, rule 9. */
export function bytesSource(bytes: Uint8Array): MimeSource {
  return {
    size: bytes.byteLength,
    open: () =>
      (async function* () {
        yield bytes;
      })(),
  };
}

/**
 * What forwarding a received file needs of the cache of ADR 0043 (ADR 0045, rule 7): to know the
 * part, to have it downloaded, and to find the copy that download left.
 */
export interface ForwardSource {
  /** The part as the message's structure lists it; null when it is not known. */
  attachment(messageKey: number, partId: string): Promise<ReceivedAttachment | null>;
  /** Downloads the part into the cache, or joins the download that is running. */
  fetch(messageKey: number, partId: string, watch?: FetchWatch): Promise<FetchOutcome>;
  /** The cache copy's path, for a capture to read. */
  locate(messageKey: number, partId: string): Promise<string | null>;
  /** The app is quitting, so a download that ended badly was cut short, not refused. */
  stopped(): boolean;
}

/**
 * The files being copied right now, so taking a chip off the draft can stop what is left of its
 * copy (ADR 0045, rule 6). Only the copy: a download it was waiting on is stopped by the cache's
 * own count of who still wants it.
 */
export class CopyBook {
  private readonly running = new Map<string, AbortController>();

  start(id: string): AbortSignal {
    const controller = new AbortController();
    this.running.set(id, controller);
    return controller.signal;
  }

  end(id: string): void {
    this.running.delete(id);
  }

  cancel(ids: readonly string[]): void {
    for (const id of ids) this.running.get(id)?.abort();
  }
}

export interface AttachmentDeps {
  readonly drafts: Pick<DraftStorePort, "get">;
  readonly outbox: OutboxPort;
  readonly attachments: AttachmentStorePort;
  readonly files: FileWorkPort;
  readonly accounts: Pick<AccountStorePort, "get">;
  newId(): string;
  now(): number;
  /** An operation changed; the UI hears about it. */
  readonly onChange?: (operation: SendOperation) => void;
  /** The files of a draft changed (a row was added, finished or failed). */
  readonly onAttachmentsChanged?: (draftId: string) => void;
  /** A copy is this far along. Called as often as the file work reports; the backend throttles. */
  readonly onAttachmentProgress?: (attachmentId: string, fraction: number) => void;
  /** Something a waiting send needed is ready: look at the outbox again. */
  readonly wakeOutbox?: () => void;
  /** Where forwarded files come from (ADR 0045). Without it they fail to download. */
  readonly forward?: ForwardSource;
  /** Lets a removal reach a copy that is still running. */
  readonly copies?: CopyBook;
}

export interface NewAttachment {
  /** Made by the renderer, so the chip exists before the backend answers. */
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly sourcePath: string;
}

/** A part of a received message put on a draft as a file (ADR 0045, rule 6). */
export interface NewForwarded {
  /** Made by the renderer, like any other chip's. */
  readonly id: string;
  readonly origin: AttachmentOrigin;
}

export interface AddedAttachments {
  readonly attachments: readonly StoredAttachment[];
  /** Resolves when every copy started here has ended, well or not. Never rejects. */
  readonly settled: Promise<void>;
}

/** The words for a copy that failed (ADR 0041, rule 23). */
function reasonFor(error: unknown): string {
  if (isFileWorkError(error)) {
    if (error.kind === "noSpace") return ATTACHMENT_REASONS.noSpace;
    if (error.kind === "isDirectory") return ATTACHMENT_REASONS.isDirectory;
  }
  return ATTACHMENT_REASONS.unreadable;
}

/** What a row starts from, whether the file is an original on disk or a part of a message. */
interface Wanted {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly sourcePath: string | null;
  readonly origin: AttachmentOrigin | null;
}

/**
 * Puts files on a draft. Each gets a row at once and its copy is started without waiting for it
 * (ADR 0041, rules 1 and 6). A file that alone is over the account's known limit is not copied:
 * it stays as a chip, and `notifyIfLarge` says why.
 */
export async function addAttachments(
  deps: AttachmentDeps,
  draftId: string,
  files: readonly NewAttachment[],
): Promise<AddedAttachments> {
  return addRows(
    deps,
    draftId,
    files.map((f) => ({ ...f, origin: null })),
  );
}

/**
 * Puts parts of a received message on a draft (ADR 0045, rules 6, 7 and 10). Name and size are the
 * message's own, as its structure lists them, and the size is an estimate until the copy ends. A
 * part the message does not have is left out. Each part is downloaded through the cache and then
 * captured, so the draft owns a copy the cache's sweep cannot touch.
 */
export async function addForwardedAttachments(
  deps: AttachmentDeps,
  draftId: string,
  files: readonly NewForwarded[],
): Promise<AddedAttachments> {
  const wanted: Wanted[] = [];
  for (const file of files) {
    const part = await deps.forward?.attachment(file.origin.messageKey, file.origin.partId);
    if (!part) continue;
    wanted.push({
      id: file.id,
      name: part.name,
      size: part.size,
      sourcePath: null,
      origin: file.origin,
    });
  }
  return addRows(deps, draftId, wanted);
}

async function addRows(
  deps: AttachmentDeps,
  draftId: string,
  files: readonly Wanted[],
): Promise<AddedAttachments> {
  const draft = await deps.drafts.get(draftId);
  if (!draft) throw new DraftNotFoundError();
  const limit = (await deps.accounts.get(draft.accountId))?.messageLimitBytes ?? null;
  const rows: StoredAttachment[] = [];
  const copying: StoredAttachment[] = [];
  for (const file of files) {
    // The same id again is the same request: a renderer that asks twice changes nothing.
    const existing = await deps.attachments.get(file.id);
    if (existing) {
      rows.push(existing);
      continue;
    }
    const tooLarge = limit !== null && encodedMessageBytes([file]) > limit;
    const row: StoredAttachment = {
      id: file.id,
      draftId,
      accountId: draft.accountId,
      name: file.name,
      size: file.size,
      state: tooLarge ? "tooLarge" : "reading",
      reason: tooLarge ? ATTACHMENT_REASONS.tooLarge : null,
      sha256: null,
      sourcePath: file.sourcePath,
      sourceMtimeMs: null,
      origin: file.origin,
      createdAtMs: deps.now(),
    };
    await deps.attachments.add(row);
    rows.push(row);
    if (!tooLarge) copying.push(row);
  }
  deps.onAttachmentsChanged?.(draftId);
  return { attachments: rows, settled: copyAll(deps, copying) };
}

async function copyAll(deps: AttachmentDeps, rows: readonly StoredAttachment[]): Promise<void> {
  await Promise.all(rows.map((row) => copyOne(deps, row)));
}

/** Copies one file and records how it went. Nothing escapes: the row says what happened. */
function copyOne(deps: AttachmentDeps, row: StoredAttachment): Promise<void> {
  return row.origin === null ? captureOne(deps, row) : forwardOne(deps, row, row.origin);
}

async function captureOne(deps: AttachmentDeps, row: StoredAttachment): Promise<void> {
  try {
    const done = await deps.files.capture(
      { attachmentId: row.id, sourcePath: row.sourcePath ?? "" },
      (fraction) => deps.onAttachmentProgress?.(row.id, fraction),
    );
    await settle(deps, row.id, {
      state: "ready",
      reason: null,
      sha256: done.sha256,
      size: done.size,
      sourceMtimeMs: done.sourceMtimeMs,
    });
  } catch (error) {
    await settle(deps, row.id, { state: "failed", reason: reasonFor(error) }).catch(() => {});
  }
}

/**
 * A forwarded file: downloaded through the cache, then captured from the cache copy like any
 * other file (ADR 0045, rule 7). The row is `reading` throughout, so ADR 0041's rules 7 and 8
 * hold without a change. One ring tells it, and the download is what fills it: the capture is a
 * clone and takes no time worth showing.
 */
async function forwardOne(
  deps: AttachmentDeps,
  row: StoredAttachment,
  origin: AttachmentOrigin,
): Promise<void> {
  const signal = deps.copies?.start(row.id);
  try {
    const fetched = await deps.forward?.fetch(origin.messageKey, origin.partId, {
      ...(signal ? { signal } : {}),
      onBytes: (bytes, total) =>
        deps.onAttachmentProgress?.(row.id, total <= 0 ? 0 : Math.min(1, bytes / total)),
    });
    // Removed, or the app is quitting: the row stays as it is, and start-up picks it up again.
    if (fetched?.kind === "cancelled" || signal?.aborted) return;
    if (fetched?.kind !== "done") {
      if (deps.forward?.stopped()) return;
      const reason =
        fetched?.kind === "gone" ? ATTACHMENT_REASONS.gone : ATTACHMENT_REASONS.download;
      await settle(deps, row.id, { state: "failed", reason });
      return;
    }
    const sourcePath = await deps.forward?.locate(origin.messageKey, origin.partId);
    if (!sourcePath) {
      await settle(deps, row.id, { state: "failed", reason: ATTACHMENT_REASONS.download });
      return;
    }
    const done = await deps.files.capture({ attachmentId: row.id, sourcePath }, () => {}, signal);
    await settle(deps, row.id, {
      state: "ready",
      reason: null,
      sha256: done.sha256,
      size: done.size,
    });
  } catch (error) {
    if (signal?.aborted) return;
    // A cache copy that cannot be read is a download that did not work out, not the user's file.
    const why = reasonFor(error);
    const reason = why === ATTACHMENT_REASONS.unreadable ? ATTACHMENT_REASONS.download : why;
    await settle(deps, row.id, { state: "failed", reason }).catch(() => {});
  } finally {
    deps.copies?.end(row.id);
  }
}

async function settle(
  deps: AttachmentDeps,
  id: string,
  patch: Partial<StoredAttachment>,
): Promise<void> {
  const current = await deps.attachments.get(id);
  if (!current) {
    // Removed from the draft while it was being read: nobody wants the copy.
    await deps.files.removeAttachments([id]).catch(() => {});
    return;
  }
  if (current.state !== "reading") return;
  const next = { ...current, ...patch };
  await deps.attachments.update(next);
  if (next.state === "ready") await releaseWaiting(deps, next.draftId);
  else await failWaiting(deps, next);
  deps.onAttachmentsChanged?.(next.draftId);
}

/** The last file a waiting send needed is ready: its window may have passed meanwhile. */
async function releaseWaiting(deps: AttachmentDeps, draftId: string): Promise<void> {
  const rows = await deps.attachments.forDraft(draftId);
  if (rows.some((r) => r.state === "reading")) return;
  const now = deps.now();
  for (const op of await deps.outbox.activeForDraft(draftId)) {
    // `processOutbox` holds what is long past its window; the wait was not the user's doing.
    if (op.state.kind === "pending" && op.notBeforeMs < now) {
      await deps.outbox.update({ ...op, notBeforeMs: now });
    }
  }
  deps.wakeOutbox?.();
}

/** A message never goes out without a file the user attached (ADR 0041, rule 8). */
async function failWaiting(deps: AttachmentDeps, row: StoredAttachment): Promise<void> {
  const draft = await deps.drafts.get(row.draftId);
  if (!draft?.attachments?.some((a) => a.id === row.id)) return;
  for (const op of await deps.outbox.activeForDraft(row.draftId)) {
    const next = failSend(
      op,
      `${row.name}: ${row.reason ?? ATTACHMENT_REASONS.unreadable}`,
      deps.now(),
      "openDraft",
    );
    if (next === op) continue;
    await deps.outbox.update(next);
    deps.onChange?.(next);
  }
}

/**
 * Start-up: a copy that was running when the app stopped starts again from its original, or for a
 * forwarded file from its message (it downloads again if the cache lost it); one with nothing to
 * read from fails.
 */
export async function resumeCaptures(
  deps: AttachmentDeps,
): Promise<{ resumed: number; failed: number; settled: Promise<void> }> {
  const resuming: StoredAttachment[] = [];
  let failed = 0;
  for (const row of await deps.attachments.listByState(["reading"])) {
    if (row.origin !== null || (row.sourcePath !== null && row.sourcePath !== "")) {
      resuming.push(row);
      continue;
    }
    failed++;
    await settle(deps, row.id, { state: "failed", reason: ATTACHMENT_REASONS.unreadable });
  }
  return { resumed: resuming.length, failed, settled: copyAll(deps, resuming) };
}

/**
 * The files of this draft whose original is no longer what was copied: the size or the
 * modification time differs. A missing original is not a change; the copy is still good.
 */
export async function checkAttachmentSources(
  deps: Pick<AttachmentDeps, "attachments" | "files">,
  draftId: string,
): Promise<string[]> {
  const changed: string[] = [];
  for (const row of await deps.attachments.forDraft(draftId)) {
    if (row.state !== "ready" || row.sourcePath === null) continue;
    const now = await deps.files.statSource(row.sourcePath);
    if (now && (now.mtimeMs !== row.sourceMtimeMs || now.size !== row.size)) changed.push(row.id);
  }
  return changed;
}

/**
 * "Use new version" and "Try again": reads the original again as a new attachment with a new id,
 * because an id names one immutable copy. The old row goes when the draft is saved without it.
 * A forwarded file starts over from its message (ADR 0045, rule 8), never from the cache path it
 * was once read from, which may be gone.
 */
export async function recaptureAttachment(
  deps: AttachmentDeps,
  draftId: string,
  id: string,
): Promise<AddedAttachments | null> {
  const old = await deps.attachments.get(id);
  if (!old || old.draftId !== draftId) return null;
  if (old.sourcePath === null && old.origin === null) return null;
  const row: StoredAttachment = {
    ...old,
    id: deps.newId(),
    state: "reading",
    reason: null,
    sha256: null,
    sourceMtimeMs: null,
    createdAtMs: deps.now(),
  };
  await deps.attachments.add(row);
  deps.onAttachmentsChanged?.(draftId);
  return { attachments: [row], settled: copyAll(deps, [row]) };
}

/** Rows and stored copies of these attachments go. */
export async function dropAttachments(
  deps: Pick<AttachmentDeps, "attachments" | "files" | "copies">,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  // A copy that is still running stops; a download it waited for is its cache's to keep or stop.
  deps.copies?.cancel(ids);
  await deps.attachments.remove(ids);
  await deps.files.removeAttachments(ids);
}

/** Everything a draft keeps in the data directory goes: it was sent or discarded. */
export async function dropDraftAttachments(
  deps: Pick<AttachmentDeps, "attachments" | "files" | "copies">,
  draftId: string,
): Promise<void> {
  const rows = await deps.attachments.forDraft(draftId);
  await dropAttachments(
    deps,
    rows.map((r) => r.id),
  );
}

/** The spool of an operation goes, if it has one. */
export async function dropSpool(
  deps: Pick<AttachmentDeps, "outbox" | "files">,
  operationId: string,
): Promise<void> {
  const spool = await deps.outbox.getSpool(operationId);
  if (spool) await deps.files.removeSpool(spool.path);
}

const LIVE_OPERATIONS = ["pending", "held", "running", "failed", "unknown"] as const;

/**
 * Start-up (ADR 0041, rule 19): rows whose draft is gone are dropped, then every stored copy and
 * spool that nothing refers to is deleted. A spool stays for any send that can still happen,
 * an unknown one included.
 */
export async function sweepAttachmentFiles(deps: AttachmentDeps): Promise<void> {
  const rows = await deps.attachments.listByState(["reading", "ready", "failed", "tooLarge"]);
  const orphans: string[] = [];
  for (const row of rows) {
    if ((await deps.drafts.get(row.draftId)) === null) orphans.push(row.id);
  }
  await dropAttachments(deps, orphans);
  const keepSpools: string[] = [];
  for (const op of await deps.outbox.listByState(LIVE_OPERATIONS)) {
    const spool = await deps.outbox.getSpool(op.id);
    if (spool) keepSpools.push(spool.path);
  }
  await deps.files.sweep(await deps.attachments.allIds(), keepSpools);
}

export interface ProbeLimitDeps {
  readonly accounts: Pick<AccountStorePort, "get" | "setMessageLimit">;
  readonly credentials: CredentialPort;
  readonly submit: Pick<MailSubmitPort, "verify">;
}

/**
 * Asks the outgoing server what it takes, by logging in and reading its greeting, and keeps the
 * answer (ADR 0040, rule 4). For an account whose limit is not known yet, so the composer can
 * say `tooLarge` before the first send. Null when the server announces none or cannot be asked.
 */
export async function probeMessageLimit(
  deps: ProbeLimitDeps,
  accountId: string,
): Promise<number | null> {
  const account = await deps.accounts.get(accountId);
  if (!account?.smtp) return null;
  const credential = await deps.credentials.get(accountId);
  if (credential?.kind !== "password") return null;
  const check = await deps.submit.verify({
    server: account.smtp,
    credential: {
      kind: "password",
      username: account.smtp.username,
      password: credential.password,
    },
  });
  if (!check.ok || check.limitBytes === undefined) return null;
  await deps.accounts.setMessageLimit(accountId, check.limitBytes);
  return check.limitBytes;
}
