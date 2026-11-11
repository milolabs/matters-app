import type { Message } from "../domain/entities.ts";
import { MAILBOX_BIT } from "../domain/mailbox.ts";
import {
  type ArrivalMark,
  arrivalsBetween,
  type DueSaid,
  MAX_BADGED,
  MAX_DUES,
  MAX_MARKS,
  MAX_TOLD,
  type NewMail,
  type NoticeChannels,
  type Told,
  type ToldMail,
  type WatchState,
} from "../domain/notifications.ts";
import type {
  AccountStorePort,
  ArrivalPort,
  MessageStorePort,
  SavedViewStorePort,
  SearchIndexPort,
} from "../ports/index.ts";
import { type ParsedQuery, parseQuery } from "./parseQuery.ts";

export interface NewMailDeps {
  readonly index: Pick<SearchIndexPort, "searchChunk" | "matchesAmong">;
  readonly store: Pick<MessageStorePort, "getByKeys" | "getThread">;
  readonly arrivals: ArrivalPort;
  readonly views: Pick<SavedViewStorePort, "list">;
  readonly accounts: Pick<AccountStorePort, "list">;
  readonly now: () => number;
}

export interface NewMailOptions {
  /** What was told is remembered this long; `matters` can ring for it until then. */
  readonly keepMs?: number;
  /** The most new messages one look takes; the rest arrived too, and is not announced. */
  readonly limit?: number;
}

const KEEP_MS = 48 * 60 * 60_000;
const LIMIT = 200;
/** Threads asked whether you wrote in them, per look: the rest count as not. */
const MAX_THREADS = 40;
/** Unread keys the Inbox badge counts before it stops (`inbox`). */
const INBOX_CAP = 1000;

const UNREAD = { kind: "flag", flag: "unread" } as const;
const NO_CHANNELS: NoticeChannels = { banner: false, inApp: false, badge: false };

function query(root: ParsedQuery["root"]): ParsedQuery {
  return { root, tokens: [], diagnostics: [] };
}

/**
 * Finds the mail that is new since the last look (ADR 0106, rule 1). New means unread and stored
 * at a UID above the folder's mark of the last look: it arrived since, whatever its Date header
 * says. A folder without a mark (an account added today, a new folder) and older UIDs (a backfill)
 * bring nothing. The marks, the badge and what was told can be kept across a restart
 * (`snapshot`); a watch started from them finds what came while the app was closed.
 */
export class NewMailWatch {
  private readonly deps: NewMailDeps;
  private readonly keepMs: number;
  private readonly limit: number;
  private marks: readonly ArrivalMark[] = [];
  private lookedAtMs = 0;
  /** Mail already looked at, so a message in two folders is new once. */
  private readonly told = new Map<number, ToldMail>();
  /** Keys the badge counts while they stay unread. */
  private readonly badged = new Set<number>();
  /** Deadlines already said, with the end of their day. */
  private readonly dues = new Map<string, number>();
  /** Deadlines said inside the window whose banner is still owed, with the end of their day. */
  private readonly duesHeld = new Map<string, number>();

  constructor(deps: NewMailDeps, options: NewMailOptions = {}) {
    this.deps = deps;
    this.keepMs = options.keepMs ?? KEEP_MS;
    this.limit = options.limit ?? LIMIT;
  }

  /**
   * Without a state, takes what is there now as seen: opening the app rings nothing. With one,
   * goes on from its marks, so the next look finds what came while the app was closed, and the
   * badge follows what it followed. Returns whether it went on from a state.
   */
  async start(state: WatchState | null = null): Promise<boolean> {
    const now = await this.deps.arrivals.marks();
    this.lookedAtMs = this.deps.now();
    if (state === null) {
      this.marks = now;
      return false;
    }
    this.marks = state.marks;
    for (const key of state.badged.slice(0, MAX_BADGED)) this.badged.add(key);
    for (const t of state.told) this.told.set(t.key, t);
    for (const [id, end] of Object.entries(state.dues)) this.dues.set(id, end);
    for (const [id, end] of Object.entries(state.duesHeld)) this.duesHeld.set(id, end);
    this.forgetOld();
    return true;
  }

  /** What to keep for the next start. */
  snapshot(): WatchState {
    return {
      lookedAtMs: this.lookedAtMs,
      marks: this.marks.slice(0, MAX_MARKS),
      badged: [...this.badged],
      told: [...this.told.values()].slice(-MAX_TOLD),
      dues: Object.fromEntries(this.dues),
      duesHeld: Object.fromEntries(this.duesHeld),
    };
  }

  /**
   * The mail that came since the last look. `viewIds` are the saved views that notify: each new
   * message says which of them it is in.
   */
  async look(viewIds: readonly string[] = []): Promise<readonly NewMail[]> {
    const { spans, marks } = arrivalsBetween(this.marks, await this.deps.arrivals.marks());
    const keys = spans.length === 0 ? [] : await this.deps.arrivals.unreadIn(spans, this.limit);
    this.marks = marks;
    const now = this.deps.now();
    this.lookedAtMs = now;
    this.forgetOld();
    const fresh = keys.filter((key) => !this.told.has(key));
    if (fresh.length === 0) return [];

    const { store } = this.deps;
    const [messages, accounts] = await Promise.all([
      store.getByKeys(fresh),
      this.deps.accounts.list(),
    ]);
    const mine = new Set(accounts.map((a) => a.address.toLowerCase()));
    const { inViews, prompted } = await this.viewsOf(fresh, viewIds, accounts);

    const threads = [...new Set(messages.map((m) => m.threadId))].slice(0, MAX_THREADS);
    const wrote = new Set<string>();
    for (const id of threads) {
      const view = await store.getThread(id, { visibleOnly: true });
      const sent = view?.messages.some(
        (m) =>
          ((m.mailboxes ?? 0) & MAILBOX_BIT.sent) !== 0 || mine.has(m.from.address.toLowerCase()),
      );
      if (sent) wrote.add(id);
    }

    const out = messages.map((message) => ({
      message,
      inbox: ((message.mailboxes ?? 0) & MAILBOX_BIT.inbox) !== 0,
      fromMe: mine.has(message.from.address.toLowerCase()),
      youWrote: wrote.has(message.threadId),
      views: inViews.get(message.key) ?? [],
      ...(prompted.has(message.key) ? { prompted: prompted.get(message.key) ?? [] } : {}),
    }));
    for (const m of out) {
      // Your own mail is never asked about again: it never notifies.
      const waiting = m.fromMe ? [] : (m.prompted ?? []);
      this.remember({
        key: m.message.key,
        threadId: m.message.threadId,
        atMs: now,
        channels: NO_CHANNELS,
        decided: m.fromMe,
        ...(waiting.length > 0 ? { waiting } : {}),
      });
    }
    return out;
  }

  /** The channels these messages went through; they are not used for them again. */
  tell(told: readonly Told[]): void {
    for (const { key, channels } of told) {
      const t = this.told.get(key);
      if (t === undefined) continue;
      this.told.set(key, {
        ...t,
        channels: {
          banner: t.channels.banner || channels.banner,
          inApp: t.channels.inApp || channels.inApp,
          badge: t.channels.badge || channels.badge,
        },
      });
    }
  }

  /** Mail whose reading the agent may still give, newest first. */
  undecided(): readonly ToldMail[] {
    return [...this.told.values()].filter((t) => !t.decided).sort((a, b) => b.key - a.key);
  }

  /** The agent's reading after these messages came was looked at. */
  decide(keys: readonly number[]): void {
    for (const key of keys) {
      const t = this.told.get(key);
      if (t !== undefined) this.told.set(key, { ...t, decided: true });
    }
  }

  /**
   * Mail that views with a prompt still wait to hear about (ADR 0117, rule 6), newest first: each
   * until its thread's verdict is looked at, or the mail is let go after `keepMs`.
   */
  waiting(): readonly (ToldMail & { readonly waiting: readonly string[] })[] {
    return [...this.told.values()]
      .filter((t): t is ToldMail & { waiting: readonly string[] } => (t.waiting?.length ?? 0) > 0)
      .sort((a, b) => b.key - a.key);
  }

  /** These views looked at the verdict of this message's thread: they do not wait any more. */
  settle(key: number, viewIds: readonly string[]): void {
    const t = this.told.get(key);
    if (t?.waiting === undefined) return;
    const gone = new Set(viewIds);
    const left = t.waiting.filter((id) => !gone.has(id));
    const { waiting: _was, ...rest } = t;
    this.told.set(key, left.length > 0 ? { ...rest, waiting: left } : rest);
  }

  /** Deadlines already said, by `dueId`. */
  saidDues(): ReadonlySet<string> {
    return new Set(this.dues.keys());
  }

  /** Deadlines said inside the window whose banner quiet or a pause held back. */
  heldDues(): ReadonlySet<string> {
    return new Set(this.duesHeld.keys());
  }

  /**
   * These deadlines were said: `done` ones for good, the others with their banner still owed.
   * Each is let go once its day (`endMs`) is over. When the list is full, the one whose day ends
   * first gives way: a deadline not kept as said would be said again every hour.
   */
  sayDues(dues: readonly DueSaid[]): void {
    for (const d of dues) {
      this.duesHeld.delete(d.id);
      this.dues.delete(d.id);
      const into = d.done ? this.dues : this.duesHeld;
      into.set(d.id, d.endMs);
      while (this.dues.size + this.duesHeld.size > MAX_DUES) {
        const first = soonest(this.duesHeld) ?? soonest(this.dues);
        if (first === undefined) break;
        if (!this.duesHeld.delete(first)) this.dues.delete(first);
      }
    }
  }

  /** The badge follows these keys (`notified`) until they are read. */
  follow(keys: readonly number[]): void {
    for (const key of keys) {
      if (this.badged.size >= MAX_BADGED) break;
      this.badged.add(key);
    }
  }

  /** How many followed messages are still unread and in the Inbox; read ones are let go. */
  async notifiedUnread(): Promise<number> {
    return (await this.recount()).notified;
  }

  /**
   * `notifiedUnread`, and the messages of `also` as they are now, in one read: the banners still
   * out are checked with the badge (ADR 0108). A key of `also` that is gone is not in `also`.
   */
  async recount(
    also: readonly number[] = [],
  ): Promise<{ readonly notified: number; readonly also: readonly Message[] }> {
    if (this.badged.size === 0 && also.length === 0) return { notified: 0, also: [] };
    const wanted = new Set(also);
    const messages = await this.deps.store.getByKeys([...new Set([...this.badged, ...also])]);
    const still = new Set<number>();
    const found: Message[] = [];
    for (const m of messages) {
      if (wanted.has(m.key)) found.push(m);
      if (!this.badged.has(m.key)) continue;
      if (!m.flags.seen && ((m.mailboxes ?? 0) & MAILBOX_BIT.inbox) !== 0) still.add(m.key);
    }
    for (const key of this.badged) if (!still.has(key)) this.badged.delete(key);
    return { notified: still.size, also: found };
  }

  /** Unread mail in the Inbox, counted up to 1000. */
  async inboxUnread(): Promise<number> {
    const q = query({ kind: "and", children: [{ kind: "in", role: "inbox" }, UNREAD] });
    let count = 0;
    let beforeKey: number | undefined;
    do {
      const chunk = await this.deps.index.searchChunk(q, {
        limit: 500,
        ...(beforeKey === undefined ? {} : { beforeKey }),
      });
      count += chunk.keys.length;
      beforeKey = chunk.nextBeforeKey;
    } while (beforeKey !== undefined && count < INBOX_CAP);
    return Math.min(count, INBOX_CAP);
  }

  private async viewsOf(
    keys: readonly number[],
    viewIds: readonly string[],
    accounts: readonly { id: string; address: string; displayName: string }[],
  ): Promise<{ inViews: Map<number, string[]>; prompted: Map<number, string[]> }> {
    const out = new Map<number, string[]>();
    const prompted = new Map<number, string[]>();
    if (viewIds.length === 0) return { inViews: out, prompted };
    const wanted = new Set(viewIds);
    const views = (await this.deps.views.list()).filter((v) => wanted.has(v.id));
    const ctx = {
      nowMs: this.deps.now(),
      accounts: accounts.map((a) => ({ id: a.id, address: a.address, displayName: a.displayName })),
    };
    for (const view of views) {
      const parsed = parseQuery(view.query, ctx);
      // ADR 0117, rule 6: a view with a prompt holds what its mail filters match until its
      // verdict comes. A prompt alone (no filters) holds every new message.
      if (parsed.prompt !== undefined) {
        const matching = parsed.root ? await this.deps.index.matchesAmong(parsed, keys) : keys;
        for (const key of matching) {
          const list = prompted.get(key);
          if (list) list.push(view.id);
          else prompted.set(key, [view.id]);
        }
        continue;
      }
      // A view with no constraint is the whole mailbox: that is what the kinds are for.
      if (!parsed.root) continue;
      for (const key of await this.deps.index.matchesAmong(parsed, keys)) {
        const list = out.get(key);
        if (list) list.push(view.id);
        else out.set(key, [view.id]);
      }
    }
    return { inViews: out, prompted };
  }

  private remember(t: ToldMail): void {
    this.told.delete(t.key);
    this.told.set(t.key, t);
    // The oldest go first: a map keeps the order things were put in.
    while (this.told.size > MAX_TOLD) {
      const first = this.told.keys().next().value;
      if (first === undefined) break;
      this.told.delete(first);
    }
  }

  /** What was told is let go after `keepMs`, and a deadline once its day is over. */
  private forgetOld(): void {
    const now = this.deps.now();
    for (const [key, t] of this.told) if (t.atMs < now - this.keepMs) this.told.delete(key);
    for (const [id, end] of this.dues) if (end <= now) this.dues.delete(id);
    for (const [id, end] of this.duesHeld) if (end <= now) this.duesHeld.delete(id);
  }
}

function soonest(ends: ReadonlyMap<string, number>): string | undefined {
  let id: string | undefined;
  let at = Number.POSITIVE_INFINITY;
  for (const [k, end] of ends) {
    if (end < at) {
      at = end;
      id = k;
    }
  }
  return id;
}
