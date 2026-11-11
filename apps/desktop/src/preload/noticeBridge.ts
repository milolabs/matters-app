// Settings › Notifications asks main what only main knows about the system's banners, and to open
// the system's own notification settings (ADR 0108). Like the other bridges it exposes nothing:
// the page posts a request, the preload checks its shape and asks main, which answers only the
// settings window. The page never names a URL; main opens a fixed one.

export const CHANNEL_NOTICE_SYSTEM = "matters:notice-system";

export type NoticeSystemAction = "status" | "openSettings";
const ACTIONS: readonly string[] = ["status", "openSettings"] satisfies NoticeSystemAction[];

export interface NoticeBridgeDeps {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** To the page, which listens on `window`. */
  post(message: unknown): void;
}

export interface NoticeMessageLike {
  readonly source: unknown;
  readonly data: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function createNoticeBridge(deps: NoticeBridgeDeps, pageWindow: unknown) {
  return {
    /** The page's `message` events on the window. */
    message(event: NoticeMessageLike): void {
      const data = event.data;
      if (event.source !== pageWindow || !isRecord(data)) return;
      const ask = data.mattersNoticeSystem;
      if (!isRecord(ask) || typeof ask.requestId !== "string" || ask.requestId.length > 100) return;
      const requestId = ask.requestId;
      if (typeof ask.action !== "string" || !ACTIONS.includes(ask.action)) {
        deps.post({ mattersNoticeSystemAnswer: { requestId, answer: null } });
        return;
      }
      deps
        .invoke(CHANNEL_NOTICE_SYSTEM, ask.action)
        .then(
          (answer) => (isRecord(answer) ? answer : null),
          () => null,
        )
        .then((answer) => deps.post({ mattersNoticeSystemAnswer: { requestId, answer } }));
    },
  };
}
