import type {
  FailureDetail,
  MailConnection,
  MailConnectorPort,
  MailTarget,
  MailWatch,
  MailWatchHandlers,
} from "@matters/core";
import { FakeMailFlags } from "./fakeFlags.ts";
import type { FakeMailSync } from "./fakeMailSync.ts";
import { FakeMailMoves } from "./fakeMoves.ts";
import { FakeMailAttachments } from "./fakeReceived.ts";
import { FakeSentFolder } from "./fakeSend.ts";

/** An error with a `kind`, like the adapters' typed errors. */
export class FakeMailError extends Error {
  readonly kind: string;
  readonly detail?: FailureDetail;
  constructor(kind: string, message = `fake ${kind} error`, detail?: FailureDetail) {
    super(message);
    this.kind = kind;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * A connector over one `FakeMailSync` server. Tests queue failures, trigger inbox changes
 * and drop the watch; it counts connections so tests can assert on reconnects.
 */
export class FakeMailConnector implements MailConnectorPort {
  readonly server: FakeMailSync;
  readonly sent = new FakeSentFolder();
  readonly flags = new FakeMailFlags();
  readonly moves = new FakeMailMoves();
  readonly attachments = new FakeMailAttachments();
  readonly connectErrors: unknown[] = [];
  readonly watchErrors: unknown[] = [];
  /** Passwords the server accepts; any when empty. */
  readonly acceptedPasswords = new Set<string>();
  /** What a refused sign-in says, as an adapter's `detail` (ADR 0114); none when undefined. */
  refusal: FailureDetail | undefined = undefined;
  connects = 0;
  aborts = 0;
  open = 0;
  watchesOpened = 0;
  watchesOpen = 0;
  /** Held back until a test calls `release()`. */
  gate: Promise<void> | null = null;
  private handlers: MailWatchHandlers | null = null;

  constructor(server: FakeMailSync) {
    this.server = server;
  }

  private check(target: MailTarget): void {
    if (
      this.acceptedPasswords.size > 0 &&
      (target.credential.kind !== "password" ||
        !this.acceptedPasswords.has(target.credential.password))
    ) {
      throw new FakeMailError("auth", "authentication failed", this.refusal);
    }
  }

  async connect(target: MailTarget): Promise<MailConnection> {
    this.connects++;
    if (this.gate) await this.gate;
    const failure = this.connectErrors.shift();
    if (failure) throw failure;
    this.check(target);
    this.open++;
    let closed = false;
    return {
      sync: this.server,
      sent: this.sent,
      flags: this.flags,
      moves: this.moves,
      attachments: this.attachments,
      close: async () => {
        if (!closed) this.open--;
        closed = true;
      },
      abort: () => {
        this.aborts++;
      },
    };
  }

  async watchInbox(target: MailTarget, handlers: MailWatchHandlers): Promise<MailWatch> {
    const failure = this.watchErrors.shift();
    if (failure) throw failure;
    this.check(target);
    this.watchesOpened++;
    this.watchesOpen++;
    this.handlers = handlers;
    return {
      close: async () => {
        if (this.handlers === handlers) {
          this.handlers = null;
          this.watchesOpen--;
        }
      },
    };
  }

  /** The server says the inbox changed. */
  change(): void {
    this.handlers?.onChange();
  }

  /** The watch connection died. */
  dropWatch(error?: unknown): void {
    const handlers = this.handlers;
    this.handlers = null;
    this.watchesOpen--;
    handlers?.onClosed(error);
  }

  hasWatch(): boolean {
    return this.handlers !== null;
  }
}
