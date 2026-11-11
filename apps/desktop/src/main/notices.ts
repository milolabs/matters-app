// Banners and the badge as main shows them (ADR 0071, rule 8). The router decided what to say;
// main only knows whether its window is in front, and keeps a banner alive until it is clicked.
// A banner of one message offers to mark it read or archive it, and goes when the router says its
// message was read, archived or deleted (ADR 0108).
import type { NoticeToMain } from "@matters/contracts";
import {
  isPaused,
  type NoticeText,
  type PauseChoice,
  pausedText,
  pauseUntil,
  type ZoneOffset,
} from "@matters/core";

/** What a shown banner needs: the click, its buttons, and to be dropped when it closes. */
export interface Banner {
  on(event: "click" | "close", listener: () => void): unknown;
  /** A button was pressed: its index among the actions. */
  on(event: "action", listener: (index: number) => void): unknown;
  /** The system refused it, with its reason. */
  on(event: "failed", listener: (reason: string) => void): unknown;
  show(): void;
  /** Takes it off the screen and out of Notification Center. */
  close(): void;
}

/** What a button on a banner does to its message; the app's own commands do it. */
export type BannerAction = "read" | "archive";

/** The buttons, in this order, on a banner of one message. */
export const BANNER_ACTIONS: readonly { readonly action: BannerAction; readonly label: string }[] =
  [
    { action: "read", label: "Mark as Read" },
    { action: "archive", label: "Archive" },
  ];

export interface BannerOptions {
  readonly silent: boolean;
  /** The id the system keeps it under; set for a banner of one message, so it can be taken back. */
  readonly id?: string;
  /** Button labels; empty for a summary, the catch-up, a deadline or a test. */
  readonly actions: readonly string[];
}

/** Whether banners are paused, as the router last said (for the menu). */
export interface PauseState {
  readonly enabled: boolean;
  readonly untilMs: number | null;
}

export interface NoticeHost {
  /** The mail window is the app in front. */
  focused(): boolean;
  /** Null where the system has no banners. */
  banner(text: NoticeText, options: BannerOptions): Banner | null;
  setBadge(text: string): void;
  /** Brings the mail window forward on this message; key 0 (a test notice) only brings it forward. */
  open(key: number, threadId: string): void;
  /** A button was pressed: the router does it, and the window stays where it is. */
  act(action: BannerAction, key: number, threadId: string): void;
  /** Takes these banners out of Notification Center by id, also those no longer held. */
  remove(ids: readonly string[]): void;
  /** The system refused the test banner. */
  failed(reason: string): void;
  /** The pause changed: the menu says it. */
  paused(state: PauseState): void;
}

/** Banners kept alive at once; older ones are let go (the system keeps showing them). */
const MAX_ALIVE = 20;

/** The id under which the system keeps the banner of one message. */
export const bannerId = (key: number) => `mail-${key}`;

const isKey = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export class NoticeShower {
  private readonly host: NoticeHost;
  /** Electron forgets the click of a banner nobody holds: these are held until click or close. */
  private readonly alive = new Map<Banner, NoticeText>();

  constructor(host: NoticeHost) {
    this.host = host;
  }

  handle(event: NoticeToMain): void {
    if (event.type === "badge") {
      this.host.setBadge(event.text);
      return;
    }
    if (event.type === "close") {
      this.close(event.keys);
      return;
    }
    if (event.type === "pause") {
      this.host.paused({ enabled: event.enabled, untilMs: event.untilMs });
      return;
    }
    if (!event.whenFront && this.host.focused()) return;
    // One sound for mail that came together, on the first banner.
    event.banners.forEach((text, i) => {
      const one = text.alone === true && isKey(text.key) && text.threadId !== "";
      const test = text.key === 0 && text.threadId === "";
      const banner = this.host.banner(text, {
        silent: !event.sound || i > 0,
        ...(one ? { id: bannerId(text.key) } : {}),
        actions: one ? BANNER_ACTIONS.map((a) => a.label) : [],
      });
      if (!banner) return;
      const drop = () => this.alive.delete(banner);
      banner.on("click", () => {
        drop();
        this.host.open(text.key, text.threadId);
      });
      banner.on("action", (index: number) => {
        drop();
        const action = one && Number.isInteger(index) ? BANNER_ACTIONS[index] : undefined;
        if (action) this.host.act(action.action, text.key, text.threadId);
      });
      banner.on("failed", (reason: string) => {
        drop();
        if (test) this.host.failed(typeof reason === "string" ? reason : "");
      });
      banner.on("close", drop);
      this.alive.set(banner, text);
      if (this.alive.size > MAX_ALIVE) {
        const oldest = this.alive.keys().next().value;
        if (oldest) this.alive.delete(oldest);
      }
      banner.show();
    });
  }

  /** The banners of these messages go: those held are closed, the rest removed by id. */
  private close(keys: readonly number[]): void {
    const going = new Set(keys.filter(isKey));
    if (going.size === 0) return;
    for (const [banner, text] of [...this.alive]) {
      if (text.alone !== true || !going.has(text.key)) continue;
      this.alive.delete(banner);
      banner.close();
    }
    this.host.remove([...going].map(bannerId));
  }

  /** For tests: how many banners are held. */
  get held(): number {
    return this.alive.size;
  }
}

/** A notice to main as it came over the line; anything else is not one and is dropped. */
export function noticeFrom(data: unknown): NoticeToMain | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.type === "badge")
    return typeof d.text === "string" ? { type: "badge", text: d.text.slice(0, 8) } : null;
  if (d.type === "close") {
    if (!Array.isArray(d.keys)) return null;
    return { type: "close", keys: d.keys.slice(0, 100).filter(isKey) };
  }
  if (d.type === "pause") {
    const until = d.untilMs;
    const untilMs = typeof until === "number" && Number.isFinite(until) && until > 0 ? until : null;
    return { type: "pause", enabled: d.enabled !== false, untilMs };
  }
  if (d.type !== "banners" || !Array.isArray(d.banners)) return null;
  const banners: NoticeText[] = [];
  for (const b of d.banners.slice(0, 10)) {
    const t = (b ?? {}) as Record<string, unknown>;
    if (typeof t.title !== "string" || typeof t.body !== "string") continue;
    const key = typeof t.key === "number" && Number.isSafeInteger(t.key) && t.key >= 0 ? t.key : 0;
    const threadId = typeof t.threadId === "string" && t.threadId.length <= 200 ? t.threadId : "";
    banners.push({
      key,
      threadId,
      accountId: typeof t.accountId === "string" ? t.accountId.slice(0, 200) : "",
      title: t.title.slice(0, 200),
      ...(typeof t.subtitle === "string" ? { subtitle: t.subtitle.slice(0, 200) } : {}),
      body: t.body.slice(0, 400),
      ...(t.alone === true && key > 0 && threadId !== "" ? { alone: true as const } : {}),
    });
  }
  return { type: "banners", banners, sound: d.sound === true, whenFront: d.whenFront === true };
}

/** One item of the menu's Notifications part: a line that says, or a choice that does. */
export interface PauseMenuItem {
  readonly label: string;
  /** What choosing it does; absent, it only says. */
  readonly choice?: PauseChoice | "resume";
}

/**
 * The Notifications items of the app menu (ADR 0108): the two pauses, or the pause's end and
 * Resume. Main builds the menu again when the router says the pause changed and when it ends.
 */
export function pauseMenu(state: PauseState, nowMs: number, zone: ZoneOffset): PauseMenuItem[] {
  if (!state.enabled) return [{ label: "Notifications Are Off" }];
  if (state.untilMs !== null && isPaused({ pausedUntilMs: state.untilMs }, nowMs)) {
    return [
      { label: pausedText(state.untilMs, nowMs, zone) },
      { label: "Resume", choice: "resume" },
    ];
  }
  return [
    { label: "Pause for an Hour", choice: "hour" },
    { label: "Pause Until Tomorrow", choice: "tomorrow" },
  ];
}

/** What a choice sets, at the moment it is chosen: by the same rule as Settings. */
export function pauseTarget(
  choice: PauseChoice | "resume",
  nowMs: number,
  zone: ZoneOffset,
): number | null {
  return choice === "resume" ? null : pauseUntil(choice, nowMs, zone);
}
