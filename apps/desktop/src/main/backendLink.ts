// Main's own line to the backend: to make a received file exist before main opens, previews or
// saves it (ADR 0043, rule 10), to hear the banners and the badge it shows (ADR 0071), and to pass
// on what was pressed on a banner or in the menu (ADR 0108). It is not the renderer's port and
// carries none of the page's events; the page never sees an answer that has a path in it, because
// none has.
import type { FetchReceivedOutcome } from "@matters/contracts";
import type { SourceOutcome } from "@matters/core";

const SOURCE_OUTCOMES: ReadonlySet<string> = new Set<SourceOutcome>([
  "saved",
  "cancelled",
  "gone",
  "offline",
  "signIn",
  "exists",
  "failed",
]);

/** The part of a `MessagePortMain` the link uses. */
export interface LinkPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (e: { data: unknown }) => void): unknown;
  start(): void;
}

export class BackendLink {
  private readonly port: LinkPort;
  private nextId = 0;
  private readonly waiting = new Map<
    string,
    (reply: { ok?: unknown; outcome?: unknown }) => void
  >();
  /** The saves running now and who hears their bytes (ADR 0145, rule 5). */
  private readonly sourceWatchers = new Map<string, (bytes: number, total: number) => void>();

  /** `onEvent` hears what the backend sends unasked: banners and the badge (ADR 0071). */
  constructor(port: LinkPort, onEvent: (data: unknown) => void = () => {}) {
    this.port = port;
    port.on("message", ({ data }) => {
      const reply = (data ?? {}) as { requestId?: unknown; ok?: unknown; outcome?: unknown };
      const progress = data as {
        type?: unknown;
        job?: unknown;
        bytes?: unknown;
        totalBytes?: unknown;
      };
      if (progress?.type === "sourceProgress" && typeof progress.job === "string") {
        const bytes = Number(progress.bytes);
        const total = Number(progress.totalBytes);
        if (Number.isFinite(bytes) && Number.isFinite(total))
          this.sourceWatchers.get(progress.job)?.(bytes, total);
        return;
      }
      if (typeof reply.requestId !== "string") {
        onEvent(data);
        return;
      }
      const resolve = this.waiting.get(reply.requestId);
      if (!resolve) return;
      this.waiting.delete(reply.requestId);
      resolve(reply);
    });
    port.start();
  }

  async fetchReceived(messageKey: number, partId: string): Promise<FetchReceivedOutcome> {
    const reply = await this.request({ type: "fetchReceived", messageKey, partId });
    return reply.ok === true ? outcomeOf(reply.outcome) : { kind: "failed" };
  }

  /**
   * Saves a message as the server has it to `target`, a path from main's own dialog (ADR 0145).
   * `job` names it for `stopSource`; `onBytes` hears its progress while it runs.
   */
  async saveSource(
    job: string,
    messageKey: number,
    target: string,
    overwrite: boolean,
    onBytes: (bytes: number, total: number) => void,
  ): Promise<SourceOutcome> {
    this.sourceWatchers.set(job, onBytes);
    try {
      const reply = await this.request({ type: "saveSource", job, messageKey, target, overwrite });
      const kind = (reply.outcome as { kind?: unknown } | null)?.kind;
      return reply.ok === true && typeof kind === "string" && SOURCE_OUTCOMES.has(kind)
        ? (kind as SourceOutcome)
        : "failed";
    } finally {
      this.sourceWatchers.delete(job);
    }
  }

  /** Stops a save; its temporary file is removed and nothing is left under the name. */
  async stopSource(job: string): Promise<void> {
    await this.request({ type: "stopSource", job });
  }

  /**
   * One request of the router's own (the page's requests, validated there the same way), and
   * whether it was done. Main sends only requests it built itself: no field comes from a page.
   */
  async send(request: { readonly type: string } & Record<string, unknown>): Promise<boolean> {
    return (await this.request(request)).ok === true;
  }

  private request(body: Record<string, unknown>): Promise<{ ok?: unknown; outcome?: unknown }> {
    const requestId = `m${++this.nextId}`;
    return new Promise((resolve) => {
      this.waiting.set(requestId, resolve);
      this.port.postMessage({ ...body, requestId });
    });
  }
}

function outcomeOf(value: unknown): FetchReceivedOutcome {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return kind === "done" || kind === "gone" || kind === "offline" ? { kind } : { kind: "failed" };
}
