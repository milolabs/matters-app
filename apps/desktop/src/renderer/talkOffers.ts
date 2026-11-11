// What an answer across all mail offers, and what each press does (ADR 0102). Nothing here runs
// until the person presses: a view is saved through the call that creates views, a clean-up runs
// through the list's own move and read paths (one action, one tray line, one Undo), and a message
// opens in the composer. Pure where it can be, so the words and the decisions are tested.
import type {
  ActMatch,
  MoveAction,
  NoticeChannels,
  NotificationPrefs,
  SavedView,
  TalkActAction,
  TalkActOffer,
  TalkFact,
  TalkMessageOffer,
  TalkOffer,
  TalkViewOffer,
} from "@matters/core";
import { COUNT_CAP, foldText, sameQueryText } from "@matters/core";
import type { Backend } from "./client.ts";
import type { MoveSubject } from "./store.ts";

export type OfferOutcome =
  | { readonly ok: true; readonly note?: string }
  | { readonly ok: false; readonly message: string };

/** "128 messages · 12 unread"; past the cap "500+ messages · 12+ unread". */
export function offerCount(o: { matches: number; matchesCapped: boolean; unread: number }): string {
  const plus = o.matchesCapped ? "+" : "";
  const messages = `${o.matches}${plus} ${o.matches === 1 && !o.matchesCapped ? "message" : "messages"}`;
  if (o.unread === 0) return messages;
  return `${messages} · ${o.unread}${plus} unread`;
}

// --- view ---

/**
 * The saved view an offer became, if any: the same name ignoring case and the same query text.
 * Read from the person's views now, never stored with the answer, so a view deleted later is
 * offered again.
 */
export function savedViewFor(
  offer: Pick<TalkViewOffer, "name" | "query">,
  saved: readonly SavedView[],
): SavedView | undefined {
  const name = foldText(offer.name.trim());
  const query = sameQueryText(offer.query);
  return saved.find((v) => foldText(v.name.trim()) === name && sameQueryText(v.query) === query);
}

/** Every channel on: what a view gets when saving it should tell the person (ADR 0071). */
export const VIEW_NOTIFY: NoticeChannels = { banner: true, inApp: true, badge: true };

/** The prefs with this view notifying on every channel; the rest as it was. */
export function withViewNotifying(prefs: NotificationPrefs, viewId: string): NotificationPrefs {
  return { ...prefs, views: { ...prefs.views, [viewId]: VIEW_NOTIFY } };
}

export const NOTIFY_FAILED =
  "The view is saved, but its notifications could not be turned on. Turn them on in Settings › Notifications.";

/** What saving a view offer needs: the call that creates a view, and the notification prefs. */
export interface ViewSaving {
  create(
    name: string,
    query: string,
  ): Promise<
    | { readonly ok: true; readonly view: SavedView }
    | { readonly ok: false; readonly message: string }
  >;
  readonly backend: Pick<Backend, "getNotificationPrefs" | "setNotificationPrefs">;
}

/**
 * Saves one view offer, and turns on its notifications when it asks to notify. A view that was
 * saved stays saved when the prefs cannot be written; the row says so.
 */
export async function saveViewOffer(offer: TalkViewOffer, deps: ViewSaving): Promise<OfferOutcome> {
  const made = await deps.create(offer.name, offer.query);
  if (!made.ok) return made;
  if (offer.notify !== true) return { ok: true };
  try {
    const prefs = await deps.backend.getNotificationPrefs();
    await deps.backend.setNotificationPrefs(withViewNotifying(prefs, made.view.id));
    return { ok: true };
  } catch {
    return { ok: true, note: NOTIFY_FAILED };
  }
}

/**
 * Saves the view offers not saved yet, one after the other. Returns what each that did not simply
 * succeed said, by its place in `offers`; a failure does not stop the rest.
 */
export async function saveViewOffers(
  offers: readonly TalkOffer[],
  saved: () => readonly SavedView[],
  save: (offer: TalkViewOffer) => Promise<OfferOutcome>,
): Promise<ReadonlyMap<number, OfferOutcome>> {
  const said = new Map<number, OfferOutcome>();
  for (const [i, offer] of offers.entries()) {
    if (offer.kind !== "view" || savedViewFor(offer, saved()) !== undefined) continue;
    const out = await save(offer);
    if (!out.ok || out.note !== undefined) said.set(i, out);
  }
  return said;
}

// --- act ---

const ACT_VERB: Readonly<Record<TalkActAction, string>> = {
  archive: "Archive",
  trash: "Move to Trash",
  markRead: "Mark read",
};

/** The list's own action for a clean-up that moves; mark read is not a move. */
export const MOVE_OF: Readonly<Record<Exclude<TalkActAction, "markRead">, MoveAction>> = {
  archive: "archive",
  trash: "delete",
};

const messages = (n: number) => `${n} ${n === 1 ? "message" : "messages"}`;
const threads = (n: number) => `${n} ${n === 1 ? "thread" : "threads"}`;

/** The row's line: what it would do, with the code's count. */
export function actLine(o: TalkActOffer): string {
  const plus = o.matchesCapped ? "+" : "";
  if (o.action === "markRead")
    return `Mark ${o.unread}${plus} unread ${o.unread === 1 && !o.matchesCapped ? "message" : "messages"} read`;
  const what = `${o.matches}${plus} ${o.matches === 1 && !o.matchesCapped ? "message" : "messages"}`;
  return o.action === "archive" ? `Archive ${what}` : `Move ${what} to Trash`;
}

/** The action button's words. */
export const actButton = (action: TalkActAction): string => ACT_VERB[action];

/** Over the cap, or counted to the cap: too many to do from here, only to show (ADR 0102, rule 7). */
export function actTooMany(o: Pick<TalkActOffer, "matches" | "matchesCapped">): boolean {
  return o.matchesCapped || o.matches > COUNT_CAP;
}

export const TOO_MANY = "Too many to do from here. Show them, and act on them from the list.";

/** What a clean-up acts on, as the query matches it now in the scope of its count. */
export interface ResolvedAct {
  readonly messages: readonly ActMatch[];
  /** Each thread once, with its account, as the list's move takes it. */
  readonly threads: readonly MoveSubject[];
  /** More than `COUNT_CAP` match now: nothing is done from here. */
  readonly tooMany: boolean;
}

/**
 * What the query matches when the person presses (ADR 0102, rule 7), matched by the backend as
 * the offer's count was: the accounts agreed to, without the threads the person's rules cover, up
 * to the cap. The count at the time of the offer is not what is acted on; this is, and the
 * confirmation says how much it is. `Show them` shows the person's whole search, which may hold
 * more.
 */
export async function resolveAct(
  backend: Pick<Backend, "agentMatchAct">,
  query: string,
): Promise<ResolvedAct> {
  const found = await backend.agentMatchAct(query);
  const byThread = new Map<string, MoveSubject>();
  for (const m of found.messages) {
    if (!byThread.has(m.threadId)) {
      byThread.set(m.threadId, {
        threadId: m.threadId,
        accountId: m.accountId,
        subject: m.subject,
      });
    }
  }
  return {
    messages: found.messages,
    threads: [...byThread.values()],
    tooMany: found.capped || found.messages.length > COUNT_CAP,
  };
}

/** The unread messages of what was resolved: what mark read changes. */
export const unreadOf = (r: ResolvedAct): readonly number[] =>
  r.messages.filter((m) => !m.seen).map((m) => m.key);

/**
 * The question asked in place before anything runs, with the count of what will happen. A move
 * takes whole threads (ADR 0056), so it names the threads; mark read names the messages it marks.
 * Null when there is nothing to do.
 */
export function actQuestion(action: TalkActAction, r: ResolvedAct): string | null {
  if (action === "markRead") {
    const n = unreadOf(r).length;
    return n === 0 ? null : `Mark ${messages(n)} read?`;
  }
  if (r.threads.length === 0) return null;
  const verb = action === "archive" ? "Archive" : "Move";
  const where = action === "archive" ? "" : " to Trash";
  return `${verb} ${threads(r.threads.length)}${where}? They hold the ${messages(r.messages.length)} that match, and move whole.`;
}

/** What the row says once it ran. */
export function actDone(action: TalkActAction, r: ResolvedAct): string {
  if (action === "markRead") return `Marked ${messages(unreadOf(r).length)} read.`;
  return action === "archive"
    ? `Archived ${threads(r.threads.length)}. Undo is in the tray at the bottom.`
    : `Moved ${threads(r.threads.length)} to Trash. Undo is in the tray at the bottom.`;
}

/** The list's own paths: the same move as a group of rows, the same mark as `u`. */
export interface ActPaths {
  moveThreads(
    subjects: readonly MoveSubject[],
    action: MoveAction,
  ): Promise<"moved" | "nothing" | "failed">;
  markSeen(keys: readonly number[], seen: boolean): Promise<void>;
}

/** Runs a clean-up on what was resolved and confirmed. Never more than the cap. */
export async function runAct(
  action: TalkActAction,
  r: ResolvedAct,
  paths: ActPaths,
): Promise<OfferOutcome> {
  if (r.tooMany) return { ok: false, message: TOO_MANY };
  if (action === "markRead") {
    const keys = unreadOf(r);
    if (keys.length === 0) return { ok: false, message: "Nothing is unread any more." };
    try {
      await paths.markSeen(keys, true);
      return { ok: true };
    } catch {
      return { ok: false, message: "That did not work. Try again." };
    }
  }
  const out = await paths.moveThreads(r.threads, MOVE_OF[action]);
  if (out === "moved") return { ok: true };
  return out === "nothing"
    ? { ok: false, message: "There was nothing left to move." }
    : { ok: false, message: "That did not work. Try again." };
}

// --- message ---

/** The first lines of a body, for the row. */
export function bodyPreview(body: string, lines = 3): string {
  const kept = body
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(0, lines);
  const more = body.split("\n").filter((l) => l.trim() !== "").length > lines;
  return `${kept.join("\n")}${more ? "\n…" : ""}`;
}

/** The line under a message offer that names who was left out, and why. */
export function unknownLine(o: TalkMessageOffer): string | null {
  if (o.unknownTo.length === 0) return null;
  return `Not added: ${o.unknownTo.join(", ")} — you have not written to ${o.unknownTo.length === 1 ? "them" : "these addresses"} before.`;
}

/** What the composer opens with: nothing is stored until the person writes in it or sends. */
export interface DraftPrefill {
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
}

export const prefillOf = (o: TalkMessageOffer): DraftPrefill => ({
  to: o.to,
  subject: o.subject,
  body: o.body,
});

// --- facts ---

/** One line of the counts under an answer: what was counted, and the code's numbers. */
export interface FactLine {
  readonly label: string;
  /** The query, shown in the mono face. */
  readonly query?: string;
  readonly count: string;
}

/** The counts an answer rests on, as the lines shown under it (ADR 0102, rule 9). */
export function factLines(facts: readonly TalkFact[], rows = 5): FactLine[] {
  const out: FactLine[] = [];
  for (const f of facts) {
    if (f.kind === "count") {
      out.push({
        label: "Counted",
        query: f.query,
        count: offerCount({ matches: f.matches, matchesCapped: f.capped, unread: f.unread }),
      });
      continue;
    }
    const months = `${f.months} ${f.months === 1 ? "month" : "months"}`;
    for (const r of f.senders.slice(0, rows)) {
      out.push({
        label: `Wrote most, last ${months}: ${r.name === undefined ? r.key : `${r.name} <${r.key}>`}`,
        count: offerCount({ matches: r.messages, matchesCapped: false, unread: r.unread }),
      });
    }
  }
  return out;
}
