import type { ChangesEvent, ThreadMessage } from "@matters/contracts";
import type { Label, LabelRoleOf, Message, MoveAction, MoveTarget, Thread } from "@matters/core";
import {
  asksFor,
  asksForHidden,
  describeNothing,
  folderNamed,
  hasRole,
  isEmptyQuery,
  isHiddenMailbox,
  type KeyOrder,
  leavesView,
  listLimit,
  listOrder,
  MOVE_UNDO_WINDOW_MS,
  parseQuery,
  planMove,
  resolvePlace,
  targetOf,
} from "@matters/core";
import { batch, createSignal } from "solid-js";
import { type AutoReadOptions, createAutoRead } from "./autoRead.ts";
import type { Backend } from "./client.ts";
import { mergeMessages } from "./merge.ts";
import { type MoveLine, type MovesStore, NO_MOVES, TOO_LATE } from "./moves.ts";
import { mark } from "./trace.ts";

export const PAGE_SIZE = 200;

/**
 * Whether the text constrains anything (ADR 0025). `from:`, `is:un` or ` -- ` do not, and the
 * list treats them as no query at all, so it does not empty while the user is typing. A `limit:`
 * without a prompt does (ADR 0116, rule 4a): the backend's search lists that many, the newest,
 * and stops paging there, also for `limit:` alone. So does `sort:oldest` (rule 4b): the search
 * walks the key the other way, also over all mail.
 */
export function isConstrained(text: string): boolean {
  const parsed = parseQuery(text);
  return !isEmptyQuery(parsed) || listLimit(parsed) !== undefined || listOrder(parsed) === "oldest";
}

/** Which way the dated list of the text runs (ADR 0116, rule 4b). */
function orderOf(text: string): KeyOrder {
  return listOrder(parseQuery(text));
}

export interface OpenThread {
  readonly thread: Thread;
  readonly messages: readonly ThreadMessage[];
}

/** Keyboard focus zone; `search` is the input, `reader` the reading pane. */
export type Zone = "list" | "search" | "reader";

/** What marking read asked of a message, until the worker's answer is in the list (ADR 0039). */
interface SeenIntent {
  readonly seen: boolean;
  readonly id: number;
  readonly atMs: number;
  /** The change sequence of the write once the command resolved; null while it is on the way. */
  settledSeq: number | null;
}

/** An intent that no event ever caught up with is let go after this long. */
const INTENT_MAX_MS = 10_000;

/** A row that left the list because the reader moved its thread (ADR 0044, rule 9). */
interface Departure {
  /** The action it belongs to, for taking it back. */
  readonly operationId: string | null;
  /** The change sequence of the write once the command resolved; null while it is on the way. */
  settledSeq: number | null;
  readonly atMs: number;
  /** Deleted for good: it is gone when the server confirmed, which is a removal, not a change. */
  readonly forever: boolean;
}

/** An action made by this window, for taking it back and for putting the selection where it was. */
interface MadeMove {
  readonly threadId: string;
  /** The row the selection went to when the thread left, if any. */
  readonly landedOn: number | undefined;
}

/** What moving a thread needs to know of it: a row of the list. */
export interface MoveSubject {
  readonly threadId: string;
  readonly accountId: string;
  readonly subject: string;
}

/** A forever-delete that no event ever confirmed is let go after this long (the rows come back). */
const FOREVER_MAX_MS = 30_000;

export interface MailStoreOptions {
  /** Dwell time and timer of the countdown that reads a thread (tests inject theirs). */
  readonly autoRead?: Pick<Partial<AutoReadOptions>, "dwellMs" | "setTimeout">;
  readonly now?: () => number;
  /** The tray's side of moving (ADR 0044); without it a move has no line. */
  readonly moves?: Pick<MovesStore, "begin" | "say" | "forget" | "idOf">;
  /** The folders of every account, for what a move does and what a `label:` names. */
  readonly folders?: () => readonly Label[];
}

const realTimeout = (run: () => void, delayMs: number) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

/** `list` with `message` put where its key belongs; the list is newest first, or oldest first. */
function insertByKey(
  list: readonly Message[],
  message: Message,
  order: KeyOrder = "newest",
): readonly Message[] {
  const at = list.findIndex((m) =>
    order === "oldest" ? m.key > message.key : m.key < message.key,
  );
  return at < 0 ? [...list, message] : [...list.slice(0, at), message, ...list.slice(at)];
}

export function createMailStore(backend: Backend, options: MailStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const moves = (options.moves ?? NO_MOVES) as Pick<
    MovesStore,
    "begin" | "say" | "forget" | "idOf"
  >;
  const folders = options.folders ?? (() => []);
  const [messages, setMessages] = createSignal<readonly Message[]>([]);
  const [query, setQueryText] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const [thread, setThread] = createSignal<OpenThread | null>(null);
  const [zone, setZone] = createSignal<Zone>("list");
  const [loaded, setLoaded] = createSignal(false);
  // The unfiltered list had no mail the last time it was looked at (a search result does not count).
  const [mailboxEmpty, setMailboxEmpty] = createSignal(true);
  // More of a search is being fetched window by window (ADR 0025): an empty list is not final.
  const [searching, setSearching] = createSignal(false);

  // Latest-wins: a slower, older response must never overwrite a newer one.
  let listSeq = 0;
  let threadSeq = 0;
  // Bumped whenever the list is replaced wholesale: a fetch loop that began before it stops.
  let fillGen = 0;
  // Where the next page starts. A signal: the count in the toolbar reads it through `hasMore`.
  const [cursor, setCursor] = createSignal<number | undefined>(undefined);
  let loadingMore = false;
  const settledListeners = new Set<(query: string) => void>();
  const queryListeners = new Set<(query: string) => void>();
  // The list reports how far its view moved so it can keep the first visible row in place.
  const shiftListeners = new Set<(rows: number) => void>();
  let anchorKey: () => number | undefined = () => undefined;
  let applying: Promise<void> = Promise.resolve();
  // A thread chosen in the search panel that the list may not hold yet (ADR 0076).
  let wantThread: { id: string; until: number } | null = null;
  // Rows that left because their thread was moved: kept out of every fetch until the matching
  // change has been applied, like the read state below (ADR 0044, rule 9).
  const departed = new Map<number, Departure>();
  const made = new Map<string, MadeMove>();
  // Whether the open thread was fetched with its deleted messages (a view of Trash or Spam).
  let openHidden = false;
  // ADR 0116, rule 7: the query whose prompt's rows stand in for the mail filters' result, in the
  // prompt's order. Null: the list is the result of the query, as always.
  let ordered: string | null = null;
  const [isOrdered, setIsOrdered] = createSignal(false);
  // Those rows are by date (a prompt under `sort:newest` or `sort:oldest`, rule 4b): day headings.
  const [orderedDated, setOrderedDated] = createSignal(false);

  // Read and unread (ADR 0039). What the reader asked for stays on top of what is fetched until
  // the worker has committed it and an event at least as new as the commit has been applied, so
  // an older `changes` event cannot flash the old state back.
  const intents = new Map<number, SeenIntent>();
  let intentSeq = 0;
  let appliedSeq = 0;
  // The row the reader is on, kept in a list that no longer matches it once they marked it read.
  // It is always the selected row, and it goes the moment the selection moves.
  let held: number | null = null;
  // The thread whose countdown is running: the list drains the dots of its unread rows.
  const [readingThread, setReadingThread] = createSignal<string | null>(null);
  const autoRead = createAutoRead({
    ...options.autoRead,
    setTimeout: options.autoRead?.setTimeout ?? realTimeout,
    onDwell: (threadId) => markOpenThreadRead(threadId),
    onCounting: setReadingThread,
  });

  /** What a `label:` value names, as far as Trash and Spam go (ADR 0044, rule 3). */
  const labelRole: LabelRoleOf = (folded) => folders().find((f) => folderNamed(f, folded))?.role;
  const queryRoot = () => parseQuery(query()).root;
  /** The query asks for Trash or Spam, so its mail is shown and acted on whole. */
  const asksHidden = () => asksForHidden(queryRoot(), labelRole);

  /** `list` without the rows the reader moved away and the server may not have caught up with. */
  function withoutDeparted<T extends Message>(list: readonly T[]): readonly T[] {
    if (departed.size === 0 || !list.some((m) => departed.has(m.key))) return list;
    return list.filter((m) => !departed.has(m.key));
  }

  /** `list` with what the reader asked for over it: rows that left stay away, read state holds. */
  function overlay<T extends Message>(list: readonly T[]): readonly T[] {
    return overlaySeen(withoutDeparted(list));
  }

  /** `list` with the reader's pending read state over it; the same array when nothing differs. */
  function overlaySeen<T extends Message>(list: readonly T[]): readonly T[] {
    if (intents.size === 0) return list;
    let out: T[] | null = null;
    list.forEach((m, i) => {
      const intent = intents.get(m.key);
      if (intent && m.flags.seen !== intent.seen) {
        out ??= [...list];
        out[i] = { ...m, flags: { ...m.flags, seen: intent.seen } };
      }
    });
    return out ?? list;
  }

  function overlayThread(open: OpenThread): OpenThread {
    const messages = overlaySeen(open.messages);
    if (messages === open.messages) return open;
    const unreadCount = messages.filter((m) => !m.flags.seen).length;
    return { thread: { ...open.thread, unreadCount }, messages };
  }

  function releaseIntents(removedKeys: readonly number[] = []) {
    for (const [key, intent] of intents) {
      const caughtUp = intent.settledSeq !== null && appliedSeq >= intent.settledSeq;
      if (caughtUp || now() - intent.atMs > INTENT_MAX_MS) intents.delete(key);
    }
    for (const [key, d] of departed) {
      const caughtUp = d.settledSeq !== null && appliedSeq >= d.settledSeq;
      // A deletion for good is over when the message is gone; until then the server may refuse.
      const over = d.forever ? removedKeys.includes(key) : caughtUp;
      if (over || (d.forever && now() - d.atMs > FOREVER_MAX_MS)) departed.delete(key);
    }
  }

  /** One page from `cursor`: below it newest first, or above it under `sort:oldest`. */
  async function fetchPage(text: string, cursor?: number) {
    if (!isConstrained(text)) {
      const page = { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { beforeKey: cursor }) };
      const r = await backend.listNewest(page);
      const last = r.messages[r.messages.length - 1];
      return {
        messages: r.messages,
        next: r.messages.length === PAGE_SIZE && last ? last.key : undefined,
      };
    }
    const oldest = orderOf(text) === "oldest";
    const r = await backend.search({
      query: text,
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : oldest ? { afterKey: cursor } : { beforeKey: cursor }),
    });
    return { messages: r.messages, next: oldest ? r.nextAfterKey : r.nextBeforeKey };
  }

  async function openSelected() {
    const message = messages()[selected()];
    const seq = ++threadSeq;
    if (!message) {
      setThread(null);
      return;
    }
    const hidden = asksHidden();
    if (thread()?.thread.id === message.threadId && openHidden === hidden) return;
    // A thread that was just moved away may have nothing left to show: the list moves on.
    const r = await backend.openThread(message.threadId, hidden).catch(() => null);
    if (seq !== threadSeq) return;
    if (r === null) {
      setThread(null);
      return;
    }
    openHidden = hidden;
    setThread(overlayThread({ thread: r.thread, messages: r.messages }));
    mark("thread-open");
  }

  /**
   * Fetches windows below `after` into the list until a page's worth is in, or nothing older
   * is left. A window may be short or empty and still have a cursor. Paints after each one.
   */
  async function fill(text: string, seq: number, gen: number, count: number) {
    let have = 0;
    while (have < count && cursor() !== undefined) {
      const page = await fetchPage(text, cursor());
      if (seq !== listSeq || gen !== fillGen) return;
      setMessages((current) => [...current, ...overlay(page.messages)]);
      setCursor(page.next);
      have += page.messages.length;
    }
  }

  /** Runs on every keystroke: no debounce, stale answers are dropped. */
  async function run(text: string) {
    const seq = ++listSeq;
    const page = await fetchPage(text);
    if (seq !== listSeq) return;
    const gen = ++fillGen;
    const constrained = isConstrained(text);
    const more = constrained && page.messages.length < PAGE_SIZE && page.next !== undefined;
    held = null;
    // A thread asked for while this list was on its way (ADR 0076) is selected when it is in it.
    const want = wantThread !== null && wantThread.until > Date.now() ? wantThread.id : null;
    wantThread = null;
    const wanted = want === null ? -1 : page.messages.findIndex((m) => m.threadId === want);
    const first = Math.max(wanted, 0);
    batch(() => {
      setMessages(overlay(page.messages));
      setSelected(first);
      setLoaded(true);
      setSearching(more);
      if (!constrained) setMailboxEmpty(page.messages.length === 0);
    });
    setCursor(page.next);
    // The first window is what settles: the smoke test times that, the rest streams in.
    for (const listener of settledListeners) listener(text);
    // The app selected the first row, not the reader: nothing is counted for it.
    autoRead.displaced(page.messages[first]?.threadId ?? null);
    void openSelected();
    if (!more) return;
    try {
      await fill(text, seq, gen, PAGE_SIZE - page.messages.length);
    } finally {
      if (gen === fillGen) setSearching(false);
    }
  }

  async function loadMore() {
    // While a search is still filling the first page it is the one asking for more.
    if (loadingMore || searching() || cursor() === undefined) return;
    loadingMore = true;
    const seq = listSeq;
    const gen = fillGen;
    try {
      await fill(query(), seq, gen, PAGE_SIZE);
    } finally {
      loadingMore = false;
    }
  }

  /** Rows the first visible message moved down by when the list changed under it. */
  function reportShift(anchor: number | undefined, before: readonly Message[]) {
    if (anchor === undefined) return;
    const was = before.findIndex((m) => m.key === anchor);
    const now = messages().findIndex((m) => m.key === anchor);
    if (was >= 0 && now >= 0 && now !== was) for (const l of shiftListeners) l(now - was);
  }

  /** Follows the selected message to its new index; clamps when it is gone. */
  function keepSelection(selectedKey: number | undefined) {
    const list = messages();
    const at = selectedKey === undefined ? -1 : list.findIndex((m) => m.key === selectedKey);
    setSelected(at >= 0 ? at : Math.min(selected(), Math.max(list.length - 1, 0)));
  }

  /**
   * ADR 0116, rule 7: the rows a prompt kept, in its order, in place of the result of `text`, or
   * null to go back to that result. Only for the text in the bar: an answer for older text is
   * dropped. The selection stays on its thread when the thread is still listed.
   */
  function showOrdered(text: string, rows: readonly Message[] | null, dated = false): void {
    if (text !== query()) return;
    if (rows === null) {
      if (ordered === null) return;
      ordered = null;
      batch(() => {
        setIsOrdered(false);
        setOrderedDated(false);
      });
      void run(text);
      return;
    }
    // A list or fill of the mail filters that is on its way must not land over these rows.
    listSeq++;
    fillGen++;
    ordered = text;
    held = null;
    const before = messages()[selected()];
    const next = overlay(rows);
    const at = before === undefined ? -1 : next.findIndex((m) => m.threadId === before.threadId);
    batch(() => {
      setIsOrdered(true);
      setOrderedDated(dated);
      setMessages(next);
      setSelected(Math.max(at, 0));
      setSearching(false);
      setLoaded(true);
    });
    setCursor(undefined);
    const now = next[Math.max(at, 0)];
    if (now?.threadId !== before?.threadId) {
      // The app moved the selection, not the reader: nothing is counted for it.
      autoRead.displaced(now?.threadId ?? null);
      void openSelected();
    }
  }

  /**
   * A change while a prompt's rows are shown: the rows keep their places, their messages are read
   * again, and what was removed or moved away goes. Which threads fit is the prompt's to say.
   */
  async function applyOrdered(event: ChangesEvent) {
    const seq = listSeq;
    const listed = new Set(messages().map((m) => m.key));
    const keys = event.changedKeys.filter((k) => listed.has(k));
    const fetched = new Map<number, Message>();
    for (let i = 0; i < keys.length; i += 500) {
      for (const m of (await backend.getMessages(keys.slice(i, i + 500))).messages) {
        fetched.set(m.key, m);
      }
    }
    if (seq !== listSeq) return;
    appliedSeq = Math.max(appliedSeq, event.changeSeq);
    releaseIntents(event.removedKeys);
    const before = messages();
    const selectedKey = before[selected()]?.key;
    const removed = new Set(event.removedKeys);
    const next = overlay(
      before.filter((m) => !removed.has(m.key)).map((m) => fetched.get(m.key) ?? m),
    );
    batch(() => {
      setMessages(next);
      keepSelection(selectedKey);
    });
    const current = messages()[selected()];
    if (current?.key !== selectedKey) {
      autoRead.displaced(current?.threadId ?? null);
      if (current) void openSelected();
      else {
        threadSeq++;
        setThread(null);
      }
      return;
    }
    const open = thread();
    if (open && keys.some((k) => fetched.get(k)?.threadId === open.thread.id)) {
      const r = await backend.openThread(open.thread.id, openHidden).catch(() => null);
      if (r && seq === listSeq && messages()[selected()]?.threadId === open.thread.id) {
        setThread(overlayThread({ thread: r.thread, messages: r.messages }));
      }
    }
  }

  async function applyChanges(event: ChangesEvent) {
    if (event.changedKeys.length + event.removedKeys.length === 0) return;
    if (ordered !== null) return applyOrdered(event);
    const seq = listSeq;
    const text = query();
    const filtered = isConstrained(text);

    const fetched: Message[] = [];
    let page: Awaited<ReturnType<typeof fetchPage>> | undefined;
    if (filtered) {
      // The backend decides what matches a query: ask again for the first page. A short or
      // empty first window must not blank the list, so go on until a page is full.
      page = await fetchPage(text);
      while (seq === listSeq && page.messages.length < PAGE_SIZE && page.next !== undefined) {
        const more = await fetchPage(text, page.next);
        page = { messages: [...page.messages, ...more.messages], next: more.next };
      }
    } else {
      for (let i = 0; i < event.changedKeys.length; i += 500) {
        fetched.push(...(await backend.getMessages(event.changedKeys.slice(i, i + 500))).messages);
      }
    }
    if (seq !== listSeq) return;

    // From here on without awaiting: what is read is what gets replaced.
    const before = messages();
    const selectedKey = before[selected()]?.key;
    const anchor = anchorKey();
    let next: readonly Message[];
    if (page) {
      let found = overlay(page.messages);
      const row = before[selected()];
      const removed = new Set(event.removedKeys);
      const last = found[found.length - 1];
      const order = orderOf(text);
      // The row being read stays even if the refresh no longer matches it (it was marked read in
      // an `is:unread` list): it goes when the reader moves to another. A deleted row is gone,
      // and so is one past the window this page covers (below it, or above it oldest first).
      // New mail of an oldest-first list lands past the first page, so only a short list shows it.
      const stays =
        row !== undefined &&
        !found.some((m) => m.key === row.key) &&
        !removed.has(row.key) &&
        (page.next === undefined ||
          (last !== undefined && (order === "oldest" ? row.key < last.key : row.key > last.key)));
      if (stays) {
        found = insertByKey(found, overlay([row])[0] as Message, order);
        held = row.key;
      } else {
        // The row matches again, or the reader is elsewhere.
        held = null;
      }
      next = found;
      setCursor(page.next);
      fillGen++; // a fetch loop of the list it replaces must not append to this one
      setSearching(false);
    } else {
      // All mail leaves out what is in Trash or Spam (ADR 0044, rule 3): a message that was
      // deleted is a change to the store and a removal from this list.
      const away = new Set(event.removedKeys);
      for (const m of fetched) if (isHiddenMailbox(m.mailboxes ?? 0)) away.add(m.key);
      next = mergeMessages(before, overlay(fetched), away, cursor() === undefined);
      if (cursor() === undefined && next.length >= PAGE_SIZE) {
        setCursor((next[next.length - 1] as Message).key);
      }
      setMailboxEmpty(next.length === 0);
    }
    appliedSeq = Math.max(appliedSeq, event.changeSeq);
    releaseIntents(event.removedKeys);
    if (next !== before) {
      batch(() => {
        setMessages(next);
        keepSelection(selectedKey);
      });
      reportShift(anchor, before);
    }

    const current = messages()[selected()];
    if (!current) {
      held = null;
      autoRead.displaced(null);
      setThread(null);
      return;
    }
    // The selected message is gone or none was selected: show what the selection landed on. This
    // is the app's doing, not the reader's, so nothing starts counting for it.
    if (current.key !== selectedKey) {
      held = null;
      autoRead.displaced(current.threadId);
      void openSelected();
      return;
    }
    // An open thread that got a new reply shows it.
    const open = thread();
    const changed = new Set(event.changedKeys);
    if (open && next.some((m) => changed.has(m.key) && m.threadId === open.thread.id)) {
      const r = await backend.openThread(open.thread.id, openHidden).catch(() => null);
      if (r && seq === listSeq && messages()[selected()]?.threadId === open.thread.id) {
        setThread(overlayThread({ thread: r.thread, messages: r.messages }));
      }
    }
  }

  /** Message keys of the thread that are unread now: the open thread, and the list's rows of it. */
  function unreadKeys(threadId: string): number[] {
    const keys = new Set<number>();
    const open = thread();
    if (open?.thread.id === threadId) {
      for (const m of open.messages) if (!m.flags.seen) keys.add(m.key);
    }
    for (const m of messages()) if (m.threadId === threadId && !m.flags.seen) keys.add(m.key);
    return [...keys];
  }

  /** Puts `seen` on these messages in the list and the open thread; nothing else moves. */
  function patchSeen(keys: ReadonlySet<number>, seen: boolean) {
    const withState = <T extends Message>(m: T): T =>
      keys.has(m.key) && m.flags.seen !== seen ? { ...m, flags: { ...m.flags, seen } } : m;
    batch(() => {
      const list = messages();
      if (list.some((m) => keys.has(m.key) && m.flags.seen !== seen))
        setMessages(list.map(withState));
      const open = thread();
      if (open?.messages.some((m) => keys.has(m.key) && m.flags.seen !== seen)) {
        const patched = open.messages.map(withState);
        setThread({
          thread: { ...open.thread, unreadCount: patched.filter((m) => !m.flags.seen).length },
          messages: patched,
        });
      }
    });
  }

  /**
   * Marks messages read or unread. The list and the open thread change before anything is said
   * to the backend (ADR 0012: one frame); what the reader asked for is kept on top of every
   * fetch until the worker's commit has come back as an event, so an older event cannot show the
   * old state. If the backend refuses, the intents go and the messages are fetched again.
   */
  async function markSeen(keys: readonly number[], seen: boolean): Promise<void> {
    const wanted = [...new Set(keys)];
    if (wanted.length === 0) return;
    const id = ++intentSeq;
    for (const key of wanted) intents.set(key, { seen, id, atMs: now(), settledSeq: null });
    patchSeen(new Set(wanted), seen);
    try {
      const done = await backend.setSeen(wanted, seen);
      for (const key of wanted) {
        const intent = intents.get(key);
        if (intent?.id === id)
          intent.settledSeq = done.changedKeys.length === 0 ? 0 : done.changeSeq;
      }
      releaseIntents();
    } catch {
      for (const key of wanted) if (intents.get(key)?.id === id) intents.delete(key);
      // Back to what the backend has.
      await applyChangesInOrder({
        type: "changes",
        changeSeq: appliedSeq,
        changedKeys: wanted,
        removedKeys: [],
      });
    }
  }

  /** The countdown ran out: the open thread was read. */
  function markOpenThreadRead(threadId: string) {
    if (messages()[selected()]?.threadId !== threadId) return;
    const keys = unreadKeys(threadId);
    if (keys.length > 0) void markSeen(keys, true);
  }

  /**
   * `u` on the selected row: an unread row marks the whole thread read, a read one marks only
   * its message unread. Either way the countdown stops and does not come back for this thread
   * until the reader selects it again.
   */
  function toggleSeen(): void {
    const row = messages()[selected()];
    if (!row) return;
    autoRead.settled(row.threadId);
    if (row.flags.seen) {
      void markSeen([row.key], false);
      return;
    }
    const keys = unreadKeys(row.threadId);
    // Before the thread has arrived the row may be the only one known; the others follow.
    if (thread()?.thread.id === row.threadId) {
      void markSeen(keys.length > 0 ? keys : [row.key], true);
      return;
    }
    void markSeen([row.key], true);
    void backend.openThread(row.threadId).then(
      (r) => {
        const rest = r.messages.filter((m) => !m.flags.seen && m.key !== row.key).map((m) => m.key);
        void markSeen(rest, true);
      },
      () => {},
    );
  }

  /** Where the selection goes: a held row, the one the reader leaves, is dropped from the list. */
  function moveTo(target: number) {
    const list = messages();
    const from = selected();
    const heldAt = held === null ? -1 : list.findIndex((m) => m.key === held);
    // A key that goes nowhere (`j` on the last row) leaves the reader on it: the row is still held.
    if (heldAt !== target) held = null;
    if (heldAt >= 0 && heldAt !== target) {
      // The neighbour keeps its place in line: its index shifts by the row that went away.
      const anchor = anchorKey();
      const rest = list.filter((_, i) => i !== heldAt);
      const index = target > heldAt ? target - 1 : target;
      batch(() => {
        setMessages(rest);
        setSelected(index);
      });
      reportShift(anchor, list);
    } else if (target !== from) {
      setSelected(target);
    }
    const row = messages()[selected()];
    if (row) autoRead.chose(row.threadId);
    void openSelected();
  }

  /** What the store knows of a thread: the open one, else its rows in the list. */
  function knownMessages(threadId: string): readonly Message[] {
    const open = thread();
    return open?.thread.id === threadId
      ? open.messages
      : messages().filter((m) => m.threadId === threadId);
  }

  /**
   * Takes every row of a thread out of the list in one step and puts the selection on the next
   * older row, which is the row now at the same index, or the last (ADR 0044, rule 9). This is the
   * app's selection, not the reader's: nothing is counted for it (ADR 0039, rule 2), and a held
   * row is let go. Returns the keys that left and the row the selection landed on.
   */
  function dropThreads(threadIds: ReadonlySet<string>): {
    keys: number[];
    landedOn: number | undefined;
    /** The selected row was one of them, so the selection had to go somewhere else. */
    moved: boolean;
  } {
    const before = messages();
    const at = selected();
    const keys = before.filter((m) => threadIds.has(m.threadId)).map((m) => m.key);
    if (keys.length === 0) return { keys, landedOn: before[at]?.key, moved: false };
    const anchor = anchorKey();
    const rest = before.filter((m) => !threadIds.has(m.threadId));
    const gone = before.slice(0, at).filter((m) => threadIds.has(m.threadId)).length;
    const index = Math.max(0, Math.min(at - gone, rest.length - 1));
    const moved = before[at] !== undefined && threadIds.has(before[at].threadId);
    if (moved) held = null;
    batch(() => {
      setMessages(rest);
      setSelected(index);
    });
    reportShift(anchor, before);
    const landed = rest[index];
    // A row elsewhere in the list left: the reader stays on what they were reading.
    if (!moved) return { keys, landedOn: landed?.key, moved };
    autoRead.displaced(landed?.threadId ?? null);
    if (landed) void openSelected();
    else {
      threadSeq++;
      setThread(null);
    }
    return { keys, landedOn: landed?.key, moved };
  }

  /** Brings the rows of a failed or undone move back from the backend. */
  function refetch(keys: readonly number[]): Promise<void> {
    return applyChangesInOrder({
      type: "changes",
      changeSeq: appliedSeq,
      changedKeys: [...keys],
      removedKeys: [],
    });
  }

  /**
   * Moves the selected row's thread (ADR 0044). In the frame of the key, before anything is said to
   * the backend: the line appears in the tray, and when the thread leaves this view its rows go and
   * the selection moves on. What left stays away from every fetch until the commit has come back as
   * an event. A thread with nothing left to move changes nothing but the tray (rule 5).
   */
  async function moveThread(action: MoveAction, target?: MoveTarget): Promise<void> {
    const row = messages()[selected()];
    if (row) await moveThreads([row], action, target);
  }

  /**
   * The same for any threads, whether or not they are selected (ADR 0056, rule 6): one action, one
   * line in the tray and one Undo. Says what became of it, so Matters can follow.
   */
  async function moveThreads(
    subjects: readonly MoveSubject[],
    action: MoveAction,
    target?: MoveTarget,
  ): Promise<"moved" | "nothing" | "failed"> {
    const byThread = new Map(subjects.map((s) => [s.threadId, s]));
    const group = [...byThread.values()];
    const [first] = group;
    if (first === undefined) return "nothing";
    const hidden = asksHidden();
    let name: string | undefined;
    let known = 0;
    let planned = 0;
    let silent = false;
    for (const subject of group) {
      const own = folders().filter((f) => f.accountId === subject.accountId);
      const place = resolvePlace(own, targetOf(action, target));
      if (subject === first && action === "move") name = place.name;
      const taken = knownMessages(subject.threadId).filter(
        (m) => hidden || !isHiddenMailbox(m.mailboxes ?? 0),
      );
      if (taken.length === 0) silent = true;
      known += taken.length;
      planned += taken.filter(
        (m) =>
          planMove({ labelIds: m.labelIds, mailboxes: m.mailboxes ?? 0 }, action, place, own) !==
          null,
      ).length;
    }
    const named = name;
    // Only what the store knows: a thread it has not heard of yet is asked of the backend.
    if (!silent && known > 0 && planned === 0) {
      moves.say(describeNothing(action, named));
      return "nothing";
    }

    const settle = moves.begin(
      {
        action,
        count: Math.max(planned, 1),
        subject: group.length === 1 ? first.subject || "(no subject)" : `${group.length} threads`,
        ...(named === undefined ? {} : { place: named }),
      },
      MOVE_UNDO_WINDOW_MS,
    );
    const selectedRow = messages()[selected()];
    const left = leavesView(queryRoot(), action, labelRole)
      ? dropThreads(new Set(byThread.keys()))
      : { keys: [] as number[], landedOn: selectedRow?.key, moved: false };
    for (const key of left.keys) {
      departed.set(key, { operationId: null, settledSeq: null, atMs: now(), forever: false });
    }
    try {
      const others = group.slice(1).map((s) => s.threadId);
      const done = await backend.moveThread({
        threadId: first.threadId,
        ...(others.length === 0 ? {} : { others }),
        action,
        ...(target === undefined ? {} : { target }),
        ...(hidden ? { hidden } : {}),
      });
      settle(done.operationId);
      if (done.operationId === null) {
        // The store knew less than the backend: there was nothing to move after all.
        for (const key of left.keys) departed.delete(key);
        moves.say(describeNothing(action, named));
        if (left.keys.length > 0) await refetch(left.keys);
        return "nothing";
      }
      // Undo puts the selection back only onto a thread this move took it from.
      if (selectedRow !== undefined && byThread.has(selectedRow.threadId)) {
        made.set(done.operationId, { threadId: selectedRow.threadId, landedOn: left.landedOn });
        if (made.size > 20) made.delete(made.keys().next().value as string);
      }
      for (const key of left.keys) {
        const d = departed.get(key);
        if (d)
          departed.set(key, { ...d, operationId: done.operationId, settledSeq: done.changeSeq });
      }
      releaseIntents();
      return "moved";
    } catch {
      settle(null);
      for (const key of left.keys) departed.delete(key);
      moves.say("Couldn't move: that did not work.");
      if (left.keys.length > 0) await refetch(left.keys);
      return "failed";
    }
  }

  /**
   * Marks several rows at once (ADR 0056, rule 4). Read takes their whole threads, as `u` does on an
   * unread row; unread takes only the rows, as `u` does on a read one.
   */
  function markRows(rows: readonly Message[], seen: boolean): void {
    for (const row of rows) autoRead.settled(row.threadId);
    if (!seen) {
      void markSeen(
        rows.map((r) => r.key),
        false,
      );
      return;
    }
    const threads = [...new Set(rows.map((r) => r.threadId))];
    void markSeen([...rows.map((r) => r.key), ...threads.flatMap(unreadKeys)], true);
    const open = thread()?.thread.id;
    void (async () => {
      // One at a time: the router has one thread, and a keystroke may be waiting.
      for (const id of threads) {
        if (id === open) continue;
        const r = await backend.openThread(id).catch(() => null);
        if (r)
          await markSeen(
            r.messages.filter((m) => !m.flags.seen).map((m) => m.key),
            true,
          );
      }
    })();
  }

  /** The reader looks at something else for now (a stack): nothing is counted (ADR 0056, rule 3). */
  function pauseReading(paused: boolean): void {
    autoRead.displaced(paused ? null : (messages()[selected()]?.threadId ?? null));
  }

  /**
   * Takes a move back (ADR 0044, rule 10): the rows come back with their labels as they were, and
   * the selection returns to the thread when the reader has not moved on since it left.
   */
  async function undoMove(line: MoveLine): Promise<"undone" | "tooLate" | "gone"> {
    const id = await moves.idOf(line);
    if (id === null) return "gone";
    const result = await backend.undoMove(id).catch(() => ({ kind: "tooLate" }) as const);
    if (result.kind === "tooLate") {
      moves.say(TOO_LATE);
      moves.forget(id);
      return "tooLate";
    }
    moves.forget(id);
    if (result.kind === "gone") return "gone";
    const mine = made.get(id);
    made.delete(id);
    const back: number[] = [];
    for (const [key, d] of departed) {
      if (d.operationId !== id) continue;
      departed.delete(key);
      back.push(key);
    }
    const reader = messages()[selected()]?.key;
    await applyChangesInOrder({
      type: "changes",
      changeSeq: result.changeSeq,
      changedKeys: [...new Set([...back, ...result.keys])],
      removedKeys: [],
    });
    // Back to the thread, unless the reader has gone somewhere else since it left.
    if (mine && reader === mine.landedOn) {
      const at = messages().findIndex((m) => m.threadId === mine.threadId);
      if (at >= 0) {
        batch(() => setSelected(at));
        autoRead.displaced(mine.threadId);
        void openSelected();
      }
    }
    return "undone";
  }

  /** The messages of the open thread that are in Trash: what Delete forever would remove. */
  function trashedKeys(): number[] {
    const open = thread();
    if (!open) return [];
    return open.messages.filter((m) => hasRole(m.mailboxes ?? 0, "trash")).map((m) => m.key);
  }

  /** The same for rows of any threads, as far as the store knows them. */
  function trashedKeysOf(rows: readonly Message[]): number[] {
    return [...new Set(rows.map((r) => r.threadId))]
      .flatMap((id) => knownMessages(id))
      .filter((m) => hasRole(m.mailboxes ?? 0, "trash"))
      .map((m) => m.key);
  }

  /**
   * Deletes the messages that are in Trash for good (ADR 0044, rules 7 and 16): the open thread's,
   * or those of the rows given. The rows go at once and stay away until the server has confirmed; a
   * refusal brings them back.
   */
  async function deleteForever(rows?: readonly Message[]): Promise<void> {
    const row = messages()[selected()];
    const keys = rows === undefined ? trashedKeys() : trashedKeysOf(rows);
    const threads = rows === undefined ? (row ? [row.threadId] : []) : rows.map((r) => r.threadId);
    if (threads.length === 0 || keys.length === 0) return;
    const left = dropThreads(new Set(threads));
    for (const key of left.keys) {
      departed.set(key, { operationId: null, settledSeq: null, atMs: now(), forever: true });
    }
    try {
      const done = await backend.deleteForever(keys);
      if (done.refused.length > 0) {
        for (const key of left.keys) departed.delete(key);
        moves.say("Couldn't delete: those messages are not in Trash.");
        await refetch(left.keys);
      }
    } catch {
      for (const key of left.keys) departed.delete(key);
      moves.say("Couldn't delete: that did not work.");
      await refetch(left.keys);
    }
  }

  function applyChangesInOrder(event: ChangesEvent) {
    applying = applying.then(() => applyChanges(event)).catch(() => {});
    return applying;
  }

  return {
    messages,
    /** True once the first list has arrived. */
    loaded,
    mailboxEmpty,
    /** More of the current search is on its way; an empty list is not yet "nothing found". */
    searching,
    /** The text constrains something; false for `""`, `from:`, ` -- ` (shown as the whole mailbox). */
    filtered: () => isConstrained(query()),
    query,
    selected,
    thread,
    zone,
    setZone,
    start: () => run(""),
    setQuery(text: string) {
      // New text is the mail filters' again until its prompt is read (ADR 0116, rule 2).
      const keep = ordered !== null && ordered === text;
      if (ordered !== null && !keep) {
        ordered = null;
        setIsOrdered(false);
        setOrderedDated(false);
      }
      setQueryText(text);
      for (const listener of queryListeners) listener(text);
      // The same text again keeps the prompt's rows.
      if (!keep) void run(text);
    },
    /** Called on every change of the query text (the views' badges stand down while typing). */
    onQueryChange(listener: (query: string) => void) {
      queryListeners.add(listener);
      return () => queryListeners.delete(listener);
    },
    move(delta: number) {
      const count = messages().length;
      if (count === 0) return;
      moveTo(Math.min(Math.max(selected() + delta, 0), count - 1));
    },
    select(index: number) {
      if (index < 0 || index >= messages().length) return;
      moveTo(index);
    },
    /**
     * Shows a thread chosen in the search panel (ADR 0076): its row when the list holds it, else
     * the thread itself in the reader, and its row once a list that is on its way has it.
     */
    async showThread(threadId: string): Promise<void> {
      const at = messages().findIndex((m) => m.threadId === threadId);
      if (at >= 0) {
        moveTo(at);
        return;
      }
      wantThread = { id: threadId, until: Date.now() + 3000 };
      const seq = ++threadSeq;
      const hidden = asksHidden();
      const r = await backend.openThread(threadId, hidden).catch(() => null);
      if (seq !== threadSeq || r === null) return;
      openHidden = hidden;
      setThread(overlayThread({ thread: r.thread, messages: r.messages }));
    },
    markSeen,
    toggleSeen,
    /** Archive, delete, mark as spam or move the selected row's thread (ADR 0044). */
    moveThread,
    moveThreads,
    markRows,
    pauseReading,
    undoMove,
    deleteForever,
    trashedKeys,
    trashedKeysOf,
    /** The query asks for Trash or Spam: `Delete` is Delete forever there, and threads show whole. */
    viewAsksHidden: asksHidden,
    /** The query asks for Trash itself. */
    viewAsksTrash: () => asksFor(queryRoot(), "trash", labelRole),
    /** What the store knows of a thread, for the Move list. */
    knownMessages,
    readingThread,
    /** The window gained or lost focus: the countdown that reads a thread runs only with it. */
    setWindowFocused: (focused: boolean) => autoRead.focus(focused),
    /** The row that is kept although the list no longer matches it, if any. */
    heldKey: () => held,
    loadMore,
    /** A `changes` event from the backend; handled one at a time, in order. */
    applyChanges: applyChangesInOrder,
    /** The list tells the store which message is first on screen, to keep it there. */
    setAnchor(provider: () => number | undefined) {
      anchorKey = provider;
    },
    onShift(listener: (rows: number) => void) {
      shiftListeners.add(listener);
      return () => shiftListeners.delete(listener);
    },
    hasMore: () => cursor() !== undefined,
    showOrdered,
    /** The list holds a prompt's or a ranked order's rows, not the mail filters' result. */
    ordered: isOrdered,
    /** Those rows are by date all the same (ADR 0116, rule 4b): the list keeps its headings. */
    orderedDated,
    /** Smoke hook: called right after a result set was applied to the signals. */
    onSettled(listener: (query: string) => void) {
      settledListeners.add(listener);
      return () => settledListeners.delete(listener);
    },
  };
}

export type MailStore = ReturnType<typeof createMailStore>;
