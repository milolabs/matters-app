import type {
  Credential,
  CredentialAvailability,
  CredentialPort,
  MailErrorKind,
} from "@matters/core";
import { CredentialsUnavailableError, mailErrorKind } from "@matters/core";

/** The one thing both ends need from a message port; Electron and worker ports differ otherwise. */
export interface RpcPort {
  postMessage(message: unknown): void;
  onMessage(handler: (data: unknown) => void): void;
}

type Request =
  | { readonly id: number; readonly op: "availability" }
  | { readonly id: number; readonly op: "get" | "delete"; readonly accountId: string }
  | {
      readonly id: number;
      readonly op: "set";
      readonly accountId: string;
      readonly credential: Credential;
    };

type Response =
  | { readonly id: number; readonly ok: true; readonly value?: unknown }
  | {
      readonly id: number;
      readonly ok: false;
      readonly kind: MailErrorKind;
      readonly message: string;
    };

const mailKind = (kind: unknown): MailErrorKind => mailErrorKind({ kind });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** A credential of a known shape, or null: what crosses a process boundary is checked, never trusted. */
export function parseCredential(v: unknown): Credential | null {
  if (!isRecord(v)) return null;
  if (v.kind === "password" && typeof v.username === "string" && typeof v.password === "string") {
    return { kind: "password", username: v.username, password: v.password };
  }
  if (v.kind === "oauth2" && typeof v.accessToken === "string") {
    return {
      kind: "oauth2",
      accessToken: v.accessToken,
      ...(typeof v.refreshToken === "string" ? { refreshToken: v.refreshToken } : {}),
      ...(typeof v.expiresAtMs === "number" ? { expiresAtMs: v.expiresAtMs } : {}),
    };
  }
  return null;
}

function parseRequest(data: unknown): Request | null {
  if (!isRecord(data) || typeof data.id !== "number") return null;
  const { id, op, accountId } = data;
  if (op === "availability") return { id, op };
  if (typeof accountId !== "string" || accountId === "") return null;
  if (op === "get" || op === "delete") return { id, op, accountId };
  if (op === "set") {
    const credential = parseCredential(data.credential);
    return credential ? { id, op, accountId, credential } : null;
  }
  return null;
}

/**
 * Answers credential requests from the backend on `port` using `store`. Malformed messages are
 * dropped; failures go back as a kind and a message, never a stack or the request's content.
 */
export function serveCredentials(port: RpcPort, store: CredentialPort): void {
  port.onMessage(async (data) => {
    const request = parseRequest(data);
    if (!request) return;
    const reply = (response: Response) => port.postMessage(response);
    try {
      switch (request.op) {
        case "availability":
          return reply({ id: request.id, ok: true, value: await store.availability() });
        case "get":
          return reply({ id: request.id, ok: true, value: await store.get(request.accountId) });
        case "set":
          await store.set(request.accountId, request.credential);
          return reply({ id: request.id, ok: true });
        case "delete":
          await store.delete(request.accountId);
          return reply({ id: request.id, ok: true });
      }
    } catch (error) {
      reply({
        id: request.id,
        ok: false,
        kind: mailErrorKind(error),
        message: error instanceof Error ? error.message : "The credential store failed",
      });
    }
  });
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** `CredentialPort` for the backend: every call is a request over the port to the main process. */
export class RemoteCredentialPort implements CredentialPort {
  private readonly ready: Promise<RpcPort>;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  private counter = 0;

  /** `port` may still be on its way (the backend learns of it after start). */
  constructor(port: RpcPort | Promise<RpcPort>, timeoutMs = 30_000) {
    this.timeoutMs = timeoutMs;
    this.ready = Promise.resolve(port).then((p) => {
      p.onMessage((data) => this.onResponse(data));
      return p;
    });
  }

  availability(): Promise<CredentialAvailability> {
    return this.call({ op: "availability" }) as Promise<CredentialAvailability>;
  }

  async get(accountId: string): Promise<Credential | null> {
    return ((await this.call({ op: "get", accountId })) as Credential | null) ?? null;
  }

  async set(accountId: string, credential: Credential): Promise<void> {
    await this.call({ op: "set", accountId, credential });
  }

  async delete(accountId: string): Promise<void> {
    await this.call({ op: "delete", accountId });
  }

  /** Fails whatever is still waiting; the port is gone. */
  dispose(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CredentialsUnavailableError("The credential service is shutting down"));
      this.pending.delete(id);
    }
  }

  private async call(body: object): Promise<unknown> {
    const port = await this.ready;
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CredentialsUnavailableError("The credential service did not answer"));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      port.postMessage({ id, ...body });
    });
  }

  private onResponse(data: unknown): void {
    if (!isRecord(data) || typeof data.id !== "number") return;
    const waiting = this.pending.get(data.id);
    if (!waiting) return;
    this.pending.delete(data.id);
    clearTimeout(waiting.timer);
    if (data.ok === true) waiting.resolve(data.value);
    else {
      const message = typeof data.message === "string" ? data.message : "Credential error";
      waiting.reject(
        data.kind === "credentials"
          ? new CredentialsUnavailableError(message)
          : Object.assign(new Error(message), { kind: mailKind(data.kind) }),
      );
    }
  }
}
