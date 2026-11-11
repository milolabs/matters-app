// The talk with the agent about the open thread, or across all mail (ADR 0064). This store holds
// what the person typed, the turn that is running in each scope, and the talk the backend keeps for
// the scope in view (a local read that spends nothing). A scope is a thread or all mail. Words, the
// turn, the problem and the entries are kept per scope, so a turn in a thread and one across all
// mail run side by side and neither loses text. It does not depend on a mounted component: `sync`
// is called when the open thread may have changed. A turn runs in the backend and never blocks this
// window, so typing, reading and moving between talks wait for no model.
import type { TalkAgentEntry, TalkEntry, TalkSummary } from "@matters/core";
import { startsNewTalk, talkTitle } from "@matters/core";
import { batch, createSignal } from "solid-js";
import { COALESCE_MS } from "./agent.ts";
import { readOpenTalk, readTalkOpen, writeOpenTalk, writeTalkOpen } from "./agentPrefs.ts";
import type { Backend } from "./client.ts";
import { OVERLAY_BELOW, paneShown } from "./paneWidth.ts";
import type { ThreadAgentStore } from "./threadAgent.ts";

/** The thread the agent looks at now, as the view that shows it knows it. */
export interface TalkThreadRef {
  readonly id: string;
  /** The other side's first name; empty when there is nobody else. */
  readonly name: string;
  readonly subject: string;
  /** The agent's reading of the thread, when it has one: the pane's title. */
  readonly headline?: string;
  /** The date of the thread's last message. */
  readonly lastMessageMs?: number;
}

export interface AgentTalkOptions {
  readonly backend: Pick<
    Backend,
    | "agentTalk"
    | "agentTalkStop"
    | "agentTalkEntries"
    | "agentTalkAll"
    | "agentTalkAllStop"
    | "agentTalkAllEntries"
    | "agentTalks"
    | "agentTalkRename"
    | "agentTalkDelete"
    | "agentTalkDeleteAll"
    | "agentUndoFeedback"
    | "onEvent"
  >;
  /** The thread the agent looks at; null while none is open. Read on every `sync`, never cached. */
  readonly thread: () => TalkThreadRef | null;
  readonly threadAgent: Pick<ThreadAgentStore, "refresh" | "reveal">;
  /** A turn finished with this answer, for what the rest of the window does about it. */
  readonly onMade?: (
    threadId: string,
    made: Extract<TalkEntry, { role: "agent" }>,
    words: string,
    headline: string,
    alsoCovers: number,
  ) => void;
  /** Runs `run` after `ms`; returns the cancel. Tests inject one they control. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
  /**
   * Whether the person wants the column shown (`initial`), and where that is kept. The window's
   * storage by default; the column is open unless they hid it (ADR 0069).
   */
  readonly open?: { readonly initial: boolean; readonly keep: (open: boolean) => void };
  /**
   * The window's width. Under `OVERLAY_BELOW` the column would cover the mail, so it shows only
   * after the person asked for it there, and neither opening nor hiding it there changes the kept
   * choice. Without it the window counts as wide.
   */
  readonly windowWidth?: () => number;
  /**
   * The talk across all mail that was open, and where it is kept (ADR 0086, rule 14): its id,
   * `null` for a new talk, `undefined` when nothing was kept (the latest talk opens).
   */
  readonly openTalk?: {
    readonly initial: number | null | undefined;
    readonly keep: (id: number | null) => void;
  };
  /** The time now; tests set it. */
  readonly now?: () => number;
}

/** The entries of a talk come in pages of this many (ADR 0086, rule 13; `MAX_TALK_SHOWN`). */
export const TALK_PAGE = 200;

const realSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/** The first word of a name. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

const STOPPED = "Stopped.";

/** A map in a signal, replaced on every change, so a reader of one key wakes for any. */
function createKeyed<V>() {
  const [map, setMap] = createSignal<ReadonlyMap<string, V>>(new Map());
  return {
    get: (key: string): V | undefined => map().get(key),
    set: (key: string, value: V) => setMap((m) => new Map(m).set(key, value)),
    delete: (key: string) =>
      setMap((m) => {
        if (!m.has(key)) return m;
        const next = new Map(m);
        next.delete(key);
        return next;
      }),
  };
}

/** What the agent looks at: the open thread, or all the mail of the accounts agreed to. */
export type TalkScope = "thread" | "all";

/** Where a scope's words, turn and problem are kept. */
const ALL_KEY = "all";
/** The trail shows its latest steps; a long one is cut at the top. */
const MAX_TRAIL_STEPS_SHOWN = 12;
/** The loop of ADR 0083 takes up to 30 calls and writes a line before each: it shows more. */
const MAX_LOOP_STEPS_SHOWN = 40;
const threadKey = (id: string) => `thread:${id}`;

/** What the search of the turn that is running has found so far; null before it has finished. */
export interface TalkStep {
  readonly query: string;
  readonly threads: number;
}

/**
 * One step the agent took on the trail (ADR 0080): a query it ran, or what it decided next. With
 * the loop of ADR 0083, also a thread it opened ("read": a fact, written by the tool server) and
 * a line the model wrote between its steps ("note": its own words, shown apart from the facts).
 * With ADR 0102, a query it counted ("count") and what it looked at ("look"), facts too.
 */
export interface TalkTrailStep {
  readonly kind: "search" | "follow" | "read" | "note" | "count" | "look";
  /** The query, the thread that was read, what was looked at, or the line the model wrote. */
  readonly text: string;
  readonly threads: number;
  /** For "count": what it counted, as the tool server wrote it ("128 messages, 12 unread"). */
  readonly detail?: string;
}

/**
 * The word in front of a step. What the tools did is a fact ("Searched", "Read"); a line the model
 * wrote between its steps is labelled as its own, so what a note says never passes for a fact.
 */
export function trailStepLabel(kind: TalkTrailStep["kind"]): string {
  switch (kind) {
    case "search":
      return "Searched";
    case "read":
      return "Read";
    case "note":
      return "Note:";
    case "follow":
      return "Next";
    case "count":
      return "Counted";
    case "look":
      return "Looked at";
  }
}

export const threadsOf = (n: number) => `${n} ${n === 1 ? "thread" : "threads"}`;

/**
 * What left this Mac for an answer across all mail, and which way it was found (ADR 0083): the
 * loop also sends whole threads while it searches, so its sentence is not the trail's.
 */
export function foundFooter(e: TalkAgentEntry): string {
  const said = loopFooter(e);
  const loop = e.loop;
  // Senders and counts, and the person's views, left this Mac too (ADR 0102); no message did.
  const also = [
    ...((loop?.counts ?? 0) > 0
      ? ["the names and addresses of senders with counts of their mail"]
      : []),
    ...(loop?.views === true ? ["the names and queries of your views"] : []),
  ].join(" and ");
  if (loop === undefined || also === "") return said;
  if (loop.searches === 0) {
    return `${said.slice(0, said.indexOf(" Sent "))} Sent your question and ${also} to ${e.runtimeName}. No message left this Mac.`;
  }
  return said.replace(
    / Nothing else left this Mac\.$/,
    ` It also sent ${also}. Nothing else left this Mac.`,
  );
}

function loopFooter(e: TalkAgentEntry): string {
  const loop = e.loop;
  if (loop === undefined) {
    return e.threads === 0
      ? `Searched the usual way. Sent your question to ${e.runtimeName}. No mail left this Mac.`
      : `Searched the usual way. Sent your question, short extracts of the threads it found, and ${threadsOf(e.threads)} in full to ${e.runtimeName}. Nothing else left this Mac.`;
  }
  const files = loop.files ?? 0;
  const counts = loop.counts ?? 0;
  const did = `Searched in a loop: ${loop.searches} ${loop.searches === 1 ? "search" : "searches"}, ${loop.read} read in full${files > 0 ? `, ${files} attached ${files === 1 ? "file" : "files"} read` : ""}${counts > 0 ? `, ${counts} ${counts === 1 ? "count" : "counts"}` : ""}.`;
  // The files it read left this Mac too: their text, or a file with no text whole (ADR 0087, 0090).
  const text = files > 0 ? "the files it read" : "";
  if (loop.searches === 0) {
    return `${did} Sent your question to ${e.runtimeName}. No mail left this Mac.`;
  }
  if (e.threads === 0) {
    const threads = loop.read === 0 ? "" : ", those threads";
    const sent =
      files > 0
        ? `your question, the search results${threads} and ${text}`
        : loop.read === 0
          ? "your question and the search results"
          : "your question, the search results and those threads";
    return `${did} Sent ${sent} to ${e.runtimeName}. Nothing else left this Mac.`;
  }
  const middle = files > 0 ? `those threads, ${text} and` : "those threads and";
  return `${did} Sent your question, the search results, ${middle} ${threadsOf(e.threads)} in full for the answer to ${e.runtimeName}. Nothing else left this Mac.`;
}

export function createAgentTalk(options: AgentTalkOptions) {
  const { backend, thread, threadAgent } = options;
  const schedule = options.schedule ?? realSchedule;
  const keep = options.open?.keep ?? writeTalkOpen;

  const windowWidth = options.windowWidth ?? (() => Number.POSITIVE_INFINITY);
  // What the person chose for wide windows, and whether they asked for the column in a narrow one.
  const [preferred, setPreferred] = createSignal(options.open?.initial ?? readTalkOpen());
  const [askedHere, setAskedHere] = createSignal(false);
  const overlay = (): boolean => windowWidth() < OVERLAY_BELOW;
  const paneOpen = (): boolean => paneShown(preferred(), askedHere(), windowWidth());
  const [loaded, setLoaded] = createSignal<{
    readonly threadId: string;
    readonly entries: readonly TalkEntry[];
  } | null>(null);
  // The talk across all mail in view: which one, its entries, and whether older ones are left.
  const [loadedAll, setLoadedAllState] = createSignal<{
    readonly talkId: number | null;
    readonly entries: readonly TalkEntry[];
    readonly older: boolean;
  }>({ talkId: null, entries: [], older: false });
  const now = options.now ?? Date.now;
  const keepTalk = options.openTalk?.keep ?? writeOpenTalk;
  const [talks, setTalks] = createSignal<readonly TalkSummary[]>([]);
  // `undefined` until the list has been read once: then the latest talk opens.
  const [openTalk, setOpenTalkState] = createSignal<number | null | undefined>(
    options.openTalk === undefined ? readOpenTalk() : options.openTalk.initial,
  );
  // The person chose the open talk from the list: a question after a pause continues it (rule 4).
  const [chosenTalk, setChosenTalk] = createSignal(false);
  // The talk the turn across all mail runs in: `null` a new one, `undefined` while none runs.
  const [runningIn, setRunningIn] = createSignal<number | null | undefined>(undefined);
  const setOpenTalk = (id: number | null, chosen: boolean) => {
    batch(() => {
      setOpenTalkState(id);
      setChosenTalk(chosen);
    });
    keepTalk(id);
  };
  const setLoadedAll = (talkId: number | null, entries: readonly TalkEntry[], older: boolean) =>
    setLoadedAllState({ talkId, entries, older });
  // What the person chose. It is only the scope when it can be: with no thread open, all mail is.
  const [chosen, setChosen] = createSignal<TalkScope>("thread");
  const [step, setStep] = createSignal<TalkStep | null>(null);
  const [steps, setSteps] = createSignal<readonly TalkTrailStep[]>([]);
  const [looping, setLooping] = createSignal(false);
  const words = createKeyed<string>();
  const turns = createKeyed<string>(); // scope key -> the words of the turn that is running
  const problems = createKeyed<string>();
  const [undone, setUndone] = createSignal<ReadonlySet<number>>(new Set());
  let seq = 0;
  let seqAll = 0;
  let cancelTimer: (() => void) | null = null;

  /** The scope in view. */
  const scope = (): TalkScope => (chosen() === "all" || thread() === null ? "all" : "thread");
  /** Where the words, turn and problem of the scope in view are kept. */
  const keyOf = (): string => {
    const t = thread();
    return scope() === "all" || t === null ? ALL_KEY : threadKey(t.id);
  };

  /**
   * Shows or hides the column. In a narrow window this is for now only: the kept choice is for
   * wide windows and is not changed from there.
   */
  function setOpen(open: boolean): void {
    if (overlay()) {
      setAskedHere(open);
      return;
    }
    setPreferred(open);
    keep(open);
  }

  /** The talk in view; never another scope's, not even for a frame. */
  function entries(): readonly TalkEntry[] {
    if (scope() === "all") {
      const l = loadedAll();
      return l.talkId === (openTalk() ?? null) ? l.entries : [];
    }
    const t = thread();
    const l = loaded();
    return t !== null && l !== null && l.threadId === t.id ? l.entries : [];
  }

  async function read(threadId: string): Promise<readonly TalkEntry[] | null> {
    try {
      return await backend.agentTalkEntries(threadId);
    } catch {
      // What is on screen stays: a failed local read must not take the talk away.
      return null;
    }
  }

  async function readAll(
    talkId: number | null,
    beforeId?: number,
  ): Promise<readonly TalkEntry[] | null> {
    // A new talk has nothing yet: there is nothing to read.
    if (talkId === null) return [];
    try {
      return await backend.agentTalkAllEntries(talkId, beforeId);
    } catch {
      return null;
    }
  }

  async function readTalks(): Promise<readonly TalkSummary[] | null> {
    try {
      return await backend.agentTalks();
    } catch {
      return null;
    }
  }

  /** Reads the open thread's talk again. An answer that is not for the latest question is dropped. */
  async function load(): Promise<void> {
    const t = thread();
    const mine = ++seq;
    if (t === null) return;
    const fresh = await read(t.id);
    if (mine !== seq || fresh === null) return;
    setLoaded({ threadId: t.id, entries: fresh });
  }

  /**
   * Reads the list of talks and the open talk again. The first time, the kept talk opens, or the
   * latest when none was kept; a kept talk that is gone opens a new one (rule 14).
   */
  async function loadAllMail(): Promise<void> {
    const mine = ++seqAll;
    const list = await readTalks();
    if (mine !== seqAll || list === null) return;
    let open = openTalk();
    const running = runningIn();
    if (open === undefined) open = list[0]?.id ?? null;
    else if (open !== null && open !== running && !list.some((t) => t.id === open)) open = null;
    const fresh = await readAll(open);
    if (mine !== seqAll || fresh === null) return;
    batch(() => {
      setTalks(list);
      if (open !== openTalk()) setOpenTalk(open, false);
      // A page as long as a full one may have older entries before it.
      setLoadedAll(open, fresh, fresh.length >= TALK_PAGE);
    });
  }

  /** Scrolling to the top of a talk loads the page before it (rule 13). */
  async function loadOlder(): Promise<boolean> {
    const l = loadedAll();
    const first = l.entries[0];
    if (!l.older || l.talkId === null || first === undefined) return false;
    const mine = seqAll;
    const page = await readAll(l.talkId, first.id);
    if (page === null || mine !== seqAll || loadedAll().talkId !== l.talkId) return false;
    setLoadedAll(l.talkId, [...page, ...loadedAll().entries], page.length >= TALK_PAGE);
    return page.length > 0;
  }

  let seen: string | null = null;
  let seenScope: TalkScope | null = null;

  /**
   * The open thread or the scope may have changed: ask for the talk in view. Opening a thread
   * shows its talk (rule 2), so a different thread takes the scope back to the thread. Opening one
   * never waits on a read.
   */
  function sync(): void {
    const t = thread();
    if (t === null) {
      seen = null;
      seq++;
    } else if (seen !== t.id) {
      seen = t.id;
      setChosen("thread");
      void load();
    }
    const now = scope();
    if (now === "all" && seenScope !== "all") void loadAllMail();
    seenScope = now;
  }

  // A push carries no data: ask again once things have been quiet for a moment.
  const unsubscribe = backend.onEvent((event) => {
    if (event.type === "agentTalkStep") {
      // Only the turn that is running shows its steps.
      if (turns.get(ALL_KEY) === undefined) return;
      if (event.kind === undefined) setStep({ query: event.query, threads: event.threads });
      else {
        const counted = event.kind === "count";
        const next: TalkTrailStep = {
          kind: event.kind,
          text: event.kind === "search" || counted ? event.query : (event.note ?? ""),
          threads: event.threads,
          ...(counted && event.note !== undefined ? { detail: event.note } : {}),
        };
        // Only the loop writes reads, notes, counts and looks, and it takes more steps than the trail.
        const loop = event.kind !== "search" && event.kind !== "follow";
        setLooping((was) => was || loop);
        setSteps((list) =>
          [...list, next].slice(
            -(looping() || loop ? MAX_LOOP_STEPS_SHOWN : MAX_TRAIL_STEPS_SHOWN),
          ),
        );
      }
      return;
    }
    if (event.type !== "agentChanged" || cancelTimer !== null) return;
    cancelTimer = schedule(() => {
      cancelTimer = null;
      if (scope() === "all") void loadAllMail();
      else if (thread() !== null) void load();
    }, COALESCE_MS);
  });

  const busyOf = (threadId: string) => turns.get(threadKey(threadId)) !== undefined;
  const busyAll = () => turns.get(ALL_KEY) !== undefined;

  /**
   * The person's words go to the agent. The field is emptied and the pane opens at once; on a
   * failure the words come back, unless the person has typed new ones meanwhile.
   */
  async function send(): Promise<void> {
    if (scope() === "all") return sendAll();
    const t = thread();
    if (t === null || busyOf(t.id)) return;
    const key = threadKey(t.id);
    const text = (words.get(key) ?? "").trim();
    if (text === "") return;
    const id = t.id;
    batch(() => {
      words.set(key, "");
      problems.delete(key);
      turns.set(key, text);
    });
    setOpen(true);
    let result: Awaited<ReturnType<typeof backend.agentTalk>>;
    try {
      result = await backend.agentTalk(id, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : "That did not work.";
      batch(() => {
        if ((words.get(key) ?? "") === "") words.set(key, text);
        if (message !== STOPPED) problems.set(key, message);
        turns.delete(key);
      });
      return;
    }
    // The talk and the end of the turn show in one frame, so the words are not drawn twice.
    const fresh = thread()?.id === id ? await read(id) : null;
    batch(() => {
      if (fresh !== null && thread()?.id === id) {
        seq++;
        setLoaded({ threadId: id, entries: fresh });
      }
      turns.delete(key);
    });
    const made = result.entries.find((e) => e.role === "agent");
    if (made?.role === "agent")
      options.onMade?.(id, made, text, t.headline ?? t.subject, result.alsoCovers ?? 0);
    // A draft or a question the agent made shows under the letters, even where an earlier one was
    // set aside; an answer or a closing changes nothing there.
    if (
      result.entries.some(
        (e) => e.role === "agent" && (e.kind === "draft" || e.kind === "question"),
      )
    )
      threadAgent.reveal(id);
    void threadAgent.refresh();
  }

  /** The same for the talk across all mail: no thread is touched, and nothing is made but text. */
  async function sendAll(): Promise<void> {
    if (busyAll()) return;
    const text = (words.get(ALL_KEY) ?? "").trim();
    if (text === "") return;
    // Which talk it is asked in (rule 4): the open one, unless it has gone quiet for longer than
    // the pause and the person did not choose it from the list; then a new one.
    const open = openTalk() ?? null;
    const known = open === null ? null : (talks().find((t) => t.id === open) ?? null);
    const fresh = open === null || (known !== null && startsNewTalk(known, now(), chosenTalk()));
    const target = fresh ? null : open;
    batch(() => {
      words.set(ALL_KEY, "");
      problems.delete(ALL_KEY);
      turns.set(ALL_KEY, text);
      setRunningIn(target);
      setStep(null);
      setSteps([]);
      setLooping(false);
      if (target === null && open !== null) {
        // The question shows in the new talk at once; the old one stays in the list.
        seqAll++;
        setOpenTalk(null, false);
        setLoadedAll(null, [], false);
      }
    });
    setOpen(true);
    const endTurn = () => {
      turns.delete(ALL_KEY);
      setRunningIn(undefined);
      setStep(null);
      setSteps([]);
      setLooping(false);
    };
    let talkId: number | undefined;
    try {
      talkId = (await backend.agentTalkAll(text, target)).talkId;
    } catch (error) {
      const message = error instanceof Error ? error.message : "That did not work.";
      batch(() => {
        if ((words.get(ALL_KEY) ?? "") === "") words.set(ALL_KEY, text);
        if (message !== STOPPED) problems.set(ALL_KEY, message);
        endTurn();
      });
      return;
    }
    // The person still looks at the talk it was asked in: that is now the talk it landed in.
    const here = (openTalk() ?? null) === target;
    const landed = talkId ?? target;
    const [list, entries] = await Promise.all([
      readTalks(),
      here ? readAll(landed) : Promise.resolve(null),
    ]);
    batch(() => {
      seqAll++;
      if (list !== null) setTalks(list);
      if (here && entries !== null) {
        setOpenTalk(landed, chosenTalk());
        setLoadedAll(landed, entries, entries.length >= TALK_PAGE);
      }
      endTurn();
    });
  }

  /** `New talk` and `⇧⌘J` (rule 3): nothing while the open talk is still empty. */
  function newTalk(): void {
    batch(() => {
      if (scope() !== "all") setChosen("all");
      const open = openTalk() ?? null;
      if (open === null) return;
      const known = talks().find((t) => t.id === open);
      if (known !== undefined && known.entries === 0) return;
      seqAll++;
      setOpenTalk(null, false);
      setLoadedAll(null, [], false);
      problems.delete(ALL_KEY);
    });
  }

  /** A talk from the list opens; asking in it continues it, however old it is (rule 4). */
  function openFromList(id: number): void {
    batch(() => {
      if (scope() !== "all") setChosen("all");
      setOpenTalk(id, true);
      problems.delete(ALL_KEY);
    });
    void loadAllMail();
  }

  async function renameTalk(id: number, title: string): Promise<void> {
    try {
      await backend.agentTalkRename(id, title);
    } catch {
      problems.set(ALL_KEY, "The talk could not be renamed.");
      return;
    }
    await loadAllMail();
  }

  /** Rule 10. When the open talk goes, a new talk opens. */
  async function deleteTalk(id: number): Promise<void> {
    try {
      await backend.agentTalkDelete(id);
    } catch {
      problems.set(ALL_KEY, "The talk could not be deleted.");
      return;
    }
    if ((openTalk() ?? null) === id) {
      batch(() => {
        seqAll++;
        setOpenTalk(null, false);
        setLoadedAll(null, [], false);
      });
    }
    await loadAllMail();
  }

  /** Rule 11: every talk across all mail; one empty talk is left open. */
  async function deleteAllTalks(): Promise<void> {
    try {
      await backend.agentTalkDeleteAll();
    } catch {
      problems.set(ALL_KEY, "The talks could not be deleted.");
      return;
    }
    batch(() => {
      seqAll++;
      setOpenTalk(null, false);
      setLoadedAll(null, [], false);
      setTalks([]);
    });
    await loadAllMail();
  }

  /** `Stop`: the turn in view ends and its words come back. */
  function stop(): void {
    if (scope() === "all") {
      if (busyAll()) void backend.agentTalkAllStop().catch(() => {});
      return;
    }
    const t = thread();
    if (t === null || !busyOf(t.id)) return;
    void backend.agentTalkStop(t.id).catch(() => {});
  }

  /** `Undo` on a closing: the same path as in Matters, the feedback is forgotten. */
  async function undoClosed(): Promise<void> {
    const t = thread();
    const last = scope() === "thread" ? entries().at(-1) : undefined;
    if (t === null || last?.role !== "agent" || last.kind !== "closed") return;
    try {
      await backend.agentUndoFeedback(t.id, "closed");
    } catch {
      problems.set(threadKey(t.id), "That could not be undone.");
      return;
    }
    setUndone((s) => new Set(s).add(last.id));
  }

  return {
    sync,
    entries,
    /** What the agent looks at now: the open thread, or all mail (also while no thread is open). */
    scope,
    /** Chooses the scope. A thread cannot be chosen while none is open. */
    setScope(next: TalkScope): void {
      if (next === "thread" && thread() === null) return;
      setChosen(next);
      sync();
    },
    /** What the person is typing in the scope in view. */
    words: (): string => words.get(keyOf()) ?? "",
    setWords(text: string): void {
      words.set(keyOf(), text);
    },
    /** The words of the turn that is running for this thread, or null. */
    pending: (threadId: string): string | null => turns.get(threadKey(threadId)) ?? null,
    busy: busyOf,
    /** The words of the turn that is running in the talk in view, or null. */
    pendingNow: (): string | null => {
      if (scope() === "all" && runningIn() !== (openTalk() ?? null)) return null;
      return turns.get(keyOf()) ?? null;
    },
    /** A turn across all mail runs in another talk than the one in view. */
    busyElsewhere: (): boolean =>
      scope() === "all" && busyAll() && runningIn() !== (openTalk() ?? null),
    busyNow: (): boolean => turns.get(keyOf()) !== undefined,
    /** What the search of the turn across all mail has done, once it is done; else null. */
    step: (): TalkStep | null =>
      scope() === "all" && runningIn() === (openTalk() ?? null) ? step() : null,
    /** The queries run and the decisions taken on the trail of the turn that is running. */
    steps: (): readonly TalkTrailStep[] =>
      scope() === "all" && runningIn() === (openTalk() ?? null) ? steps() : [],
    /** The talks across all mail that have entries, the latest first (rule 5). */
    talks,
    /** The talk across all mail in view: its id, or null for a new talk. */
    openTalkId: (): number | null => openTalk() ?? null,
    /** What the header calls the talk in view. */
    openTalkTitle(): string {
      const id = openTalk() ?? null;
      const known = id === null ? undefined : talks().find((t) => t.id === id);
      if (known !== undefined) return talkTitle(known);
      const pending = runningIn() === id ? turns.get(ALL_KEY) : undefined;
      return pending === undefined ? "New talk" : talkTitle({ firstWords: pending });
    },
    /** The talk the turn across all mail runs in: an id, null for a new talk, undefined for none. */
    runningTalk: runningIn,
    /** The open talk has entries before the first one shown. */
    hasOlder: (): boolean => scope() === "all" && loadedAll().older,
    loadOlder,
    newTalk,
    openFromList,
    renameTalk,
    deleteTalk,
    deleteAllTalks,
    /** The problem of the last turn in the scope in view, a sentence for the person; never `Stopped.`. */
    problem: (): string => problems.get(keyOf()) ?? "",
    send,
    stop,
    paneOpen,
    /** The window is too narrow for the column beside the mail: it lies over the reader. */
    overlay,
    /** The window grew: the column follows the kept choice again, not an earlier request. */
    forgetAsk: () => setAskedHere(false),
    setOpen,
    toggle: () => setOpen(!paneOpen()),
    /** The thread has a message that is newer than the newest entry of the talk. */
    newMessage(): boolean {
      if (scope() !== "thread") return false;
      const last = entries().at(-1);
      const at = thread()?.lastMessageMs;
      return last !== undefined && at !== undefined && at > last.atMs;
    },
    /** The id of the newest draft or question of the talk: the only one that can still be current. */
    latestWorkId(): number | null {
      const list = scope() === "thread" ? entries() : [];
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (e?.role === "agent" && (e.kind === "draft" || e.kind === "question")) return e.id;
      }
      return null;
    },
    /** `Undo` is offered on the newest entry only, and only on a closing not yet taken back. */
    canUndo(entry: TalkEntry): boolean {
      return (
        entry.role === "agent" &&
        entry.kind === "closed" &&
        scope() === "thread" &&
        entries().at(-1)?.id === entry.id &&
        !undone().has(entry.id)
      );
    },
    undoClosed,
    dispose(): void {
      cancelTimer?.();
      cancelTimer = null;
      unsubscribe();
    },
  };
}

export type AgentTalkStore = ReturnType<typeof createAgentTalk>;

/** How near the end a talk counts as read to the bottom: a line's height of slack. */
export const BOTTOM_SLACK_PX = 24;

/** Whether the talk is scrolled to its end, so a growing answer should stay in view. */
export function isAtBottom(box: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM_SLACK_PX;
}
