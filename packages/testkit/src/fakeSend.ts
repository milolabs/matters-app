import type {
  Account,
  ComposedMessage,
  ComposeInput,
  ComposeRendererPort,
  Draft,
  DraftStorePort,
  MailSubmitPort,
  MailTarget,
  MessageComposerPort,
  MimeSource,
  OutboxPort,
  OutgoingCheck,
  RenderedMessage,
  SendLane,
  SendOperation,
  SendStateKind,
  SentCopy,
  SentFolderPort,
  SentMatch,
  StoredAttachment,
  SubmitEnvelope,
  SubmitResult,
  SubmitWatch,
} from "@matters/core";
import { isActive, laneOf, startSend } from "@matters/core";

export class InMemoryDraftStore implements DraftStorePort {
  private drafts = new Map<string, Draft>();

  async get(id: string): Promise<Draft | null> {
    return this.drafts.get(id) ?? null;
  }

  async put(draft: Draft): Promise<void> {
    this.drafts.set(draft.id, draft);
  }

  async delete(id: string): Promise<boolean> {
    return this.drafts.delete(id);
  }

  async list(): Promise<readonly Draft[]> {
    return [...this.drafts.values()].sort(
      (a, b) => b.updatedAtMs - a.updatedAtMs || (a.id < b.id ? -1 : 1),
    );
  }

  async findByThread(accountId: string, threadId: string): Promise<Draft | null> {
    return (
      (await this.list()).find((d) => d.accountId === accountId && d.threadId === threadId) ?? null
    );
  }

  async discardAccount(accountId: string): Promise<void> {
    for (const [id, d] of this.drafts) if (d.accountId === accountId) this.drafts.delete(id);
  }
}

const FINISHED: ReadonlySet<SendStateKind> = new Set(["succeeded", "voided", "cancelled"]);

export class InMemoryOutbox implements OutboxPort {
  private ops = new Map<string, SendOperation>();
  private mimes = new Map<string, Uint8Array>();
  private spools = new Map<string, { path: string; bytes: number }>();
  private order = 0;
  private readonly seq = new Map<string, number>();
  private readonly attachments: { forDraft(draftId: string): Promise<readonly StoredAttachment[]> };

  /** `attachments` lets a claim skip a send that waits for a file still being read. */
  constructor(attachments?: { forDraft(draftId: string): Promise<readonly StoredAttachment[]> }) {
    this.attachments = attachments ?? { forDraft: async () => [] };
  }

  private async waitsForFile(op: SendOperation): Promise<boolean> {
    return (await this.attachments.forDraft(op.draftId)).some((r) => r.state === "reading");
  }

  async enqueue(op: SendOperation): Promise<void> {
    if (this.ops.has(op.id)) throw new Error(`operation ${op.id} exists`);
    this.ops.set(op.id, op);
    this.seq.set(op.id, this.order++);
  }

  async get(id: string): Promise<SendOperation | null> {
    return this.ops.get(id) ?? null;
  }

  async update(op: SendOperation): Promise<void> {
    const stored = this.ops.get(op.id);
    // The size of the built message belongs to `setMime` / `setSpool`, as in the database.
    if (stored) this.ops.set(op.id, { ...op, mimeBytes: stored.mimeBytes });
  }

  async claimNext(nowMs: number, lane: SendLane): Promise<SendOperation | null> {
    const busy = new Set(
      [...this.ops.values()]
        .filter((o) => o.state.kind === "running" && laneOf(o) === "large")
        .map((o) => o.accountId),
    );
    const due = [...this.ops.values()]
      .filter(
        (o) =>
          o.state.kind === "pending" &&
          o.notBeforeMs <= nowMs &&
          laneOf(o) === lane &&
          !(lane === "large" && busy.has(o.accountId)),
      )
      .sort((a, b) => a.notBeforeMs - b.notBeforeMs || this.rank(a) - this.rank(b));
    for (const op of due) {
      if (await this.waitsForFile(op)) continue;
      const started = startSend(op, nowMs);
      if (!started) return null;
      this.ops.set(started.id, started);
      return started;
    }
    return null;
  }

  async nextDueMs(lane: SendLane): Promise<number | null> {
    let earliest: number | null = null;
    for (const o of this.ops.values()) {
      if (o.state.kind !== "pending" || laneOf(o) !== lane) continue;
      if (earliest !== null && o.notBeforeMs >= earliest) continue;
      if (await this.waitsForFile(o)) continue;
      earliest = o.notBeforeMs;
    }
    return earliest;
  }

  async listByState(kinds: readonly SendStateKind[]): Promise<readonly SendOperation[]> {
    return this.sorted((o) => kinds.includes(o.state.kind));
  }

  async listVisible(finishedSinceMs: number): Promise<readonly SendOperation[]> {
    return this.sorted(
      (o) =>
        isActive(o) ||
        ((o.state.kind === "succeeded" || o.state.kind === "voided") &&
          o.updatedAtMs >= finishedSinceMs),
    );
  }

  async activeForDraft(draftId: string): Promise<readonly SendOperation[]> {
    return this.sorted((o) => o.draftId === draftId && isActive(o));
  }

  async setMime(id: string, messageId: string, mime: Uint8Array): Promise<void> {
    const op = this.ops.get(id);
    if (!op) return;
    this.ops.set(id, { ...op, messageId, mimeBytes: mime.byteLength });
    this.mimes.set(id, mime);
  }

  async getMime(id: string): Promise<Uint8Array | null> {
    return this.mimes.get(id) ?? null;
  }

  async setSpool(id: string, messageId: string, path: string, bytes: number): Promise<void> {
    const op = this.ops.get(id);
    if (!op) return;
    this.ops.set(id, { ...op, messageId, mimeBytes: bytes });
    this.spools.set(id, { path, bytes });
  }

  async getSpool(id: string): Promise<{ path: string; bytes: number } | null> {
    return this.spools.get(id) ?? null;
  }

  async pruneFinished(beforeMs: number): Promise<number> {
    let n = 0;
    for (const [id, o] of this.ops) {
      if (FINISHED.has(o.state.kind) && o.updatedAtMs < beforeMs) {
        this.ops.delete(id);
        this.mimes.delete(id);
        this.spools.delete(id);
        n++;
      }
    }
    return n;
  }

  async discardAccount(accountId: string): Promise<void> {
    for (const [id, o] of this.ops) {
      if (o.accountId === accountId) {
        this.ops.delete(id);
        this.mimes.delete(id);
        this.spools.delete(id);
      }
    }
  }

  private rank(op: SendOperation): number {
    return this.seq.get(op.id) ?? 0;
  }

  private sorted(keep: (o: SendOperation) => boolean): SendOperation[] {
    return [...this.ops.values()]
      .filter(keep)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || this.rank(a) - this.rank(b));
  }
}

/** Markdown in, a recognisable fake out; `text` is the source, like the real renderer's. */
export class FakeComposeRenderer implements ComposeRendererPort {
  render(markdown: string): RenderedMessage {
    return { html: `<p>${markdown}</p>`, text: markdown };
  }
}

/** Deterministic MIME-ish bytes and ids; counts how often a message was built. */
export class FakeMessageComposer implements MessageComposerPort {
  composed = 0;
  async compose(input: ComposeInput): Promise<ComposedMessage> {
    this.composed++;
    const messageId = `<fake-${this.composed}@example.test>`;
    const raw = new TextEncoder().encode(
      `Message-ID: ${messageId}\r\nSubject: ${input.subject}\r\n\r\n${input.text}`,
    );
    return { raw, messageId };
  }
}

export interface FakeSubmission {
  readonly target: MailTarget;
  readonly envelope: SubmitEnvelope;
  /** The source as it was given, so a test can open it again. */
  readonly source: MimeSource;
  /** What the source held, read when the submission ran. */
  readonly raw: Uint8Array;
  readonly watch: SubmitWatch | undefined;
}

/**
 * Answers submissions as scripted; remembers what was handed over. Like the real adapter it
 * reads the whole source, reports progress per chunk, and awaits `beforeDataEnd` only for an
 * answer that follows the end of the data (accepted or unknown).
 */
export class FakeMailSubmit implements MailSubmitPort {
  readonly submissions: FakeSubmission[] = [];
  /** Results to return, first in first out; accepted when empty. */
  readonly script: SubmitResult[] = [];
  /** Awaited after the data was read and before it ends; an abort cuts it short. */
  gate: Promise<void> | null = null;
  /** With `gate`: only for messages of which this is true (default: all). */
  gateWhen: ((source: MimeSource) => boolean) | null = null;
  /** Awaited after the data ended and before the answer; an abort is ignored here. */
  gateAfterEnd: Promise<void> | null = null;
  readonly verified: MailTarget[] = [];
  /** What the server "announces" on connecting: a number, or null for none. Silent when unset. */
  serverLimit: number | null | undefined;

  async submit(
    target: MailTarget,
    envelope: SubmitEnvelope,
    source: MimeSource,
    watch?: SubmitWatch,
  ): Promise<SubmitResult> {
    if (this.serverLimit !== undefined) watch?.onServerLimit?.(this.serverLimit);
    const chunks: Uint8Array[] = [];
    let sent = 0;
    for await (const chunk of source.open()) {
      chunks.push(chunk);
      sent += chunk.byteLength;
      watch?.onProgress?.(sent, source.size);
    }
    const raw = new Uint8Array(sent);
    let at = 0;
    for (const c of chunks) {
      raw.set(c, at);
      at += c.byteLength;
    }
    this.submissions.push({ target, envelope, source, raw, watch });
    if (this.gate && (this.gateWhen?.(source) ?? true)) {
      const signal = watch?.signal;
      const aborted = new Promise<"aborted">((resolve) => {
        if (signal?.aborted) resolve("aborted");
        signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      if ((await Promise.race([this.gate, aborted])) === "aborted") return { kind: "aborted" };
    }
    const answer = this.script.shift() ?? { kind: "accepted", response: "250 queued" };
    if (answer.kind === "accepted" || answer.kind === "unknown") await watch?.beforeDataEnd?.();
    if (this.gateAfterEnd) await this.gateAfterEnd;
    return answer;
  }

  /** What `verify` answers; fine by default. */
  outgoing: OutgoingCheck = { ok: true };

  async verify(target: MailTarget): Promise<OutgoingCheck> {
    this.verified.push(target);
    return this.outgoing;
  }
}

/** A Sent folder in memory. `found` holds Message-IDs the provider "has" for searches. */
export class FakeSentFolder implements SentFolderPort {
  readonly appended: Uint8Array[] = [];
  readonly searches: string[] = [];
  readonly found = new Map<string, string>();
  failAppend: Error | null = null;
  uidValidity = "1";
  folderId = "Sent";
  private nextUid = 1;

  async append(account: Account, raw: Uint8Array): Promise<SentCopy> {
    if (this.failAppend) throw this.failAppend;
    this.appended.push(raw);
    const uid = this.nextUid++;
    return {
      providerId: `fake-sent-${uid}`,
      location: {
        accountId: account.id,
        folderId: this.folderId,
        uidValidity: this.uidValidity,
        uid,
      },
    };
  }

  /** The server files what its SMTP accepted in Sent by itself, as Zoho does (ADR 0092). */
  filesSentItself = false;
  /** Looks before the server's own copy is there; each search counts one. */
  filedAfterLooks = 0;

  async findByMessageId(account: Account, messageId: string): Promise<SentMatch | null> {
    this.searches.push(messageId);
    const providerId = this.found.get(messageId);
    if (providerId !== undefined) return { providerId };
    if (!this.filesSentItself) return null;
    if (this.filedAfterLooks > 0) {
      this.filedAfterLooks--;
      return null;
    }
    return {
      providerId: `filed-${messageId}`,
      location: {
        accountId: account.id,
        folderId: this.folderId,
        uidValidity: this.uidValidity,
        uid: 1000 + this.searches.length,
      },
    };
  }
}
