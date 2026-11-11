import { encodedMessageBytes, type SendLane } from "../domain/attachment.ts";
import type { Draft, DraftContent, Sha256Hex } from "../domain/draft.ts";
import { createDraft, reviseDraft, SendBlockedError, sendBlockers } from "../domain/draft.ts";
import type { Account } from "../domain/entities.ts";
import {
  DraftNotFoundError,
  FileWorkError,
  isFileWorkError,
  scrubSecrets,
} from "../domain/errors.ts";
import { sameAddress } from "../domain/recipients.ts";
import type { SendOperation, SendResult } from "../domain/send.ts";
import {
  approve,
  cancelSend,
  checkApproval,
  describeCheck,
  finishSend,
  holdInterrupted,
  holdSend,
  interruptSend,
  laneOf,
  markDataEnded,
  markSent,
  newSendOperation,
  reconcileSend,
  requeueSend,
  sendAgain,
  UNDO_WINDOW_MS,
  voidSend,
  withMessageId,
  withWarning,
} from "../domain/send.ts";
import type {
  AccountStorePort,
  AttachmentCarrierPort,
  AttachmentStorePort,
  ComposeRendererPort,
  Credential,
  CredentialPort,
  DraftStorePort,
  FileWorkPort,
  MailConnectorPort,
  MailSubmitPort,
  MailTarget,
  MessageComposerPort,
  MessageStorePort,
  MimeSource,
  OutboxPort,
  SentCopy,
  SentFolderPort,
  SubmitWatch,
} from "../ports/index.ts";
import { toAccount } from "./accounts.ts";
import {
  type AttachmentDeps,
  bytesSource,
  dropAttachments,
  dropDraftAttachments,
  dropSpool,
} from "./attachments.ts";
import type { IngestDeps } from "./ingestDocuments.ts";
import { provisionalSentId, recordSentMessage } from "./recordSent.ts";

export interface DraftDeps {
  readonly drafts: DraftStorePort;
  readonly outbox: OutboxPort;
  readonly sha256: Sha256Hex;
  /** The rows of the draft's files, and the stored copies they stand for (ADR 0041). */
  readonly attachments: AttachmentStorePort;
  readonly files: FileWorkPort;
  newId(): string;
  now(): number;
  /** Length of the undo window; default 10 s. Tests shorten it, the app does not. */
  readonly undoWindowMs?: number;
}

export interface RequestSendDeps extends DraftDeps {
  readonly store: Pick<MessageStorePort, "getThread">;
  /** Tells which addresses are the user's own, and the largest message the server takes. */
  readonly accounts: Pick<AccountStorePort, "get">;
  /** Other ways to send a file (ADR 0040). The app passes none yet. */
  readonly carriers: readonly AttachmentCarrierPort[];
}

const DRAFT_CHANGED = describeCheck("draftChanged");

/**
 * Saves a draft (a new one when `id` is absent). A real change bumps the version, and voids a
 * send of the old version that is still waiting: editing after Send sends nothing.
 */
export async function saveDraft(
  deps: DraftDeps,
  input: { readonly id?: string; readonly content: DraftContent },
): Promise<Draft> {
  const current = input.id === undefined ? null : await deps.drafts.get(input.id);
  if (current === null) {
    const draft = createDraft(input.id ?? deps.newId(), input.content, deps.sha256, deps.now());
    await deps.drafts.put(draft);
    return draft;
  }
  const next = reviseDraft(current, input.content, deps.sha256, deps.now());
  if (next === current) return current;
  await deps.drafts.put(next);
  // The sender changed (ADR 0050): the files go with the draft, or removing the old account would
  // take them, and removing the new one would leave them behind.
  if (next.accountId !== current.accountId) {
    await deps.attachments.moveDraft(next.id, next.accountId);
  }
  for (const op of await deps.outbox.activeForDraft(next.id)) {
    if (op.state.kind === "pending" || op.state.kind === "held") {
      await deps.outbox.update(voidSend(op, DRAFT_CHANGED, deps.now()));
      await dropSpool(deps, op.id).catch(() => {});
    }
  }
  // Only files the saved draft listed before are dropped: a file added to the backend but not
  // yet in any saved content belongs to a newer edit than this save.
  const kept = new Set((next.attachments ?? []).map((a) => a.id));
  await dropAttachments(
    deps,
    (current.attachments ?? []).filter((a) => !kept.has(a.id)).map((a) => a.id),
  );
  return next;
}

export async function deleteDraft(deps: DraftDeps, id: string): Promise<boolean> {
  for (const op of await deps.outbox.activeForDraft(id)) {
    if (op.state.kind === "pending" || op.state.kind === "held") {
      await deps.outbox.update(cancelSend(op, deps.now()));
      await dropSpool(deps, op.id).catch(() => {});
    }
  }
  const removed = await deps.drafts.delete(id);
  await dropDraftAttachments(deps, id);
  return removed;
}

/**
 * The newest message key of the thread that the user did not send (ADR 0020, rule 2): the user's
 * own messages, including the local `sent:` entries, are not "new mail in the thread".
 */
async function threadContext(deps: RequestSendDeps, draft: Draft): Promise<number | null> {
  if (draft.threadId === undefined) return null;
  const view = await deps.store.getThread(draft.threadId);
  if (!view) return null;
  const own = [draft.from.address];
  const account = await deps.accounts.get(draft.accountId);
  if (account) own.push(account.address);
  let newest: number | null = null;
  for (const m of view.messages) {
    if (m.providerId === provisionalSentId(m.messageIdHeader)) continue;
    if (own.some((a) => sameAddress(a, m.from.address))) continue;
    if (newest === null || m.key > newest) newest = m.key;
  }
  return newest;
}

function summaryOf(draft: Draft): string {
  const to = [...draft.to, ...draft.cc, ...draft.bcc]
    .map((p) => (p.name && p.name !== "" ? p.name : p.address))
    .join(", ");
  return `${draft.subject.trim() === "" ? "(no subject)" : draft.subject.trim()} \u2192 ${to}`;
}

/**
 * Send pressed: approves this exact draft version and queues the hand-off for the end of the
 * undo window. Several operations may wait at once. Pressing again for a draft that already
 * waits with the same approval returns the waiting one. Throws `SendBlockedError` while
 * recipients are missing or `[placeholders]` remain.
 */
export async function requestSend(deps: RequestSendDeps, draftId: string): Promise<SendOperation> {
  const draft = await deps.drafts.get(draftId);
  if (!draft) throw new DraftNotFoundError();
  const rows = await deps.attachments.forDraft(draft.id);
  const account = await deps.accounts.get(draft.accountId);
  const blockers = sendBlockers(draft, {
    limitBytes: account?.messageLimitBytes ?? null,
    attachments: rows,
    carriers: deps.carriers,
  });
  if (blockers.length > 0) throw new SendBlockedError(blockers);

  const now = deps.now();
  const approval = approve(draft, await threadContext(deps, draft), now);
  for (const op of await deps.outbox.activeForDraft(draft.id)) {
    const same =
      op.approval.version === approval.version &&
      op.approval.fingerprint === approval.fingerprint &&
      op.approval.threadContext === approval.threadContext;
    if (same && op.state.kind !== "failed") return op;
    // An older approval of this draft is replaced by the new one.
    if (op.state.kind === "pending" || op.state.kind === "held" || op.state.kind === "failed") {
      await deps.outbox.update(cancelSend(op, now));
      await dropSpool(deps, op.id).catch(() => {});
    }
  }
  const listed = new Set((draft.attachments ?? []).map((a) => a.id));
  const op = newSendOperation({
    id: deps.newId(),
    approval,
    accountId: draft.accountId,
    summary: summaryOf(draft),
    nowMs: now,
    notBeforeMs: now + (deps.undoWindowMs ?? UNDO_WINDOW_MS),
    encodedBytes: encodedMessageBytes(rows.filter((r) => listed.has(r.id))),
  });
  await deps.outbox.enqueue(op);
  return op;
}

export type UndoResult = "cancelled" | "tooLate" | "notFound";

/** Undo while the operation still waits. Once the hand-off started it is too late. */
export async function undoSend(deps: DraftDeps, operationId: string): Promise<UndoResult> {
  const op = await deps.outbox.get(operationId);
  if (!op) return "notFound";
  if (op.state.kind !== "pending") return "tooLate";
  await deps.outbox.update(cancelSend(op, deps.now()));
  // A send waiting to try again after a lost connection already has its message built.
  await dropSpool(deps, op.id).catch(() => {});
  return "cancelled";
}

/** "Discard" on a held or failed operation (the draft stays). */
export async function discardSend(deps: DraftDeps, operationId: string): Promise<UndoResult> {
  const op = await deps.outbox.get(operationId);
  if (!op) return "notFound";
  const next = cancelSend(op, deps.now());
  if (next === op) return "tooLate";
  await deps.outbox.update(next);
  await dropSpool(deps, op.id).catch(() => {});
  return "cancelled";
}

/** "Send now" on a held operation, "Retry" on a failed one. */
export async function releaseSend(deps: DraftDeps, operationId: string): Promise<boolean> {
  const op = await deps.outbox.get(operationId);
  if (!op) return false;
  const next = requeueSend(op, deps.now());
  if (next === op) return false;
  await deps.outbox.update(next);
  return true;
}

/**
 * Start-up (ADR 0020, rule 5, narrowed by ADR 0041, rule 13): a send whose undo window ended
 * while the app was closed is held for the user. One that was running when the app stopped is
 * unknown if its data had ended, since it may have gone out; before that mark it did not, and
 * it is held like the others.
 */
export async function holdExpiredOnStartup(
  deps: Pick<DraftDeps, "outbox" | "now">,
): Promise<{ held: number; interrupted: number }> {
  const now = deps.now();
  let held = 0;
  let interrupted = 0;
  for (const op of await deps.outbox.listByState(["pending", "running"])) {
    const next =
      op.state.kind === "running"
        ? op.dataEnded
          ? interruptSend(op, now)
          : holdInterrupted(op, now)
        : holdSend(op, now);
    if (next === op) continue;
    await deps.outbox.update(next);
    if (next.state.kind === "held") held++;
    else interrupted++;
  }
  return { held, interrupted };
}

export interface ProcessDeps extends RequestSendDeps, AttachmentDeps {
  readonly drafts: DraftStorePort;
  readonly accounts: Pick<AccountStorePort, "get" | "setMessageLimit">;
  readonly credentials: CredentialPort;
  readonly renderer: ComposeRendererPort;
  readonly composer: MessageComposerPort;
  readonly submit: MailSubmitPort;
  readonly connector: MailConnectorPort;
  /** Writers for recording the sent message. */
  readonly ingest: IngestDeps;
  /**
   * A transfer is about to start and can be cut short with `controller.abort("stop" | "quit")`
   * until its data has ended (ADR 0041, rules 14 and 15). `onTransferEnd` follows, whatever
   * the outcome.
   */
  readonly onTransferStart?: (operationId: string, controller: AbortController) => void;
  readonly onTransferEnd?: (operationId: string) => void;
  /** Bytes of a message handed over so far. Not stored; the backend throttles it. */
  readonly onSendProgress?: (operationId: string, sentBytes: number, totalBytes: number) => void;
  /**
   * Waits between looks for a copy the server filed itself (ADR 0092). Absent: one look, no
   * wait.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** When to look for the server's own Sent copy before appending one (ADR 0092, rule 2). */
export const FILED_COPY_LOOKS_MS: readonly number[] = [0, 500, 1000];

/**
 * The copy the server filed in Sent by itself, if it did (ADR 0092). Zoho and others file what
 * their SMTP accepted, as Gmail does, and an APPEND then leaves a second copy. "filed" means
 * found, with no location to record yet: the sync brings it.
 */
async function filedByServer(
  deps: Pick<ProcessDeps, "sleep">,
  sent: SentFolderPort,
  account: Account,
  messageId: string,
): Promise<SentCopy | "filed" | null> {
  const looks = deps.sleep ? FILED_COPY_LOOKS_MS : [0];
  for (const wait of looks) {
    if (wait > 0) await deps.sleep?.(wait);
    const match = await sent.findByMessageId(account, messageId).catch(() => null);
    if (match)
      return match.location ? { providerId: match.providerId, location: match.location } : "filed";
  }
  return null;
}

function passwordOf(credential: Credential | null): string | null {
  return credential?.kind === "password" ? credential.password : null;
}

const reasonOf = (error: unknown, secrets: readonly string[]): string =>
  scrubSecrets(error instanceof Error ? error.message : String(error), secrets);

/**
 * The Sent copy and the local record of a send that went out. Failures become a warning. The
 * message is read into memory only for the APPEND, since ImapFlow takes it whole (ADR 0041,
 * rule 18).
 */
async function keepSentCopy(
  deps: ProcessDeps,
  op: SendOperation,
  draft: Draft,
  readRaw: () => Promise<Uint8Array>,
  messageId: string,
  text: string,
  dateMs: number,
  password: string | null,
): Promise<string | null> {
  let copy: SentCopy | undefined;
  let warning: string | null = null;
  const account = await deps.accounts.get(op.accountId);
  if (account) {
    try {
      const credential = await deps.credentials.get(op.accountId);
      if (credential) {
        const connection = await deps.connector.connect({ server: account.imap, credential });
        try {
          // Gmail saves sent mail itself; an APPEND would leave a duplicate. Other servers may
          // too, so their copy is looked for first (ADR 0092).
          if (!connection.sync.capabilities.has("savesSent")) {
            const to = toAccount(account);
            const filed = await filedByServer(deps, connection.sent, to, messageId);
            if (filed === null) copy = await connection.sent.append(to, await readRaw());
            else if (filed !== "filed") copy = filed;
          }
        } finally {
          await connection.close().catch(() => {});
        }
      }
    } catch (error) {
      warning = `Sent, but the copy could not be saved to your Sent folder: ${reasonOf(error, password ? [password] : [])}`;
    }
  }
  try {
    await recordSentMessage(deps.ingest, {
      content: draft,
      messageId,
      dateMs,
      text,
      hasAttachments: (draft.attachments?.length ?? 0) > 0,
      ...(copy ? { copy } : {}),
    });
  } catch (error) {
    warning ??= `Sent, but it could not be shown in the thread yet: ${reasonOf(error, [])}`;
  }
  return warning;
}

interface PreparedMessage {
  readonly source: MimeSource;
  /** The bytes themselves when they are small enough to live in the database; null for a spool. */
  readonly raw: Uint8Array | null;
  readonly spoolPath: string | null;
  readonly messageId: string;
  readonly text: string;
  readonly dateMs: number;
}

/**
 * Builds the message once and keeps it with the operation; later attempts reuse the bytes. With
 * no files that is a BLOB, as it always was; with files the message is streamed to a spool file
 * by the file work and only its path is kept (ADR 0041, rules 9 and 10).
 */
async function messageFor(
  deps: ProcessDeps,
  op: SendOperation,
  draft: Draft,
  rows: readonly StoredAttachmentRow[],
): Promise<PreparedMessage> {
  const rendered = deps.renderer.render(draft.bodyMarkdown);
  const listed = draft.attachments ?? [];
  if (listed.length === 0) {
    const stored = op.messageId === null ? null : await deps.outbox.getMime(op.id);
    if (stored && op.messageId) {
      return {
        source: bytesSource(stored),
        raw: stored,
        spoolPath: null,
        messageId: op.messageId,
        text: rendered.text,
        dateMs: deps.now(),
      };
    }
    const dateMs = deps.now();
    const composed = await deps.composer.compose(composeInput(draft, rendered, dateMs));
    await deps.outbox.setMime(op.id, composed.messageId, composed.raw);
    return {
      source: bytesSource(composed.raw),
      raw: composed.raw,
      spoolPath: null,
      messageId: composed.messageId,
      text: rendered.text,
      dateMs,
    };
  }

  const spool = op.messageId === null ? null : await deps.outbox.getSpool(op.id);
  if (spool && op.messageId) {
    // A spool the disk no longer has, or one of another size, is built again.
    const found = await deps.files.statSource(spool.path);
    if (found && found.size === spool.bytes) {
      return {
        source: deps.files.openSpool(spool.path),
        raw: null,
        spoolPath: spool.path,
        messageId: op.messageId,
        text: rendered.text,
        dateMs: deps.now(),
      };
    }
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parts = listed.map((file) => {
    const row = byId.get(file.id);
    if (row?.state !== "ready" || row.sha256 === null) {
      const why = row?.state === "reading" ? "is still being read" : "is missing";
      throw new FileWorkError("missing", `${file.name} ${why}`, file.name);
    }
    return { attachmentId: file.id, name: file.name, sha256: row.sha256 };
  });
  const dateMs = deps.now();
  const built = await deps.files.buildMessage(composeInput(draft, rendered, dateMs), parts, op.id);
  await deps.outbox.setSpool(op.id, built.messageId, built.spoolPath, built.bytes);
  return {
    source: deps.files.openSpool(built.spoolPath),
    raw: null,
    spoolPath: built.spoolPath,
    messageId: built.messageId,
    text: rendered.text,
    dateMs,
  };
}

type StoredAttachmentRow = Awaited<ReturnType<AttachmentStorePort["forDraft"]>>[number];

function composeInput(draft: Draft, rendered: { html: string; text: string }, dateMs: number) {
  return {
    from: draft.from,
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    html: rendered.html,
    text: rendered.text,
    dateMs,
  };
}

interface HandOffResult {
  readonly operation: SendOperation;
  /** What follows a delivered message: its Sent copy and clean-up. Resolves; never rejects. */
  readonly followUp: Promise<void>;
}

/**
 * The Sent copies of one lane go one after another, so only one message at a time is held in
 * memory for an APPEND (ADR 0041, rule 18). The other lane's are independent: a reply does not
 * wait for a large message's copy.
 */
const sentCopyChains = new WeakMap<object, Map<SendLane, Promise<void>>>();

function inSentCopyOrder(deps: ProcessDeps, lane: SendLane, task: () => Promise<void>) {
  const lanes = sentCopyChains.get(deps.outbox) ?? new Map<SendLane, Promise<void>>();
  sentCopyChains.set(deps.outbox, lanes);
  const next = (lanes.get(lane) ?? Promise.resolve()).then(task);
  lanes.set(lane, next);
  return next;
}

async function handOff(deps: ProcessDeps, claimed: SendOperation): Promise<HandOffResult> {
  let op = claimed;
  const save = async (next: SendOperation) => {
    op = next;
    await deps.outbox.update(op);
    deps.onChange?.(op);
  };
  deps.onChange?.(op);

  let password: string | null = null;
  let submitted = false;
  let followUp: Promise<void> = Promise.resolve();
  const controller = new AbortController();
  try {
    const draft = await deps.drafts.get(op.draftId);
    if (!draft) {
      await save(voidSend(op, "The draft was deleted", deps.now()));
      await dropSpool(deps, op.id).catch(() => {});
      return { operation: op, followUp };
    }
    const check = checkApproval(op.approval, draft, await threadContext(deps, draft));
    if (check !== "valid") {
      await save(voidSend(op, describeCheck(check), deps.now()));
      await dropSpool(deps, op.id).catch(() => {});
      return { operation: op, followUp };
    }
    const account = await deps.accounts.get(op.accountId);
    const rows = await deps.attachments.forDraft(draft.id);
    const blockers = sendBlockers(draft, {
      limitBytes: account?.messageLimitBytes ?? null,
      attachments: rows,
      carriers: deps.carriers,
    });
    const aboutFiles = blockers.filter(
      (b) => b.kind === "tooLarge" || b.kind === "attachmentProblem",
    );
    const aboutText = blockers.filter(
      (b) => b.kind !== "tooLarge" && b.kind !== "attachmentProblem",
    );
    if (aboutText.length > 0) {
      await save(voidSend(op, new SendBlockedError(aboutText).message, deps.now()));
      await dropSpool(deps, op.id).catch(() => {});
      return { operation: op, followUp };
    }
    if (aboutFiles.length > 0) {
      // A retry would meet the same file: only changing the draft helps.
      const reason = new SendBlockedError(aboutFiles).message;
      await save(finishSend(op, { kind: "failed", reason, action: "openDraft" }, deps.now()));
      return { operation: op, followUp };
    }

    if (!account) throw new Error("The account no longer exists");
    if (!account.smtp) throw new Error("No outgoing mail server is set up for this account");
    const credential = await deps.credentials.get(op.accountId);
    password = passwordOf(credential);
    if (!credential || password === null) throw new Error("The saved password is missing");

    const message = await messageFor(deps, op, draft, rows);
    op = { ...op, mimeBytes: message.source.size };
    if (op.messageId !== message.messageId) await save(withMessageId(op, message.messageId));

    const target: MailTarget = {
      server: account.smtp,
      credential: { kind: "password", username: account.smtp.username, password },
    };
    const envelope = {
      from: draft.from.address,
      recipients: [...draft.to, ...draft.cc, ...draft.bcc]
        .map((p) => p.address)
        .filter((a, i, all) => all.findIndex((b) => sameAddress(a, b)) === i),
      size: message.source.size,
    };
    const watch: SubmitWatch = {
      signal: controller.signal,
      onProgress: (sent, total) => deps.onSendProgress?.(op.id, sent, total),
      // Persisted before the last byte goes out, so a crash can be told apart (rule 13).
      beforeDataEnd: () => save(markDataEnded(op)),
      onServerLimit: (bytes) => {
        if (bytes === (account.messageLimitBytes ?? null)) return;
        deps.accounts.setMessageLimit(account.id, bytes).catch(() => {});
      },
    };
    let result: SendResult;
    let refused: readonly string[] = [];
    deps.onTransferStart?.(op.id, controller);
    try {
      const answer = await deps.submit.submit(target, envelope, message.source, watch);
      if (answer.kind === "accepted") refused = answer.refused ?? [];
      switch (answer.kind) {
        case "accepted":
          result = { kind: "succeeded", providerMessageId: message.messageId };
          break;
        case "rejected":
          result = {
            kind: "failed",
            reason: scrubSecrets(answer.reason, [password]),
            // The server will refuse it the same way every time.
            ...(answer.tooLarge || answer.code === 552 ? { action: "openDraft" as const } : {}),
          };
          break;
        case "interrupted":
          result = { kind: "interrupted", reason: scrubSecrets(answer.reason, [password]) };
          break;
        case "aborted":
          result = { kind: "aborted", why: controller.signal.reason === "quit" ? "quit" : "stop" };
          break;
        case "unknown":
          result = { kind: "unknown" };
          break;
      }
    } catch (error) {
      // The port promises typed results; a throw leaves the outcome open once the data ended,
      // and before that nothing can have been delivered.
      result = op.dataEnded
        ? { kind: "unknown" }
        : { kind: "failed", reason: reasonOf(error, [password]) };
    } finally {
      deps.onTransferEnd?.(op.id);
    }
    submitted = true;
    await save(finishSend(op, result, deps.now()));
    if (op.state.kind === "cancelled") await dropSpool(deps, op.id).catch(() => {});
    if (result.kind === "succeeded") {
      const sent = op;
      followUp = inSentCopyOrder(deps, laneOf(sent), async () => {
        try {
          const warning = await keepSentCopy(
            deps,
            sent,
            draft,
            () =>
              message.raw
                ? Promise.resolve(message.raw)
                : deps.files.readSpool(message.spoolPath ?? ""),
            message.messageId,
            message.text,
            message.dateMs,
            password,
          );
          await deps.drafts.delete(draft.id);
          await dropDraftAttachments(deps, draft.id).catch(() => {});
          await dropSpool(deps, sent.id).catch(() => {});
          const note = [
            refused.length > 0
              ? `The server refused ${refused.join(", ")}; the others got it.`
              : null,
            warning,
          ]
            .filter((w) => w !== null)
            .join(" ");
          if (note !== "") await save(withWarning(op, note));
        } catch (error) {
          await save(
            withWarning(op, `Sent, but a follow-up step failed: ${reasonOf(error, [])}`),
          ).catch(() => {});
        }
      });
    }
  } catch (error) {
    // Before the hand-off nothing reached the server: a definite failure, safe to retry. After
    // it, a storage error must not turn a delivered message into a retryable one.
    const reason = reasonOf(error, password ? [password] : []);
    const action = isFileWorkError(error) ? { action: "openDraft" as const } : {};
    if (!submitted)
      await save(finishSend(op, { kind: "failed", reason, ...action }, deps.now())).catch(() => {});
    else if (op.state.kind === "running")
      await save(finishSend(op, { kind: "unknown" }, deps.now())).catch(() => {});
    else
      await save(withWarning(op, `Sent, but a follow-up step failed: ${reason}`)).catch(() => {});
  }
  return { operation: op, followUp };
}

/** A pending send this long past its window is held instead of sent. */
export const OVERDUE_MS = 60_000;

/**
 * Hands off what is due in one lane (ADR 0041, rule 11): re-checks the approval (nothing is sent
 * when the draft or the thread changed), builds the MIME once, submits, appends to Sent unless
 * the provider saves it, records the sent message in its thread and moves the state. The small
 * lane goes one message at a time; the large lane one per account, concurrently, and claims
 * again as each ends. Returns when nothing more can start and every Sent copy has finished.
 */
export async function processOutbox(
  deps: ProcessDeps,
  options: { readonly lane: SendLane; readonly lateMs?: number },
): Promise<SendOperation[]> {
  const { lane } = options;
  // The computer may have slept through a window: mail never leaves hours late by surprise.
  const lateMs = options.lateMs ?? OVERDUE_MS;
  for (const op of await deps.outbox.listByState(["pending"])) {
    if (laneOf(op) !== lane || deps.now() - op.notBeforeMs <= lateMs) continue;
    // Time spent waiting for a file is not lateness; the file's end moves the window.
    const rows = await deps.attachments.forDraft(op.draftId);
    if (rows.some((r) => r.state === "reading")) continue;
    const held = holdSend(op, deps.now());
    await deps.outbox.update(held);
    deps.onChange?.(held);
  }
  const done: SendOperation[] = [];
  const followUps: Promise<void>[] = [];
  const take = (result: HandOffResult) => {
    done.push(result.operation);
    followUps.push(result.followUp);
  };
  if (lane === "small") {
    for (;;) {
      const claimed = await deps.outbox.claimNext(deps.now(), lane);
      if (!claimed) break;
      take(await handOff(deps, claimed));
    }
  } else {
    const running = new Set<Promise<void>>();
    for (;;) {
      for (;;) {
        const claimed = await deps.outbox.claimNext(deps.now(), lane);
        if (!claimed) break;
        const transfer: Promise<void> = handOff(deps, claimed)
          .then(take)
          .finally(() => running.delete(transfer));
        running.add(transfer);
      }
      if (running.size === 0) break;
      await Promise.race(running);
    }
  }
  await Promise.all(followUps);
  return done;
}

export interface ReconcileOptions {
  /** How long an unknown send may stay unfound before it counts as failed. */
  readonly graceMs: number;
}

export interface ReconcileReport {
  readonly resolved: number;
  /** Unknown operations of accounts whose provider cannot settle them: the user decides. */
  readonly leftToUser: number;
  /** Unknown operations still inside the grace period. */
  readonly waiting: number;
}

/**
 * Settles unknown sends where the provider can tell (ADR 0020, rule 8): Gmail keeps a copy of
 * what it accepted, so a search for the `Message-ID` decides; not found after the grace period
 * means it was not delivered. For other providers a missing Sent copy proves nothing, so the
 * operation stays unknown until the user chooses.
 */
export async function reconcileUnknown(
  deps: ProcessDeps,
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  let resolved = 0;
  let leftToUser = 0;
  let waiting = 0;
  for (const op of await deps.outbox.listByState(["unknown"])) {
    const account = await deps.accounts.get(op.accountId);
    const credential = await deps.credentials.get(op.accountId);
    if (!account || !credential || !op.messageId) {
      leftToUser++;
      continue;
    }
    let found: string | null = null;
    let canSettle = false;
    try {
      const connection = await deps.connector.connect({ server: account.imap, credential });
      try {
        canSettle = connection.sync.capabilities.has("savesSent");
        if (canSettle) {
          found =
            (await connection.sent.findByMessageId(toAccount(account), op.messageId))?.providerId ??
            null;
        }
      } finally {
        await connection.close().catch(() => {});
      }
    } catch {
      waiting++;
      continue;
    }
    if (!canSettle) {
      leftToUser++;
      continue;
    }
    const now = deps.now();
    if (found === null && now - (op.unknownSinceMs ?? now) < options.graceMs) {
      waiting++;
      continue;
    }
    const next = reconcileSend(op, found, now);
    await deps.outbox.update(next);
    deps.onChange?.(next);
    resolved++;
    if (found !== null) await recordAfterChoice(deps, next);
  }
  return { resolved, leftToUser, waiting };
}

async function recordAfterChoice(deps: ProcessDeps, op: SendOperation): Promise<void> {
  const draft = await deps.drafts.get(op.draftId);
  if (!draft || !op.messageId) return;
  const rendered = deps.renderer.render(draft.bodyMarkdown);
  await recordSentMessage(deps.ingest, {
    content: draft,
    messageId: op.messageId,
    dateMs: deps.now(),
    text: rendered.text,
    hasAttachments: (draft.attachments?.length ?? 0) > 0,
  }).catch(() => {});
  await deps.drafts.delete(draft.id);
  // The user settled it, so the spool an unknown send was keeping is no longer needed.
  await dropDraftAttachments(deps, draft.id).catch(() => {});
  await dropSpool(deps, op.id).catch(() => {});
}

export type UnknownChoice = "sendAgain" | "markSent";

/** The user settles an unknown send: it did go out, or send the very same message again. */
export async function resolveUnknown(
  deps: ProcessDeps,
  operationId: string,
  choice: UnknownChoice,
): Promise<boolean> {
  const op = await deps.outbox.get(operationId);
  if (op?.state.kind !== "unknown") return false;
  const next = choice === "markSent" ? markSent(op, deps.now()) : sendAgain(op, deps.now());
  await deps.outbox.update(next);
  deps.onChange?.(next);
  if (choice === "markSent") await recordAfterChoice(deps, next);
  return true;
}
