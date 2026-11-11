// Main's own line to the backend: to make a received file exist before main opens, previews or
// saves it (ADR 0043, rule 10), to hear the banners and the badge it shows (ADR 0071), and to pass
// on what was pressed on a banner or in the menu (ADR 0108). It is not the renderer's port and
// carries none of the page's events; the page never sees an answer that has a path in it, because
// none has.
import type { FetchReceivedOutcome } from "@matters/contracts";

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

  /** `onEvent` hears what the backend sends unasked: banners and the badge (ADR 0071). */
  constructor(port: LinkPort, onEvent: (data: unknown) => void = () => {}) {
    this.port = port;
    port.on("message", ({ data }) => {
      const reply = (data ?? {}) as { requestId?: unknown; ok?: unknown; outcome?: unknown };
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
