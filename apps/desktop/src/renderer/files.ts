// The page's side of the file messages the preload answers (ADR 0041, rule 3). The page never
// sends or receives a path: it asks for a pick, hands over pasted bytes, and hears about drops,
// and what comes back is always `PickedFile`s (a grant, a name and a size).
import type {
  AppearanceInfo,
  AppearanceMode,
  MainStorageInfo,
  NoticeSystem,
  PickedFile,
  ReceivedAnswer,
  ThemeAddAnswer,
} from "@matters/contracts";
import type { ReceivedAsk } from "./received.ts";

let counter = 0;
const nextRequestId = () => `f${++counter}`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Waits for the preload's answer with this key and request id; resolves with its payload. */
function answer<T>(key: string, requestId: string): Promise<T> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (event.source !== window || !isRecord(data)) return;
      const body = data[key];
      if (!isRecord(body) || body.requestId !== requestId) return;
      window.removeEventListener("message", onMessage);
      resolve(body as T);
    };
    window.addEventListener("message", onMessage);
  });
}

/** Opens the system's file dialog (main's, not the page's). Empty when cancelled. */
export async function pickFiles(): Promise<PickedFile[]> {
  const requestId = nextRequestId();
  const reply = answer<{ files: PickedFile[] }>("mattersPicked", requestId);
  window.postMessage({ mattersPickFiles: { requestId } }, "*");
  return (await reply).files;
}

/** A pasted image: its bytes go to main, which keeps them in a private file and grants that. */
export async function pasteImage(file: Blob): Promise<PickedFile | null> {
  const requestId = nextRequestId();
  const reply = answer<{ file: PickedFile | null }>("mattersPasted", requestId);
  window.postMessage(
    { mattersPasteImage: { requestId, mime: file.type, data: await file.arrayBuffer() } },
    "*",
  );
  return (await reply).file;
}

/**
 * Grants for the files of each drop, in drop order and in the order of the page's own
 * `DataTransfer.files`. `dropId` counts from 1 and is the same sequence in every window.
 */
export function onDropped(
  listener: (drop: { dropId: number; files: readonly PickedFile[] }) => void,
): () => void {
  const onMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (event.source !== window || !isRecord(data) || !isRecord(data.mattersDropped)) return;
    const { dropId, files } = data.mattersDropped;
    if (typeof dropId === "number" && Array.isArray(files)) {
      listener({ dropId, files: files as PickedFile[] });
    }
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/**
 * Asks main to do something with a received file (ADR 0043, rule 10). The ask names the file by
 * message key and part id; the answer says how it ended. Neither carries a path.
 */
export async function askReceived(request: ReceivedAsk): Promise<ReceivedAnswer> {
  const requestId = nextRequestId();
  const reply = answer<{ answer: ReceivedAnswer }>("mattersReceivedAnswer", requestId);
  window.postMessage({ mattersReceived: { requestId, ...request } }, "*");
  return (await reply).answer;
}

/**
 * Settings › Storage (ADR 0089): folder sizes and process memory from main, or caches cleared
 * first. Main answers only the settings window; null when it does not answer.
 */
export async function askMainStorage(
  action: "overview" | "clearCaches",
): Promise<MainStorageInfo | null> {
  const requestId = nextRequestId();
  const reply = answer<{ answer: MainStorageInfo | null }>("mattersStorageAnswer", requestId);
  window.postMessage({ mattersStorage: { requestId, action } }, "*");
  return (await reply).answer;
}

/**
 * Settings › Notifications (ADR 0108): how the app runs, as main knows it, or System Settings
 * opened at its Notifications pane. Main answers only the settings window; null when it does not.
 */
export async function askNoticeSystem(action: "status"): Promise<NoticeSystem | null>;
export async function askNoticeSystem(action: "openSettings"): Promise<{ opened: boolean } | null>;
export async function askNoticeSystem(action: "status" | "openSettings"): Promise<unknown> {
  const requestId = nextRequestId();
  const reply = answer<{ answer: unknown }>("mattersNoticeSystemAnswer", requestId);
  window.postMessage({ mattersNoticeSystem: { requestId, action } }, "*");
  return (await reply).answer;
}

/** What Settings › Appearance asks main (ADR 0134). Themes are named by the ids main made. */
export type AppearanceAsk =
  | { action: "get" }
  | { action: "set"; mode: AppearanceMode }
  | { action: "reset" }
  | { action: "theme"; id: string | null }
  | { action: "remove"; id: string };

/**
 * Settings › Appearance (ADR 0134): the mode and theme main keeps, changed, or back to the
 * default. The answer is the appearance in force after it; null when main does not answer.
 */
export async function askAppearance(ask: AppearanceAsk): Promise<AppearanceInfo | null> {
  const requestId = nextRequestId();
  const reply = answer<{ answer: AppearanceInfo | null }>("mattersAppearanceAnswer", requestId);
  window.postMessage({ mattersAppearance: { requestId, ...ask } }, "*");
  return (await reply).answer;
}

/**
 * A theme's text, as the agent wrote it from the person's description (ADR 0134, rule 12): main
 * checks it and keeps it, or says every reason it was refused. The page hands text, never a path.
 */
export async function addTheme(text: string): Promise<ThemeAddAnswer | null> {
  const requestId = nextRequestId();
  const reply = answer<{ answer: ThemeAddAnswer | null }>("mattersAppearanceAnswer", requestId);
  window.postMessage({ mattersAppearance: { requestId, action: "add", text } }, "*");
  return (await reply).answer;
}

/**
 * The text of a theme main keeps, as its file holds it (ADR 0134, rule 14): what goes with a turn
 * that changes the theme that is on. Null when main does not know the theme.
 */
export async function themeText(id: string): Promise<string | null> {
  const requestId = nextRequestId();
  const reply = answer<{ answer: string | null }>("mattersAppearanceAnswer", requestId);
  window.postMessage({ mattersAppearance: { requestId, action: "text", id } }, "*");
  const got = (await reply).answer;
  return typeof got === "string" ? got : null;
}

/** The appearance changed, from any window, the menu or the shortcut; main tells every window. */
export function onAppearanceChanged(listener: (appearance: AppearanceInfo) => void): () => void {
  const onMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (event.source !== window || !isRecord(data) || !isRecord(data.mattersAppearanceChanged)) {
      return;
    }
    // The preload rebuilt it from main's answer; only the shape is trusted, as for every answer.
    listener(data.mattersAppearanceChanged as unknown as AppearanceInfo);
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
