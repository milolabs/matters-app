import type { RpcPort } from "@matters/adapter-secrets";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Carries the sync worker's credential requests to the vault in main and the answers back. The
 * dedicated port to main stays here; the worker never holds it. Ids are renumbered so that a
 * restarted worker, which counts from 1 again, cannot be handed an answer meant for its
 * predecessor. The content (secrets included) is passed on unread and never logged.
 */
export class CredentialRelay {
  private readonly pending = new Map<number, (data: unknown) => void>();
  private counter = 0;
  private readonly port: Promise<RpcPort>;

  /** `port` arrives after start, so the relay waits for it. */
  constructor(port: Promise<RpcPort>) {
    this.port = port;
    void port.then((p) => p.onMessage((data) => this.fromMain(data)));
  }

  /** A request from a worker; `reply` delivers the answer to that same worker. */
  fromWorker(data: unknown, reply: (data: unknown) => void): void {
    if (!isRecord(data) || typeof data.id !== "number") return;
    const id = ++this.counter;
    const original = data.id;
    this.pending.set(id, (answer) =>
      reply(isRecord(answer) ? { ...answer, id: original } : answer),
    );
    void this.port.then((p) => p.postMessage({ ...data, id }));
  }

  private fromMain(data: unknown): void {
    if (!isRecord(data) || typeof data.id !== "number") return;
    const deliver = this.pending.get(data.id);
    if (!deliver) return;
    this.pending.delete(data.id);
    deliver(data);
  }
}
