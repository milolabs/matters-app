// The router's notifications (ADR 0071, 0106): it keeps the settings, looks for new mail after
// every commit, hears when a view with a prompt has given a verdict (ADR 0117), and tells main
// what banner to show and what the badge says, and the windows what notice to show inside. Nothing here shows
// anything itself. What the watch knows is kept in a small file beside the settings, so a restart
// goes on from it.
import { readFile, rename, writeFile } from "node:fs/promises";
import type { BackendEvent, NoticeToMain } from "@matters/contracts";
import {
  badgeText,
  countMatches,
  isQuiet,
  localMinuteOf,
  MAILBOX_BIT,
  type Message,
  type NewMail,
  type NewMailDeps,
  NewMailWatch,
  type NoticePlan,
  type NoticeText,
  type NotificationPrefs,
  PROMPT_SHOWN_FIT,
  type PromptBadge,
  type PromptMail,
  parseQuery,
  planCatchUp,
  planNotices,
  planPromptNotices,
  readNotificationPrefs,
  readWatchState,
  type WatchState,
  type ZoneOffset,
} from "@matters/core";
import type { NotificationsApi } from "./handler.ts";

/**
 * What views with a prompt know (ADR 0117, rules 4 and 6): stored verdicts, read with no model.
 * Without it a view with a prompt never notifies, and a badge that counts one counts the Inbox.
 */
export interface PromptSource {
  /** The fit of the current verdict of each of these threads for the prompt of `query`; none: absent. */
  fits(query: string, threadIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  /** The number on the tab of the view with this text (rule 4). */
  badge(query: string): Promise<PromptBadge>;
}

export interface NotifierOptions {
  /** Committed data only: the reader connection (or the read thread's ports). */
  readonly read: Omit<NewMailDeps, "now">;
  /** Where the settings are kept: a JSON file next to the database. Null keeps them in memory. */
  readonly prefsPath: string | null;
  /** With no file, the settings to start from; the defaults when absent (tests). */
  readonly prefs?: NotificationPrefs;
  /** Where the watch keeps what it knows, beside the settings. Null keeps it in memory. */
  readonly statePath?: string | null;
  /** The verdicts of views with a prompt (ADR 0117). */
  readonly prompts?: PromptSource;
  readonly toMain: (event: NoticeToMain) => void;
  readonly broadcast: (event: BackendEvent) => void;
  readonly now?: () => number;
  /** The time zone, for quiet hours and a pause until tomorrow; a test passes its own. */
  readonly zone?: ZoneOffset;
  /** Commits that come close together are one look; default 700 ms. */
  readonly delayMs?: number;
  /** Verdicts that come close together are one look at the mail views hold; default 1.5 s. */
  readonly agentDelayMs?: number;
  /** The catch-up waits for every account's first sync, but no longer than this; default 2 min. */
  readonly catchUpMaxMs?: number;
  /**
   * Mail commits recount the view the badge counts at most this often; default 5 s. New verdicts,
   * a change of the settings and the start recount at once.
   */
  readonly countGapMs?: number;
}

const localZone: ZoneOffset = (ms) => -new Date(ms).getTimezoneOffset();

/** Threads whose verdicts one pass asks for. */
const MAX_THREADS = 40;
/** The most a badge of `view` counts, as the Inbox's (`inboxUnread`). */
const VIEW_CAP = 1000;
/** A window that opens this soon after the catch-up still gets its notice. */
const REPLAY_MS = 2 * 60_000;
/** Banners of one message the router still checks, newest kept: more than main holds. */
const MAX_HELD = 50;
/** A banner older than this is no longer checked; the system has long put it away. */
const HELD_MS = 48 * 60 * 60_000;
/** Read, archived or deleted: it has left Trash and Spam for no one. */
const GONE_BITS = MAILBOX_BIT.trash | MAILBOX_BIT.spam;

interface CatchUp {
  readonly mails: NewMail[];
  /** Accounts whose first sync since the start has not finished. */
  readonly waiting: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  ending: boolean;
}

export class Notifier implements NotificationsApi {
  private readonly options: NotifierOptions;
  private readonly now: () => number;
  private readonly watch: NewMailWatch;
  private prefs: NotificationPrefs = readNotificationPrefs(undefined);
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private promptTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private lastBadge: string | null = null;
  /** The number of the view the badge counts, at the last count (ADR 0117, rule 5); 0 until then. */
  private viewNumber = 0;
  private lastCountMs = Number.NEGATIVE_INFINITY;
  private countTimer: ReturnType<typeof setTimeout> | null = null;
  private catchUp: CatchUp | null = null;
  private caughtUp: { readonly notice: NoticeText; readonly atMs: number } | null = null;
  private savedState = "";
  private readonly zone: ZoneOffset;
  /**
   * Single-message banners handed to main and not yet taken back, by key: whether the message was
   * in the Inbox then (leaving it is archiving), and when (ADR 0108).
   */
  private readonly held = new Map<number, { readonly inbox: boolean; readonly atMs: number }>();
  private lastPause = "";

  constructor(options: NotifierOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.zone = options.zone ?? localZone;
    this.watch = new NewMailWatch({ ...options.read, now: this.now });
    if (options.prefs !== undefined) this.prefs = readNotificationPrefs(options.prefs);
  }

  /**
   * Reads the settings and what the watch kept. Without a kept state nothing at the start is
   * announced. With one, what came while the app was closed is gathered until every account's
   * first sync is done (or `catchUpMaxMs` passed), and then said once.
   */
  async start(): Promise<void> {
    this.prefs = await this.load();
    const state = await this.loadState();
    const caught = await this.watch.start(state).catch(() => false);
    this.started = true;
    this.announcePause();
    if (caught) {
      const accounts = await this.options.read.accounts.list().catch(() => []);
      this.catchUp = {
        mails: [],
        waiting: new Set(accounts.map((a) => a.id)),
        timer: null,
        ending: false,
      };
      if (this.catchUp.waiting.size === 0) this.endCatchUp();
      else {
        this.catchUp.timer = setTimeout(
          () => this.endCatchUp(),
          this.options.catchUpMaxMs ?? 2 * 60_000,
        );
        this.catchUp.timer.unref?.();
      }
    }
    // A commit while the watch was taking stock may have been missed: one look covers it.
    // It also counts the view the badge counts.
    this.enqueue(() => this.look());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.promptTimer) clearTimeout(this.promptTimer);
    if (this.countTimer) clearTimeout(this.countTimer);
    if (this.catchUp?.timer) clearTimeout(this.catchUp.timer);
    this.timer = null;
    this.countTimer = null;
    this.promptTimer = null;
  }

  /** The store committed: one look shortly, however many commits come in the meantime. */
  touched(): void {
    if (!this.started || this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueue(() => this.look());
    }, this.options.delayMs ?? 700);
  }

  /** The first sync of an account since the start is done: the catch-up may end. */
  synced(accountId: string): void {
    const c = this.catchUp;
    if (c === null) return;
    c.waiting.delete(accountId);
    if (c.waiting.size === 0) this.endCatchUp();
  }

  /**
   * A prompt stored verdicts (ADR 0117, rule 6), in the background or in a run: the mail views
   * with a prompt hold is looked at shortly, and a badge that counts a view is counted again.
   */
  promptsChanged(): void {
    if (!this.started || this.stopped || this.promptTimer) return;
    this.promptTimer = setTimeout(() => {
      this.promptTimer = null;
      this.enqueue(() => this.prompted());
      if (this.prefs.badge.source === "view") this.enqueue(() => this.countView());
    }, this.options.agentDelayMs ?? 1500);
  }

  /**
   * A window opened: one that came right after the catch-up was said still gets it. Only that
   * window: the others have it already.
   */
  windowOpened(send: (event: BackendEvent) => void): void {
    const c = this.caughtUp;
    if (c === null || this.now() - c.atMs > REPLAY_MS) return;
    send({ type: "notices", notices: [c.notice], seconds: this.prefs.inApp.seconds });
  }

  /** Resolves when every look queued so far is done (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  get(): NotificationPrefs {
    return this.prefs;
  }

  async set(prefs: NotificationPrefs): Promise<NotificationPrefs> {
    this.prefs = readNotificationPrefs(prefs);
    await this.save(this.prefs);
    this.options.broadcast({ type: "notificationPrefsChanged", prefs: this.prefs });
    this.announcePause();
    // A badge that now counts a view needs a count of now, not of whenever.
    this.enqueue(() => this.countView());
    return this.prefs;
  }

  /** Pause until then, or resume (null): the app menu's way to the settings (ADR 0108). */
  pause(untilMs: number | null): Promise<NotificationPrefs> {
    return this.set({ ...this.prefs, pausedUntilMs: untilMs });
  }

  /** The system refused the test banner: Settings says why. */
  bannerFailed(reason: string): void {
    this.options.broadcast({ type: "notificationTestFailed", reason: reason.slice(0, 200) });
  }

  /** Tells main whether banners are paused, for its menu; only when that changed. */
  private announcePause(): void {
    const { enabled, pausedUntilMs } = this.prefs;
    const text = `${enabled}:${pausedUntilMs}`;
    if (text === this.lastPause) return;
    this.lastPause = text;
    this.options.toMain({ type: "pause", enabled, untilMs: pausedUntilMs });
  }

  /** A made-up notice through every channel that is on; quiet hours do not stop a test. */
  test(): void {
    const sample: NoticeText = {
      key: 0,
      threadId: "",
      accountId: "",
      title: "Anna Kowalska",
      subtitle: "Contract for the spring",
      body: "This is how a notice from Matters looks.",
    };
    const { banner, inApp } = this.prefs;
    const shown =
      banner.content === "full"
        ? sample
        : banner.content === "subject"
          ? { ...sample, subtitle: undefined, body: sample.subtitle ?? "" }
          : {
              ...sample,
              title: "New mail",
              subtitle: undefined,
              body: "Open Matters to read it.",
            };
    const { subtitle, ...rest } = shown;
    this.options.toMain({
      type: "banners",
      banners: [subtitle === undefined ? rest : { ...rest, subtitle }],
      sound: banner.sound,
      whenFront: true,
    });
    this.options.broadcast({ type: "notices", notices: [sample], seconds: inApp.seconds });
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((error: unknown) => {
      console.error(
        "matters-backend: notifications:",
        error instanceof Error ? error.message : "unknown",
      );
    });
  }

  private quiet(): boolean {
    const now = this.now();
    return isQuiet(this.prefs, now, localMinuteOf(now, this.zone));
  }

  /**
   * Hands a plan to main and the windows, and keeps what it told. `inbox` says which messages are
   * in the Inbox, so that a banner of one is taken back when it is archived.
   */
  private show(plan: NoticePlan, inbox: ReadonlyMap<number, boolean> = new Map()): void {
    if (plan.banners.length > 0) {
      const now = this.now();
      for (const b of plan.banners) {
        if (b.alone !== true || b.key <= 0) continue;
        this.held.delete(b.key);
        this.held.set(b.key, { inbox: inbox.get(b.key) === true, atMs: now });
      }
      while (this.held.size > MAX_HELD) {
        const first = this.held.keys().next().value;
        if (first === undefined) break;
        this.held.delete(first);
      }
      this.options.toMain({
        type: "banners",
        banners: plan.banners,
        sound: plan.sound,
        whenFront: plan.whenFront,
      });
    }
    if (plan.inApp.length > 0) {
      this.options.broadcast({
        type: "notices",
        notices: plan.inApp,
        seconds: this.prefs.inApp.seconds,
      });
    }
    this.watch.follow(plan.badged);
    this.watch.tell(plan.told);
  }

  private async look(): Promise<void> {
    if (this.stopped) return;
    const prefs = this.prefs;
    const viewIds = prefs.enabled ? Object.keys(prefs.views) : [];
    const mails = await this.watch.look(viewIds);
    if (this.catchUp !== null) this.catchUp.mails.push(...mails);
    else if (mails.length > 0 && prefs.enabled) {
      const inbox = new Map(mails.map((m) => [m.message.key, m.inbox]));
      this.show(planNotices(prefs, mails, this.quiet(), this.now()), inbox);
    }
    // Mail that came or left changes what the view counts: it is counted again, but not on every
    // commit of a sync.
    if (this.countDue()) await this.countView();
    else {
      await this.badge();
      this.countLater();
    }
    await this.keep();
    // A view may have given its verdict before the look saw the mail.
    if (mails.length > 0 && this.catchUp === null) await this.prompted();
  }

  private endCatchUp(): void {
    const c = this.catchUp;
    if (c === null || c.ending) return;
    c.ending = true;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    // One more look takes what the last commits brought, then the catch-up is said.
    this.enqueue(async () => {
      await this.look();
      this.catchUp = null;
      if (this.stopped) return;
      const plan = planCatchUp(this.prefs, c.mails, this.now());
      this.show(plan);
      const notice = plan.inApp[0];
      if (notice !== undefined) this.caughtUp = { notice, atMs: this.now() };
      await this.badge();
      await this.keep();
      await this.prompted();
    });
  }

  /**
   * Mail that views with a prompt hold (ADR 0117, rule 6): once its thread has a current verdict
   * for a view's prompt, the view no longer waits, and a fit of 2 or 3 notifies through that
   * view's channels that the mail has not gone through yet. A thread with no verdict waits for
   * as long as the watch keeps the mail (48 hours), then nothing notifies from that
   * view. A view that no longer notifies, or is gone, waits no more. For a thread with several
   * new messages, the newest is the one told.
   */
  private async prompted(): Promise<void> {
    const source = this.options.prompts;
    const prefs = this.prefs;
    if (this.stopped || source === undefined || !prefs.enabled || this.catchUp !== null) return;
    const waiting = this.watch.waiting();
    if (waiting.length === 0) return;
    const views = new Map((await this.options.read.views.list()).map((v) => [v.id, v]));
    let changed = false;
    const byView = new Map<string, (typeof waiting)[number][]>();
    for (const t of waiting) {
      for (const id of t.waiting) {
        const c = prefs.views[id];
        if (!views.has(id) || c === undefined || !(c.banner || c.inApp || c.badge)) {
          this.watch.settle(t.key, [id]);
          changed = true;
          continue;
        }
        const list = byView.get(id);
        if (list) list.push(t);
        else byView.set(id, [t]);
      }
    }
    const fitting = new Map<number, string[]>();
    for (const [id, mails] of byView) {
      const view = views.get(id);
      if (view === undefined) continue;
      const threads = [...new Set(mails.map((m) => m.threadId))].slice(0, MAX_THREADS);
      const fits = await source.fits(view.query, threads);
      for (const threadId of threads) {
        const fit = fits.get(threadId);
        if (fit === undefined) continue;
        // Newest first, as `waiting` gives them.
        const ofThread = mails.filter((m) => m.threadId === threadId);
        for (const m of ofThread) this.watch.settle(m.key, [id]);
        changed = true;
        const newest = ofThread[0];
        if (newest === undefined || fit < PROMPT_SHOWN_FIT) continue;
        const list = fitting.get(newest.key);
        if (list) list.push(id);
        else fitting.set(newest.key, [id]);
      }
    }
    if (fitting.size > 0) {
      const told = new Map(waiting.map((t) => [t.key, t.channels]));
      const mails: PromptMail[] = [];
      for (const message of await this.options.read.store.getByKeys([...fitting.keys()])) {
        const channels = told.get(message.key);
        const ids = fitting.get(message.key);
        if (channels === undefined || ids === undefined) continue;
        mails.push({ message, told: channels, views: ids });
      }
      const inbox = new Map(
        mails.map((m) => [m.message.key, ((m.message.mailboxes ?? 0) & MAILBOX_BIT.inbox) !== 0]),
      );
      this.show(planPromptNotices(prefs, mails, this.quiet(), this.now()), inbox);
      await this.badge();
    }
    if (changed) await this.keep();
  }

  /** The badge shows a count kept here: the number of a view (ADR 0117, rule 5). */
  private countsView(): boolean {
    const { enabled, badge } = this.prefs;
    return enabled && badge.source === "view";
  }

  /**
   * The number of the view the badge counts (ADR 0117, rule 5): for a view with a prompt, what its
   * tab shows (rule 4), none for one never run; for any other view its unread mail, as its tab
   * counts it. A view that is gone, none chosen, or a view with a prompt while AI is off: the
   * Inbox. A read that fails throws, and the badge keeps what it said.
   */
  private async viewCount(): Promise<number> {
    const id = this.prefs.badge.viewId;
    const view =
      id === undefined
        ? undefined
        : (await this.options.read.views.list()).find((v) => v.id === id);
    if (view === undefined) return this.watch.inboxUnread();
    if (parseQuery(view.query).prompt !== undefined) {
      const prompts = this.options.prompts;
      if (prompts === undefined) return this.watch.inboxUnread();
      const b = await prompts.badge(view.query);
      return b.ai === "off" ? this.watch.inboxUnread() : (b.unread ?? 0);
    }
    const deps = {
      index: this.options.read.index,
      accounts: this.options.read.accounts,
      now: this.now,
    };
    let total = 0;
    let beforeKey: number | undefined;
    do {
      const r = await countMatches(deps, view.query, {
        cap: VIEW_CAP - total,
        ...(beforeKey === undefined ? {} : { beforeKey }),
      });
      total += r.count;
      beforeKey = r.nextBeforeKey;
    } while (beforeKey !== undefined && total < VIEW_CAP);
    return Math.min(total, VIEW_CAP);
  }

  /**
   * The view the badge counts, counted again, and the badge set from it. Only while the badge
   * counts a view; a failed read keeps the last count.
   */
  private async countView(): Promise<void> {
    if (this.stopped) return;
    if (this.countTimer) clearTimeout(this.countTimer);
    this.countTimer = null;
    if (this.countsView()) {
      this.lastCountMs = this.now();
      try {
        this.viewNumber = await this.viewCount();
      } catch {
        // The badge keeps what it said; the next verdict or commit counts again.
      }
    }
    await this.badge();
  }

  private countWait(): number {
    return Math.max(0, this.lastCountMs + (this.options.countGapMs ?? 5000) - this.now());
  }

  /** After a mail commit, a count is due now when none ran for the gap and none is waiting. */
  private countDue(): boolean {
    return this.countsView() && this.countTimer === null && this.countWait() === 0;
  }

  /** Otherwise one count when the gap is over, however many commits come until then. */
  private countLater(): void {
    if (this.stopped || this.countTimer || !this.countsView()) return;
    const wait = this.countWait();
    this.countTimer = setTimeout(() => {
      this.countTimer = null;
      this.enqueue(() => this.countView());
    }, wait);
    this.countTimer.unref?.();
  }

  /**
   * Counts again and tells main only when the text changed. The banners still out are checked in
   * the same read when the badge follows told mail; otherwise in a read of their own, and not at
   * all when none is out.
   */
  private async badge(): Promise<void> {
    const { enabled, badge } = this.prefs;
    const now = this.now();
    for (const [key, h] of this.held) if (h.atMs < now - HELD_MS) this.held.delete(key);
    const held = [...this.held.keys()];
    let count = 0;
    let out: readonly Message[] = [];
    if (enabled && badge.source === "notified") {
      const r = await this.watch.recount(held);
      count = r.notified;
      out = r.also;
    } else {
      if (enabled && badge.source === "inbox") count = await this.watch.inboxUnread();
      if (this.countsView()) count = this.viewNumber;
      if (held.length > 0) out = await this.options.read.store.getByKeys(held);
    }
    if (held.length > 0) this.takeBack(held, out);
    const text = badgeText(count, badge.style);
    if (text === this.lastBadge) return;
    this.lastBadge = text;
    this.options.toMain({ type: "badge", text });
  }

  /** Banners whose message was read, archived or deleted go (ADR 0108). Main closes what it holds. */
  private takeBack(keys: readonly number[], now: readonly Message[]): void {
    const byKey = new Map(now.map((m) => [m.key, m]));
    const gone: number[] = [];
    for (const key of keys) {
      const h = this.held.get(key);
      const m = byKey.get(key);
      const bits = m?.mailboxes ?? 0;
      const over =
        m === undefined ||
        m.flags.seen ||
        (bits & GONE_BITS) !== 0 ||
        (h?.inbox === true && (bits & MAILBOX_BIT.inbox) === 0);
      if (!over) continue;
      gone.push(key);
      this.held.delete(key);
    }
    if (gone.length > 0) this.options.toMain({ type: "close", keys: gone });
  }

  private async load(): Promise<NotificationPrefs> {
    const path = this.options.prefsPath;
    if (path === null) return this.prefs;
    try {
      return readNotificationPrefs(JSON.parse(await readFile(path, "utf8")));
    } catch {
      // No file yet, or one that cannot be read: the defaults, and the next save writes it.
      return readNotificationPrefs(undefined);
    }
  }

  private async save(prefs: NotificationPrefs): Promise<void> {
    const path = this.options.prefsPath;
    if (path === null) return;
    await writeAside(path, `${JSON.stringify(prefs, null, 2)}\n`);
  }

  private async loadState(): Promise<WatchState | null> {
    const path = this.options.statePath ?? null;
    if (path === null) return null;
    try {
      return readWatchState(JSON.parse(await readFile(path, "utf8")));
    } catch {
      // No file (a first run) or a broken one: the watch starts from what is there.
      return null;
    }
  }

  /** Writes what the watch knows when it changed. The time of the look alone is not worth a write. */
  private async keep(): Promise<void> {
    const path = this.options.statePath ?? null;
    if (path === null) return;
    const { lookedAtMs: _, ...rest } = this.watch.snapshot();
    const same = JSON.stringify(rest);
    if (same === this.savedState) return;
    this.savedState = same;
    await writeAside(path, `${JSON.stringify(this.watch.snapshot())}\n`);
  }
}

/** Written aside and renamed: a crash leaves the old file or the new one, never half of one. */
async function writeAside(path: string, text: string): Promise<void> {
  const aside = `${path}.${process.pid}.tmp`;
  await writeFile(aside, text, { mode: 0o600 });
  await rename(aside, path);
}
