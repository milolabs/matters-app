// What tells the person that mail came, and how (ADR 0071, 0106). Pure rules: which new mail
// notifies, through which of the three channels, what a banner may say, and when the computer
// keeps quiet. The desktop app shows banners and sets the badge; nothing here knows how.

import { isAutomatedSender } from "./automated.ts";
import type { Message } from "./entities.ts";
import { NEEDS_YOU_VIEW } from "./views.ts";

/**
 * The kinds of mail, each with its own channels. By its headers a message of the Inbox is of one
 * kind only: mail from a list or a program is `lists`; mail in a thread you wrote in is `replies`;
 * the rest from a person is `people`. A saved view notifies on top of these (ADR 0071; ADR 0117,
 * rule 6).
 */
export const NOTICE_KINDS = ["replies", "people", "lists"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** Where a kind of mail shows: a system banner, a notice inside the app, the count on the icon. */
export interface NoticeChannels {
  readonly banner: boolean;
  readonly inApp: boolean;
  readonly badge: boolean;
}

/** What a system banner may say; the lock screen and a shared screen can read it. */
export type BannerContent = "full" | "subject" | "minimal";
/**
 * What the icon counts: the number of one saved view (`view`, ADR 0117, rule 5), unread mail you
 * were told about, all unread in the Inbox, or nothing.
 */
export type BadgeSource = "view" | "notified" | "inbox" | "off";
export const BADGE_SOURCES: readonly BadgeSource[] = ["view", "notified", "inbox", "off"];
export type BadgeStyle = "count" | "dot";

export interface NotificationPrefs {
  /** Off: no banner, no notice, no badge. */
  readonly enabled: boolean;
  readonly kinds: Readonly<Record<NoticeKind, NoticeChannels>>;
  /**
   * Saved views that notify, by view id. A view notifies for its own mail wherever it is, also
   * outside the Inbox; a view that is not here does not notify.
   */
  readonly views: Readonly<Record<string, NoticeChannels>>;
  /** Accounts whose mail never notifies. */
  readonly mutedAccounts: readonly string[];
  readonly banner: {
    readonly content: BannerContent;
    readonly sound: boolean;
    /** Banners also while Matters is the app in front; otherwise only the notice inside shows. */
    readonly whenFront: boolean;
    /** At most this many banners for mail that came together; the rest is one summary. */
    readonly together: number;
  };
  readonly inApp: {
    /** How long a notice stays while the window is in front; 0 keeps it until it is closed. */
    readonly seconds: number;
  };
  readonly badge: {
    readonly source: BadgeSource;
    /**
     * With `view`: the saved view whose tab number the icon shows (ADR 0117, rule 5). Gone, absent,
     * or a view with a prompt while AI is off: the icon counts the Inbox.
     */
    readonly viewId?: string;
    readonly style: BadgeStyle;
  };
  /** Every day, in local minutes after midnight; `from` after `to` runs across midnight. */
  readonly quiet: { readonly on: boolean; readonly fromMin: number; readonly toMin: number };
  /** Paused until this time (Pause for an hour, until tomorrow); null when not paused. */
  readonly pausedUntilMs: number | null;
}

const ALL: NoticeChannels = { banner: true, inApp: true, badge: true };
const NONE: NoticeChannels = { banner: false, inApp: false, badge: false };

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  kinds: { replies: ALL, people: ALL, lists: NONE },
  views: {},
  mutedAccounts: [],
  banner: { content: "subject", sound: true, whenFront: false, together: 3 },
  inApp: { seconds: 6 },
  // The starter view's tab number (ADR 0117, rule 5): a count with a place in the app that shows it.
  badge: { source: "view", viewId: NEEDS_YOU_VIEW.id, style: "count" },
  quiet: { on: false, fromMin: 22 * 60, toMin: 7 * 60 },
  pausedUntilMs: null,
};

export const BANNERS_TOGETHER = [1, 3, 5] as const;
export const IN_APP_SECONDS = [4, 6, 10, 0] as const;

const MINUTES_PER_DAY = 24 * 60;

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function minute(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MINUTES_PER_DAY
    ? value
    : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function channels(value: unknown, fallback: NoticeChannels): NoticeChannels {
  const v = record(value);
  return {
    banner: bool(v.banner, fallback.banner),
    inApp: bool(v.inApp, fallback.inApp),
    badge: bool(v.badge, fallback.badge),
  };
}

/** At most this many views keep notice settings: as many as there can be views. */
const MAX_VIEW_ENTRIES = 50;

/**
 * Settings from storage or from a window, defended field by field: whatever is missing, of the
 * wrong type or out of range takes the default, so a newer or broken file never stops the app.
 */
export function readNotificationPrefs(raw: unknown): NotificationPrefs {
  const d = DEFAULT_NOTIFICATION_PREFS;
  const v = record(raw);
  const kinds = record(v.kinds);
  const banner = record(v.banner);
  const inApp = record(v.inApp);
  const badge = record(v.badge);
  const quiet = record(v.quiet);
  const views: Record<string, NoticeChannels> = {};
  for (const [id, value] of Object.entries(record(v.views)).slice(0, MAX_VIEW_ENTRIES)) {
    if (id !== "" && id.length <= 200) views[id] = channels(value, NONE);
  }
  const muted = Array.isArray(v.mutedAccounts)
    ? [...new Set(v.mutedAccounts.filter((a): a is string => typeof a === "string"))].slice(0, 100)
    : [];
  const paused = v.pausedUntilMs;
  return {
    enabled: bool(v.enabled, d.enabled),
    kinds: {
      replies: channels(kinds.replies, d.kinds.replies),
      people: channels(kinds.people, d.kinds.people),
      lists: channels(kinds.lists, d.kinds.lists),
      // A `matters` row of a file from before ADR 0117 is ignored (rule 6).
    },
    views,
    mutedAccounts: muted,
    banner: {
      content: oneOf(banner.content, ["full", "subject", "minimal"], d.banner.content),
      sound: bool(banner.sound, d.banner.sound),
      whenFront: bool(banner.whenFront, d.banner.whenFront),
      together: oneOf(banner.together, BANNERS_TOGETHER, d.banner.together),
    },
    inApp: { seconds: oneOf(inApp.seconds, IN_APP_SECONDS, d.inApp.seconds) },
    badge: badgeOf(badge, d.badge),
    quiet: {
      on: bool(quiet.on, d.quiet.on),
      fromMin: minute(quiet.fromMin, d.quiet.fromMin),
      toMin: minute(quiet.toMin, d.quiet.toMin),
    },
    pausedUntilMs:
      typeof paused === "number" && Number.isFinite(paused) && paused > 0 ? paused : null,
  };
}

/**
 * What the icon counts, defended like the rest. This is the one place a stored source is read: a
 * stored `matters`, from before the built-in tab went (ADR 0117, rule 5), reads as the starter
 * view, as does `view` with no view.
 */
function badgeOf(
  badge: Record<string, unknown>,
  d: NotificationPrefs["badge"],
): NotificationPrefs["badge"] {
  const stored = badge.source === "matters" ? "view" : badge.source;
  const source = oneOf(stored, BADGE_SOURCES, d.source);
  const style = oneOf(badge.style, ["count", "dot"], d.style);
  if (source !== "view") return { source, style };
  const viewId = badge.source === "matters" ? null : text(badge.viewId, 200);
  return { source, viewId: viewId ?? NEEDS_YOU_VIEW.id, style };
}

/**
 * Whether banners and their sound keep quiet now: paused, or inside the quiet hours. `localMinute`
 * is the minute of the local day (the caller knows the time zone). Notices inside the app and the
 * badge go on: they make no sound and nobody is interrupted by them.
 */
export function isQuiet(prefs: NotificationPrefs, nowMs: number, localMinute: number): boolean {
  return isPaused(prefs, nowMs) || inQuietHours(prefs, localMinute);
}

function inQuietHours(prefs: NotificationPrefs, localMinute: number): boolean {
  const { on, fromMin, toMin } = prefs.quiet;
  if (!on || fromMin === toMin) return false;
  return fromMin < toMin
    ? localMinute >= fromMin && localMinute < toMin
    : localMinute >= fromMin || localMinute < toMin;
}

// --- Local time, as the caller's time zone gives it ---

/**
 * The time zone: minutes east of UTC at an instant (`-new Date(ms).getTimezoneOffset()`). The
 * caller passes it, so the rules here stay pure and a test can be anywhere.
 */
export type ZoneOffset = (ms: number) => number;

const MINUTE_MS = 60_000;

/** The minute of the local day at an instant. */
export function localMinuteOf(ms: number, zone: ZoneOffset): number {
  const local = Math.floor((ms + zone(ms) * MINUTE_MS) / MINUTE_MS);
  return ((local % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** The local calendar day of an instant, as the midnight UTC of that date. */
function localDayOf(ms: number, zone: ZoneOffset): number {
  const local = ms + zone(ms) * MINUTE_MS;
  return Math.floor(local / DAY_MS) * DAY_MS;
}

/**
 * The instant a local wall-clock time happens: `wallMs` is that time written as if it were UTC
 * (the midnight UTC of a date, plus hours). Asked twice, so a day that changes its offset (summer
 * time) still lands on the right hour.
 */
function instantOf(wallMs: number, zone: ZoneOffset): number {
  const guess = wallMs - zone(wallMs) * MINUTE_MS;
  return wallMs - zone(guess) * MINUTE_MS;
}

// --- Pause (Settings and the app menu say it the same way) ---

export type PauseChoice = "hour" | "tomorrow";
/** Pause until tomorrow ends at this local hour. */
export const PAUSE_MORNING_HOUR = 8;

/** Whether the person paused banners and the pause is not over. */
export function isPaused(prefs: Pick<NotificationPrefs, "pausedUntilMs">, nowMs: number): boolean {
  return prefs.pausedUntilMs !== null && nowMs < prefs.pausedUntilMs;
}

/** When a pause chosen now ends: in an hour, or tomorrow at 8:00 local time. */
export function pauseUntil(choice: PauseChoice, nowMs: number, zone: ZoneOffset): number {
  if (choice === "hour") return nowMs + 60 * MINUTE_MS;
  const tomorrow = localDayOf(nowMs, zone) + DAY_MS;
  return instantOf(tomorrow + PAUSE_MORNING_HOUR * 60 * MINUTE_MS, zone);
}

/** "Paused until 14:30", or "Paused until tomorrow, 08:00" when the pause ends another day. */
export function pausedText(untilMs: number, nowMs: number, zone: ZoneOffset): string {
  const time = clockText(localMinuteOf(untilMs, zone));
  return localDayOf(untilMs, zone) === localDayOf(nowMs, zone)
    ? `Paused until ${time}`
    : `Paused until tomorrow, ${time}`;
}

/**
 * When banners may go again: now when nothing keeps them quiet, else the end of the pause or of
 * the quiet hours, whichever comes later.
 */
export function quietEndsAt(prefs: NotificationPrefs, nowMs: number, zone: ZoneOffset): number {
  let t = nowMs;
  // A pause can end inside the quiet hours, and the quiet hours inside a pause: a few steps do.
  for (let i = 0; i < 4; i += 1) {
    if (isPaused(prefs, t)) {
      t = prefs.pausedUntilMs as number;
      continue;
    }
    const minute = localMinuteOf(t, zone);
    if (!inQuietHours(prefs, minute)) return t;
    const left = (prefs.quiet.toMin - minute + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    t = Math.floor(t / MINUTE_MS) * MINUTE_MS + left * MINUTE_MS;
  }
  return t;
}

/** A message that came since the last look, with what the rules need to know about it. */
export interface NewMail {
  readonly message: Message;
  /** It is in the Inbox. */
  readonly inbox: boolean;
  /** You sent it (from one of your accounts): it never notifies. */
  readonly fromMe: boolean;
  /** You wrote in its thread before. */
  readonly youWrote: boolean;
  /** The ids of the saved views it belongs to, among those that notify. */
  readonly views: readonly string[];
  /**
   * The saved views with a prompt that notify and whose mail filters match it (ADR 0117, rule 6).
   * They do not notify now: each waits for the verdict of the reading in the background.
   */
  readonly prompted?: readonly string[];
}

/** The kind of a message in the Inbox by its headers; null outside it. */
export function noticeKindOf(mail: NewMail): NoticeKind | null {
  if (!mail.inbox) return null;
  const m = mail.message;
  if (m.automated === true || isAutomatedSender(m.from.address)) return "lists";
  return mail.youWrote ? "replies" : "people";
}

/**
 * Old mail that only moved: dated before the catch-up's reach (ADR 0108). A message that arrives
 * in a folder by a move (a server filter, another client) gets a new UID there, so by the marks it
 * is new; its date says it is not.
 */
export function isOldMail(message: Message, nowMs: number): boolean {
  return message.dateMs < nowMs - CATCH_UP_DAYS * DAY_MS;
}

/** Mail that never notifies: off, your own, read, of a muted account, or old mail that moved. */
function silenced(
  prefs: NotificationPrefs,
  message: Message,
  fromMe: boolean,
  nowMs: number,
): boolean {
  return (
    !prefs.enabled ||
    fromMe ||
    message.flags.seen ||
    prefs.mutedAccounts.includes(message.accountId) ||
    isOldMail(message, nowMs)
  );
}

/** The channels a message goes through: its kind's, and those of every view it is in. */
export function channelsOf(prefs: NotificationPrefs, mail: NewMail, nowMs: number): NoticeChannels {
  if (silenced(prefs, mail.message, mail.fromMe, nowMs)) return NONE;
  const all: NoticeChannels[] = [];
  const kind = noticeKindOf(mail);
  if (kind !== null) all.push(prefs.kinds[kind]);
  for (const id of mail.views) {
    const c = prefs.views[id];
    if (c) all.push(c);
  }
  return {
    banner: all.some((c) => c.banner),
    inApp: all.some((c) => c.inApp),
    badge: all.some((c) => c.badge),
  };
}

/** What one notice says. A summary has no message to open; the newest one is opened instead. */
export interface NoticeText {
  readonly key: number;
  readonly threadId: string;
  readonly accountId: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly body: string;
  /**
   * The banner is about this one message: it may offer to mark it read or archive it, and it is
   * taken back once the message is read, archived or deleted (ADR 0108). Not on a summary, the
   * catch-up or a deadline.
   */
  readonly alone?: true;
}

export interface NoticePlan {
  /** Grouped: at most `together` single banners, then one summary for the rest. */
  readonly banners: readonly NoticeText[];
  readonly sound: boolean;
  /** Banners also show while the window is in front. */
  readonly whenFront: boolean;
  /** One per message, newest first; the window shows a few and counts the rest. */
  readonly inApp: readonly NoticeText[];
  /** Keys that the badge counts while they stay unread (source `notified`). */
  readonly badged: readonly number[];
  /** The channels each message went through, so that a later notice does not use them again. */
  readonly told: readonly Told[];
}

/** The channels one message went through. */
export interface Told {
  readonly key: number;
  readonly channels: NoticeChannels;
}

/** The most notices one look hands the window; more than that is one summary there too. */
export const MAX_IN_APP = 20;

function senderName(m: Message): string {
  const name = m.from.name?.trim();
  return name !== undefined && name !== "" ? name : m.from.address;
}

function subjectOf(m: Message): string {
  const s = m.subject.trim();
  return s === "" ? "(no subject)" : s;
}

function fullText(m: Message): NoticeText {
  const snippet = m.snippet.trim();
  return {
    key: m.key,
    threadId: m.threadId,
    accountId: m.accountId,
    title: senderName(m),
    subtitle: subjectOf(m),
    body: snippet,
  };
}

function bannerText(m: Message, content: BannerContent): NoticeText {
  const base = { key: m.key, threadId: m.threadId, accountId: m.accountId, alone: true } as const;
  if (content === "full") return { ...fullText(m), alone: true };
  if (content === "subject") return { ...base, title: senderName(m), body: subjectOf(m) };
  return { ...base, title: "New mail", body: "Open Matters to read it." };
}

/** "Anna, Bartek and 3 others": who the rest of the mail is from, as far as the banner may say. */
export function fromWhom(messages: readonly Message[]): string {
  const names = [...new Set(messages.map(senderName))];
  if (names.length <= 2) return names.join(" and ");
  const others = names.length - 2;
  return `${names[0]}, ${names[1]} and ${others} ${others === 1 ? "other" : "others"}`;
}

function summary(rest: readonly Message[], content: BannerContent, more: boolean): NoticeText {
  const newest = rest[0] as Message;
  const n = rest.length;
  const noun = n === 1 ? "message" : "messages";
  return {
    key: newest.key,
    threadId: newest.threadId,
    accountId: newest.accountId,
    title: more ? `${n} more new ${noun}` : `${n} new ${noun}`,
    body: content === "minimal" ? "Open Matters to read them." : `From ${fromWhom(rest)}`,
  };
}

/**
 * At most `together` banners: all alone when they fit, else one summary when `together` is 1, else
 * the first `together - 1` alone and one summary for the rest.
 */
function grouped<T>(
  items: readonly T[],
  together: number,
  alone: (item: T) => NoticeText,
  rest: (items: readonly T[], more: boolean) => NoticeText,
): NoticeText[] {
  if (items.length === 0) return [];
  if (items.length <= together) return items.map(alone);
  if (together === 1) return [rest(items, false)];
  return [...items.slice(0, together - 1).map(alone), rest(items.slice(together - 1), true)];
}

function toldOf(key: number, c: NoticeChannels, quiet: boolean): Told {
  // A banner that quiet kept back was not shown: a later notice may still show one.
  return { key, channels: { banner: c.banner && !quiet, inApp: c.inApp, badge: c.badge } };
}

/**
 * The notices for mail that came together. `quiet` (see `isQuiet`) drops the banners and their
 * sound; the window's notices and the badge stay.
 */
export function planNotices(
  prefs: NotificationPrefs,
  mails: readonly NewMail[],
  quiet: boolean,
  nowMs: number,
): NoticePlan {
  const newest = [...mails].sort((a, b) => b.message.key - a.message.key);
  const banner: Message[] = [];
  const inApp: Message[] = [];
  const badged: number[] = [];
  const told: Told[] = [];
  for (const mail of newest) {
    const c = channelsOf(prefs, mail, nowMs);
    if (c.banner) banner.push(mail.message);
    if (c.inApp) inApp.push(mail.message);
    if (c.badge) badged.push(mail.message.key);
    told.push(toldOf(mail.message.key, c, quiet));
  }
  const { content, together, sound, whenFront } = prefs.banner;
  const banners = quiet
    ? []
    : grouped(
        banner,
        together,
        (m) => bannerText(m, content),
        (rest, more) => summary(rest, content, more),
      );
  const shown = inApp.slice(0, MAX_IN_APP).map(fullText);
  const rest = inApp.slice(MAX_IN_APP);
  return {
    banners,
    sound: !quiet && sound && banners.length > 0,
    whenFront,
    inApp: rest.length > 0 ? [...shown, summary(rest, "full", true)] : shown,
    badged,
    told,
  };
}

// --- What came while the app was closed (ADR 0106, rule 2) ---

/** A catch-up reaches this far back, by the date of the mail; older mail is left to the list. */
export const CATCH_UP_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * One notice inside the window for the mail that came while the app was closed: no banner and no
 * sound, since nothing rang when it came either. It counts the mail that would notify now through
 * a banner or the window; the badge follows what its column covers. Mail dated more than
 * `CATCH_UP_DAYS` ago is not counted.
 */
export function planCatchUp(
  prefs: NotificationPrefs,
  mails: readonly NewMail[],
  nowMs: number,
): NoticePlan {
  const edge = nowMs - CATCH_UP_DAYS * DAY_MS;
  const newest = [...mails]
    .filter((m) => m.message.dateMs >= edge)
    .sort((a, b) => b.message.key - a.message.key);
  const counted: Message[] = [];
  const badged: number[] = [];
  const told: Told[] = [];
  for (const mail of newest) {
    const c = channelsOf(prefs, mail, nowMs);
    const counts = c.banner || c.inApp;
    if (counts) counted.push(mail.message);
    if (c.badge) badged.push(mail.message.key);
    told.push({
      key: mail.message.key,
      channels: { banner: false, inApp: counts, badge: c.badge },
    });
  }
  const first = counted[0];
  const n = counted.length;
  const inApp: NoticeText[] =
    first === undefined
      ? []
      : [
          {
            key: first.key,
            threadId: first.threadId,
            accountId: first.accountId,
            title: `${n} new ${n === 1 ? "message" : "messages"} while Matters was closed`,
            body: `From ${fromWhom(counted)}`,
          },
        ];
  return { banners: [], sound: false, whenFront: prefs.banner.whenFront, inApp, badged, told };
}

// --- Views with a prompt (ADR 0117, rule 6) ---

/** A message whose thread a view with a prompt was given a verdict for after it came, and fits. */
export interface PromptMail {
  readonly message: Message;
  /** The channels it already went through, by its kind or another view. */
  readonly told: NoticeChannels;
  /** The views with a prompt that notify and that it fits. */
  readonly views: readonly string[];
}

/**
 * The notices for mail that fits a view with a prompt, once its verdict came. Each goes through
 * the channels of those views it did not already go through: a message never notifies twice
 * through one channel, whichever kind or view told it first. Read mail, your own, that of a muted
 * account and old mail that moved never notify; `quiet` drops banners and sound.
 */
export function planPromptNotices(
  prefs: NotificationPrefs,
  mails: readonly PromptMail[],
  quiet: boolean,
  nowMs: number,
): NoticePlan {
  const newest = [...mails].sort((a, b) => b.message.key - a.message.key);
  const banner: Message[] = [];
  const inApp: Message[] = [];
  const badged: number[] = [];
  const told: Told[] = [];
  for (const mail of newest) {
    if (silenced(prefs, mail.message, false, nowMs)) continue;
    const want = mail.views.flatMap((id) => {
      const c = prefs.views[id];
      return c === undefined ? [] : [c];
    });
    const c: NoticeChannels = {
      banner: want.some((w) => w.banner) && !mail.told.banner,
      inApp: want.some((w) => w.inApp) && !mail.told.inApp,
      badge: want.some((w) => w.badge) && !mail.told.badge,
    };
    if (c.banner && !quiet) banner.push(mail.message);
    if (c.inApp) inApp.push(mail.message);
    if (c.badge) badged.push(mail.message.key);
    told.push(toldOf(mail.message.key, c, quiet));
  }
  const { content, together, sound, whenFront } = prefs.banner;
  const banners = grouped(
    banner,
    together,
    (m) => bannerText(m, content),
    (rest, more) => summary(rest, content, more),
  );
  const shown = inApp.slice(0, MAX_IN_APP).map(fullText);
  const rest = inApp.slice(MAX_IN_APP);
  return {
    banners,
    sound: !quiet && sound && banners.length > 0,
    whenFront,
    inApp: rest.length > 0 ? [...shown, summary(rest, "full", true)] : shown,
    badged,
    told,
  };
}

// --- What the watch keeps across a restart (ADR 0106, rule 2) ---

/**
 * Where the stored mail of one folder ends: the highest UID its sync has stored at one
 * UIDVALIDITY. UIDs only grow, so mail above a mark arrived after it was taken, whatever its date.
 */
export interface ArrivalMark {
  readonly accountId: string;
  readonly folderId: string;
  readonly uidValidity: string;
  readonly uid: number;
}

/** The UIDs of one folder that arrived between two marks: above `afterUid`, up to `upToUid`. */
export interface ArrivalSpan {
  readonly accountId: string;
  readonly folderId: string;
  readonly uidValidity: string;
  readonly afterUid: number;
  readonly upToUid: number;
}

const folderOf = (m: { accountId: string; folderId: string }) =>
  `${m.accountId}\u0000${m.folderId}`;

/**
 * What arrived between the marks of the last look and those of now, and the marks to keep. A folder
 * with no earlier mark (a new account, a new folder) or a new UIDVALIDITY brings nothing: its mail
 * was not seen arriving, so it is taken as there. A folder that is gone is forgotten.
 */
export function arrivalsBetween(
  before: readonly ArrivalMark[],
  now: readonly ArrivalMark[],
): { readonly spans: ArrivalSpan[]; readonly marks: ArrivalMark[] } {
  const was = new Map(before.map((m) => [folderOf(m), m]));
  const spans: ArrivalSpan[] = [];
  const marks: ArrivalMark[] = [];
  for (const m of now) {
    const prev = was.get(folderOf(m));
    if (prev === undefined || prev.uidValidity !== m.uidValidity) {
      marks.push(m);
      continue;
    }
    if (m.uid > prev.uid) {
      spans.push({
        accountId: m.accountId,
        folderId: m.folderId,
        uidValidity: m.uidValidity,
        afterUid: prev.uid,
        upToUid: m.uid,
      });
    }
    marks.push(m.uid >= prev.uid ? m : prev);
  }
  return { spans, marks };
}

/** A message the watch announced (or chose not to), and what it went through. */
export interface ToldMail {
  readonly key: number;
  readonly threadId: string;
  /** When the watch first saw it. */
  readonly atMs: number;
  readonly channels: NoticeChannels;
  /**
   * Views with a prompt that still wait for a verdict of its thread (ADR 0117, rule 6). Absent or
   * empty: none waits. They wait as long as the mail is kept (48 hours).
   */
  readonly waiting?: readonly string[];
}

/** What the watch keeps in its file next to the database. */
export interface WatchState {
  /** When the last look ran. */
  readonly lookedAtMs: number;
  readonly marks: readonly ArrivalMark[];
  /** Keys the badge follows (source `notified`) while they stay unread. */
  readonly badged: readonly number[];
  /** Mail of the last 48 hours, so that it is told once and a view with a prompt can still ring. */
  readonly told: readonly ToldMail[];
}

export const MAX_MARKS = 5000;
export const MAX_BADGED = 1000;
export const MAX_TOLD = 500;

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown, max = 500): string | null {
  return typeof value === "string" && value !== "" && value.length <= max ? value : null;
}

/**
 * The watch's file, defended field by field like the settings: a broken entry is dropped and the
 * rest stays. Null when there is nothing a watch could go on from (no file, or not an object).
 * What older versions kept for the agent's own list (`decided`, `dues`, `duesHeld`) is ignored.
 */
export function readWatchState(raw: unknown): WatchState | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const lookedAtMs = count(v.lookedAtMs);
  if (lookedAtMs === null) return null;
  const marks: ArrivalMark[] = [];
  for (const item of Array.isArray(v.marks) ? v.marks.slice(0, MAX_MARKS) : []) {
    const m = record(item);
    const accountId = text(m.accountId);
    const folderId = text(m.folderId);
    const uidValidity = text(m.uidValidity, 40);
    const uid = count(m.uid);
    if (accountId && folderId && uidValidity && uid !== null) {
      marks.push({ accountId, folderId, uidValidity, uid });
    }
  }
  const badged = Array.isArray(v.badged)
    ? [...new Set(v.badged.map(count).filter((k): k is number => k !== null))].slice(0, MAX_BADGED)
    : [];
  const told: ToldMail[] = [];
  const keys = new Set<number>();
  for (const item of Array.isArray(v.told) ? v.told.slice(0, MAX_TOLD) : []) {
    const t = record(item);
    const key = count(t.key);
    const threadId = text(t.threadId);
    const atMs = count(t.atMs);
    if (key === null || threadId === null || atMs === null || keys.has(key)) continue;
    keys.add(key);
    told.push({
      key,
      threadId,
      atMs,
      channels: channels(t.channels, NONE),
      ...waitingOf(t.waiting),
    });
  }
  return { lookedAtMs, marks, badged, told };
}

function waitingOf(value: unknown): { readonly waiting?: readonly string[] } {
  if (!Array.isArray(value)) return {};
  const ids = [
    ...new Set(value.map((id) => text(id, 200)).filter((id): id is string => id !== null)),
  ].slice(0, MAX_VIEW_ENTRIES);
  return ids.length === 0 ? {} : { waiting: ids };
}

/** What the icon shows for a count: nothing at zero, a dot, or the number up to 999. */
export function badgeText(count: number, style: BadgeStyle): string {
  if (count <= 0) return "";
  if (style === "dot") return "•";
  return count > 999 ? "999+" : String(count);
}

/** "22:00" for a minute of the day. */
export function clockText(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** The minute of the day of "22:00" or "7:30"; null for anything else. */
export function parseClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h < 24 && m < 60 ? h * 60 + m : null;
}
