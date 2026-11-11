// The window's side of agents (ADR 0051, 0052): the things that matter, what was prepared for
// them, and the status of the plans. Everything here is a local read or a request the person made;
// nothing waits for a model except `prepare`, which is the person's own ask and blocks nothing
// else. A push (`agentChanged`) carries no data but whether the status itself changed (ADR 0115),
// so it is coalesced and only what is shown is asked for again.
import type { ThreadMessage } from "@matters/contracts";
import type {
  AddInstructionInput,
  AgentInstruction,
  AgentRule,
  AgentStatus,
  JournalEntry,
  PreparedWork,
  PrepareResult,
  RememberResult,
  RuleOffer,
  TalkEntry,
  Thing,
  Thread,
} from "@matters/core";
import { PROGRAM_LIKE } from "@matters/core";
import { batch, createSignal } from "solid-js";
import { readEnabledHint, writeEnabledHint } from "./agentPrefs.ts";
import type { Backend } from "./client.ts";
import { BackendError } from "./client.ts";
import {
  alsoOlderMails,
  type HeldRow,
  holdList,
  type JournalLine,
  journalLines,
  type NotLikeThis,
  nextWindow,
  rememberedText,
  ruleText,
  THINGS_PAGE,
} from "./mattersView.ts";
import { createStatusOrder } from "./statusOrder.ts";

/** What a turn of the talk made. */
type TalkAgentKind = Extract<TalkEntry, { role: "agent" }>["kind"];

/** Quiet time after a push before the list is asked for again: a reading pushes once per step. */
export const COALESCE_MS = 300;
/** The status is asked for again when it is shown, or at most this often while it is not. */
export const STATUS_AGE_MS = 5000;
/** How long the line for "Not important", "Later" and "Closed" offers Undo. */
export const FEEDBACK_UNDO_MS = 8000;

/** How many lines of the journal the page asks for and shows. */
export const JOURNAL_SHOWN = 20;

export type FeedbackKind = "notImportant" | "later" | "closed";

/** What a closing meant (ADR 0066, rule 7); a closing with none counts as done. */
export type ClosingOutcome = "done" | "taken" | "declined";

/** The tray's words for a closing that says what it meant. */
const OUTCOME_TEXT: Record<ClosingOutcome, string> = {
  done: "Marked done",
  taken: "Marked as taken",
  declined: "Declined for this year",
};

const FEEDBACK_TEXT: Record<FeedbackKind, string> = {
  notImportant: "Marked not important",
  later: "Set aside until tomorrow morning",
  closed: "Closed, no reply needed",
};

/** `remembered` is the line after the agent kept something from the person's words (ADR 0054). */
export type LineKind = FeedbackKind | "remembered";

/** The line the tray shows after the person set a thing aside. */
export interface FeedbackLine {
  readonly id: number;
  readonly kind: LineKind;
  readonly threadId: string;
  readonly headline: string;
  /** What the line says, e.g. `Not important · Waiting for the signed contract`. */
  readonly text: string;
  /** After a closing: one click for a rule for the sender (ADR 0054, rule 9). */
  readonly offer?: RuleOffer;
  /** For `remembered`: exactly what was kept, so Undo removes that and nothing else. */
  readonly added?: RememberResult["items"];
  /** Set aside as a group: every thread this line's Undo brings back (ADR 0056, rule 5). */
  readonly threadIds?: readonly string[];
}

const thingsCount = (n: number) => `${n} ${n === 1 ? "thing" : "things"}`;

/** The open thread of the selected thing: who is in it, how many messages, and the quoted one. */
export interface Detail {
  readonly threadId: string;
  readonly thread: Thread;
  readonly messages: readonly ThreadMessage[];
}

export interface AgentOptions {
  /** The composer on a draft that already existed or that the person took over. */
  readonly openDraft: (draftId: string) => Promise<void>;
  readonly now?: () => number;
  /** Runs `run` after `ms`; returns the cancel. Tests inject one they control. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
}

const realSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/** Two reads that came out alike: a page of things, or one status. */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof BackendError && error.message !== "" ? error.message : fallback;
}

/** What `Send` did, for the view and for the tests: the path is only ever these two. */
export type SendOutcome = "sent" | "openedExisting" | "failed";

/**
 * What the agent did, as the page holds it (ADR 0054, rule 6): the newest lines of the local
 * journal, and Undo from them. The settings window uses it; it never waits for a model.
 */
export function createJournal(backend: Backend, now: () => number = Date.now) {
  const [entries, setEntries] = createSignal<readonly JournalEntry[]>([]);
  const [loaded, setLoaded] = createSignal(false);

  async function load(): Promise<void> {
    try {
      const next = await backend.agentJournal(JOURNAL_SHOWN);
      batch(() => {
        if (!same(entries(), next)) setEntries(next);
        setLoaded(true);
      });
    } catch {
      // The old lines stay: a failed read must not empty the list on screen.
    }
  }

  /** Takes the entry's feedback back; false when the backend refused. The journal is read again. */
  async function undo(entry: JournalEntry): Promise<boolean> {
    try {
      if (entry.action === "ruleAdded") await backend.agentRemoveRule(entry.ruleId);
      else if (entry.action === "instructionAdded") {
        await backend.agentRemoveInstruction(entry.instructionId);
      } else await backend.agentUndoFeedback(entry.threadId, entry.action);
    } catch {
      return false;
    }
    await load();
    return true;
  }

  return {
    entries,
    loaded,
    /** The lines to draw, with Undo only where it can work. */
    lines: (): JournalLine[] => journalLines(entries(), now()),
    load,
    undo,
  };
}

/**
 * The rules the person keeps (ADR 0054, rule 7), as Settings > Agents holds them. A rule is added
 * and removed by a click or by typing; the backend says what is wrong with a value, and that
 * sentence is shown. Nothing here waits for a model.
 */
export function createRules(backend: Backend) {
  const [rules, setRules] = createSignal<readonly AgentRule[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [problem, setProblem] = createSignal("");

  async function load(): Promise<void> {
    try {
      const next = await backend.agentRules();
      batch(() => {
        if (!same(rules(), next)) setRules(next);
        setLoaded(true);
      });
    } catch {
      // The old rules stay: a failed read must not empty the list on screen.
    }
  }

  /** Runs a change, then reads again; a refusal is shown as the backend worded it. */
  async function change(work: () => Promise<unknown>, fallback: string): Promise<boolean> {
    setProblem("");
    try {
      await work();
    } catch (error) {
      setProblem(messageOf(error, fallback));
      return false;
    }
    await load();
    return true;
  }

  /** A value with `@` is an address, otherwise a domain. */
  const add = (value: string): Promise<boolean> =>
    change(
      () =>
        backend.agentAddRule({
          scope: value.includes("@") && !value.trim().startsWith("@") ? "sender" : "domain",
          subject: value,
        }),
      "That rule could not be added.",
    );

  return {
    rules,
    loaded,
    problem,
    load,
    add,
    remove: (rule: AgentRule): Promise<boolean> =>
      change(() => backend.agentRemoveRule(rule.id), "That rule could not be removed."),
    /** The rule for addresses that look like programs: added when absent, removed when there. */
    toggleProgramLike: (): Promise<boolean> => {
      const there = rules().find((r) => r.scope === "type");
      return change(
        () =>
          there === undefined
            ? backend.agentAddRule({ scope: "type", subject: PROGRAM_LIKE })
            : backend.agentRemoveRule(there.id),
        "That rule could not be changed.",
      );
    },
    programLike: (): boolean => rules().some((r) => r.scope === "type"),
  };
}

/**
 * The instructions the person keeps for the model (ADR 0054, rule 7), as Settings > Agents holds
 * them. The backend says what is wrong with a text, and that sentence is shown. Nothing here waits
 * for a model.
 */
export function createInstructions(backend: Backend) {
  const [instructions, setInstructions] = createSignal<readonly AgentInstruction[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [problem, setProblem] = createSignal("");

  async function load(): Promise<void> {
    try {
      const next = await backend.agentInstructions();
      batch(() => {
        if (!same(instructions(), next)) setInstructions(next);
        setLoaded(true);
      });
    } catch {
      // The old list stays: a failed read must not empty it on screen.
    }
  }

  async function change(work: () => Promise<unknown>, fallback: string): Promise<boolean> {
    setProblem("");
    try {
      await work();
    } catch (error) {
      setProblem(messageOf(error, fallback));
      return false;
    }
    await load();
    return true;
  }

  return {
    instructions,
    loaded,
    problem,
    load,
    add: (input: AddInstructionInput): Promise<boolean> =>
      change(() => backend.agentAddInstruction(input), "That instruction could not be added."),
    remove: (instruction: AgentInstruction): Promise<boolean> =>
      change(
        () => backend.agentRemoveInstruction(instruction.id),
        "That instruction could not be removed.",
      ),
  };
}

export function createAgentStore(backend: Backend, options: AgentOptions) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? realSchedule;

  const [status, setStatus] = createSignal<AgentStatus | null>(null);
  const order = createStatusOrder();
  const [things, setThings] = createSignal<readonly Thing[]>([]);
  // How many there are in all; `things` holds the best `wanted` of them.
  const [total, setTotal] = createSignal(0);
  const [loaded, setLoaded] = createSignal(false);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  // The person opened something (a click or a key), as opposed to the first thing opening by
  // itself (ADR 0053, rule 6). A choice is never replaced by what arrives later.
  const [chose, setChose] = createSignal(false);
  const [detail, setDetail] = createSignal<Detail | null>(null);
  // Things the person just dealt with in this window: a short bridge until the backend has said
  // so itself (ADR 0112). Each holds the read of the list after which the backend's word is final,
  // or null while what the person did is not recorded yet. That read decides: what it still
  // lists shows again, whatever this window did.
  const [hidden, setHidden] = createSignal<ReadonlyMap<string, number | null>>(new Map());
  // Work made on request, until the next list carries it.
  const [made, setMade] = createSignal<ReadonlyMap<string, PreparedWork>>(new Map());
  // The words the person gave, per thread, so the sheet can underline them.
  const [given, setGiven] = createSignal<ReadonlyMap<string, readonly string[]>>(new Map());
  // Threads whose draft was asked for by the person (written by the writing model).
  const [asked, setAsked] = createSignal<ReadonlySet<string>>(new Set());
  // Drafts the person took over with `Edit myself`: the frame turns solid and is theirs.
  const [took, setTook] = createSignal<ReadonlyMap<string, string>>(new Map());
  // The direction picked on a question, per thread: a click or a digit key.
  const [chosen, setChosen] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
  const [problems, setProblems] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [line, setLine] = createSignal<FeedbackLine | null>(null);
  // How many things are for now, and whether the rest is open (ADR 0058, rule 2). Undefined: no sections.
  const [nowCount, setNowCount] = createSignal<number | undefined>(undefined);
  const [restOpen, setRestOpen] = createSignal(false);
  // What the bar searches Matters for; empty for every thing (ADR 0056, rule 1).
  const [query, setQueryText] = createSignal("");
  // The bar's text has not been answered yet: what shows is still the list of the text before.
  const [searching, setSearching] = createSignal(false);
  // Matters is the view on screen: the status is kept fresh only then.
  let shown = false;
  // The order the person is working through, from their first action until they leave (ADR 0062).
  let held: readonly HeldRow[] | null = null;
  // They left with a list on hold: it is put in order when they come back.
  let settle = false;
  let wanted = THINGS_PAGE;
  let thingsSeq = 0;
  // A search holds up every read behind it, so one runs at a time. What was typed meanwhile is asked
  // when it answers, and the letters in between are never asked at all.
  let searchAsked = false;
  // The search the rows now in the list came from; empty for every thing.
  let listedFor = "";
  let loadingMore = false;
  let statusAt = 0;
  // A push said the status changed, and no read has started since (ADR 0115).
  let statusChanged = false;
  let cancelStatusLater: (() => void) | null = null;
  let cancelTimer: (() => void) | null = null;
  let running = false;
  let again = false;
  let detailSeq = 0;
  let lineSeq = 0;
  let cancelLine: (() => void) | null = null;

  const hint = readEnabledHint();
  const enabled = () => {
    const s = status();
    return s === null ? hint : s.settings.enabled === true;
  };
  // Every row asks these each frame, over a list of any length: worked out once per change. Plain
  // functions rather than memos, because this store lives outside any root.
  let derivedFrom: readonly [readonly Thing[], ReadonlyMap<string, unknown>, boolean] | null = null;
  let derived: readonly Thing[] = [];
  let positions: ReadonlyMap<string, number> = new Map();
  const sections = () => {
    const now = nowCount();
    return now !== undefined && now > 0 && now < total() && query() === "";
  };
  const visible = () => {
    const list = things();
    const gone = hidden();
    const cut = sections() && !restOpen();
    if (derivedFrom?.[0] !== list || derivedFrom[1] !== gone || derivedFrom[2] !== cut) {
      derivedFrom = [list, gone, cut];
      const left = list.filter((t) => !gone.has(t.threadId));
      // With everything for now dealt with, what is left is what there is.
      const forNow = cut ? left.filter((t) => t.now === true) : left;
      derived = forNow.length > 0 ? forNow : left;
      positions = new Map(derived.map((t, i) => [t.threadId, i]));
    }
    return derived;
  };
  const selectedIndex = () => {
    const list = visible();
    const id = selectedId();
    const at = id === null ? undefined : positions.get(id);
    return at ?? (list.length > 0 ? 0 : -1);
  };
  const selected = (): Thing | undefined => visible()[selectedIndex()];

  function put(name: "busy" | "problems", threadId: string, on: string | boolean) {
    if (name === "busy") {
      setBusy((s) => {
        const next = new Set(s);
        if (on) next.add(threadId);
        else next.delete(threadId);
        return next;
      });
    } else {
      setProblems((m) => {
        const next = new Map(m);
        if (on === false || on === "") next.delete(threadId);
        else next.set(threadId, String(on));
        return next;
      });
    }
  }

  /**
   * Rows of the rest can be on screen with the rest closed: while nothing is for now, or once
   * everything for now is dealt with. What the person is looking at does not close under them when
   * a thing for now comes, so the rest counts as open from here. Nobody is looking from another view.
   */
  function holdRest() {
    if (!shown || listedFor !== "" || restOpen()) return;
    if (visible().some((t) => t.now !== true)) setRestOpen(true);
  }

  // --- Asking for what is shown ---

  /**
   * A push the status was not read for, because it was fresh: it is read once it is old enough,
   * so no change waits for a push that may never come (ADR 0115). One at a time, so a reading's
   * pushes cost one status read per `STATUS_AGE_MS`, as before.
   */
  function statusLater() {
    if (cancelStatusLater !== null) return;
    cancelStatusLater = schedule(
      () => {
        cancelStatusLater = null;
        void loadStatus();
      },
      Math.max(0, statusAt + STATUS_AGE_MS - now()),
    );
  }

  async function loadStatus() {
    // A read that starts now answers every push before it.
    cancelStatusLater?.();
    cancelStatusLater = null;
    try {
      await order.settle(backend.agentStatus(), (next) => {
        batch(() => {
          // The same status again changes nothing on the page: signals that nobody needs to hear
          // are left alone, which keeps a reading's many pushes from redrawing the screen.
          if (!same(status(), next)) setStatus(next);
          statusAt = now();
        });
        writeEnabledHint(next.settings.enabled);
      });
    } catch {
      // The old status stays: a failed read must not turn AI off on screen.
    }
  }

  async function loadThings() {
    // Only the newest read counts: an older one may hold fewer than the list has grown to.
    const seq = ++thingsSeq;
    const text = query();
    if (text !== "") {
      if (searchAsked) return;
      searchAsked = true;
    }
    try {
      const page =
        text === "" ? await backend.agentThings(wanted) : await backend.agentThings(wanted, text);
      if (seq !== thingsSeq) return;
      const ranked = page.things;
      const hold = text === "" && held !== null ? holdList(ranked, held) : null;
      if (hold !== null) held = hold.held;
      const next = hold?.things ?? ranked;
      // A row held on its side of the heading moves the count along with it.
      const nowAfter =
        page.now === undefined
          ? undefined
          : page.now +
            next.filter((t) => t.now === true).length -
            ranked.filter((t) => t.now === true).length;
      // One change, selection included: nobody sees the list new and the selection still old.
      batch(() => {
        const sameList = listedFor === text;
        const at = sameList && chose() ? selectedIndex() : undefined;
        if (sameList) holdRest();
        listedFor = text;
        if (!same(things(), next)) setThings(next);
        setTotal(page.total);
        setNowCount(nowAfter);
        // What the backend no longer lists needs no hiding; what a read asked after the action was
        // recorded still lists is the backend's word, and shows (ADR 0112).
        const listed = new Set(next.map((t) => t.threadId));
        setHidden((h) => {
          const kept = [...h].filter(
            ([id, after]) => listed.has(id) && (after === null || seq <= after),
          );
          return kept.length === h.size ? h : new Map(kept);
        });
        // Work the list now carries needs no copy of its own.
        setMade((m) => {
          const rest = [...m].filter(([id]) => !next.some((t) => t.threadId === id && t.prepared));
          return rest.length === m.size ? m : new Map(rest);
        });
        setLoaded(true);
        setSearching(false);
        ensureSelection(at);
      });
    } catch {
      if (seq !== thingsSeq) return;
      batch(() => {
        setLoaded(true);
        setSearching(false);
        ensureSelection();
      });
    } finally {
      if (text !== "") {
        searchAsked = false;
        // Something newer was left waiting for this one. Without text it has gone ahead by itself.
        if (seq !== thingsSeq && query() !== "") void loadThings();
      }
    }
  }

  /** The list nears the end of what is loaded: the next page, if there is one. */
  async function loadMore() {
    if (loadingMore || things().length >= total()) return;
    // The rest is closed and everything for now is here: nobody is looking for more.
    if (sections() && !restOpen() && things().length >= (nowCount() ?? 0)) return;
    loadingMore = true;
    wanted += THINGS_PAGE;
    try {
      await loadThings();
    } finally {
      loadingMore = false;
    }
  }

  /**
   * Keeps the selection on the same thread while the list changes under it: rows arrive ranked,
   * so a better one may come above the open one, and the open one stays open. The first thing
   * opens by itself while the person has opened nothing. If the open thing is gone (dealt with,
   * or pushed out of what is loaded), the choice is no longer a choice, and what opens is the row
   * now at `from`, where the person was, or the top one without it.
   */
  function ensureSelection(from = 0) {
    const list = visible();
    const id = selectedId();
    if (list.length === 0) {
      if (id !== null) setSelectedId(null);
      setChose(false);
      setDetail(null);
      return;
    }
    const kept = list.find((t) => t.threadId === id);
    const current = kept ?? list[Math.min(from, list.length - 1)];
    if (current === undefined) return;
    if (kept === undefined) {
      setChose(false);
      setSelectedId(current.threadId);
    }
    void loadDetail(current);
  }

  async function loadDetail(thing: Thing) {
    const have = detail();
    // Shown already, unless the quoted message is one this copy of the thread does not hold yet.
    if (
      have?.threadId === thing.threadId &&
      have.messages.some((m) => m.key === thing.quote.messageKey)
    ) {
      return;
    }
    const seq = ++detailSeq;
    try {
      const r = await backend.openThread(thing.threadId);
      if (seq !== detailSeq) return;
      setDetail({ threadId: thing.threadId, thread: r.thread, messages: r.messages });
    } catch {
      if (seq === detailSeq) setDetail(null);
    }
  }

  /** The mail of another thread of a series; null when it could not be read, and the reader stays. */
  async function threadMessages(threadId: string): Promise<readonly ThreadMessage[] | null> {
    try {
      return (await backend.openThread(threadId)).messages;
    } catch {
      return null;
    }
  }

  /** The first read and every one after a change. */
  async function refresh() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const wantStatus =
          statusChanged || shown || status() === null || now() - statusAt > STATUS_AGE_MS;
        // Taken only by the read that answers it: a push folded into this refresh keeps its own.
        if (wantStatus) statusChanged = false;
        else statusLater();
        await Promise.all([loadThings(), wantStatus ? loadStatus() : Promise.resolve()]);
      } while (again);
    } finally {
      running = false;
    }
  }

  /**
   * A push: ask again once things have been quiet for a moment. `status`: the backend says the
   * status itself changed (a setting, consent, a pause), so it is read however fresh it is.
   */
  function changed(status: boolean) {
    if (status) statusChanged = true;
    if (cancelTimer !== null) return;
    cancelTimer = schedule(() => {
      cancelTimer = null;
      void refresh();
    }, COALESCE_MS);
  }

  backend.onEvent((event) => {
    if (event.type === "agentChanged") changed(event.status === true);
  });

  // --- Moving through the list ---

  function select(threadId: string) {
    setChose(true);
    if (selectedId() === threadId) return;
    setSelectedId(threadId);
    const thing = visible().find((t) => t.threadId === threadId);
    if (thing) void loadDetail(thing);
  }

  function move(delta: number) {
    const list = visible();
    if (list.length === 0) return;
    const to = Math.min(Math.max(selectedIndex() + delta, 0), list.length - 1);
    const next = list[to];
    if (next) select(next.threadId);
  }

  // --- What the person asks for ---

  const preparedOf = (thing: Thing): PreparedWork | undefined =>
    made().get(thing.threadId) ?? thing.prepared;

  /**
   * `Prepare now` and `Write the draft`: the person's ask, which may take a while. The headline
   * for the closing line comes from the list; a thread that is not in the list (an ordinary
   * thread, ADR 0063) says `fallbackHeadline`. Gives what the ask came to, or null when it did not
   * run or failed (the failure is in `problem`).
   */
  async function prepare(
    threadId: string,
    guidance?: { direction?: string; answer?: string },
    fallbackHeadline = "",
  ): Promise<PrepareResult | null> {
    if (busy().has(threadId)) return null;
    put("busy", threadId, true);
    put("problems", threadId, "");
    const headline = visible().find((t) => t.threadId === threadId)?.headline ?? fallbackHeadline;
    try {
      const work = await backend.agentPrepare(threadId, guidance);
      // Typed words may also say what should hold from now on. That is a second, background turn:
      // the reply below shows at once and `busy` clears as before, and nothing waits for it.
      const typed = (guidance?.answer ?? "").trim();
      if (typed !== "") void remember(threadId, typed);
      if (work.kind === "closed") {
        // The person's words said nothing should be written (ADR 0054): the thing leaves with a
        // line that says why, and an Undo. The reason is model text and is shown as text only.
        batch(() => {
          // The closing was recorded before the answer came.
          dealtWith(threadId, true);
          showLine(
            "closed",
            threadId,
            headline,
            `Closed: ${work.reason}${alsoOlderMails(work.alsoCovers)}`,
          );
        });
        return work;
      }
      batch(() => {
        setMade((m) => new Map(m).set(threadId, work));
        setAsked((s) => new Set(s).add(threadId));
        const words = [guidance?.answer, guidance?.direction].filter(
          (w): w is string => w !== undefined && w.trim() !== "",
        );
        setGiven((m) => new Map(m).set(threadId, words));
      });
      return work;
    } catch (error) {
      put("problems", threadId, messageOf(error, "The agent could not prepare this. Try again."));
      return null;
    } finally {
      put("busy", threadId, false);
    }
  }

  /**
   * A turn of the talk finished (ADR 0064, rule 6). A closing leaves the list with the same line and
   * Undo as any closing. A draft or a question was asked for, so the writing model wrote it, and
   * the words may hold from now on (ADR 0054, rule 7). An answer changes nothing and spends nothing.
   */
  function talkMade(
    threadId: string,
    kind: TalkAgentKind,
    text: string,
    words: string,
    headline: string,
    alsoCovers = 0,
  ) {
    if (kind === "answer") return;
    void remember(threadId, words);
    if (kind === "closed") {
      batch(() => {
        // The turn recorded the closing before it finished.
        dealtWith(threadId, true);
        showLine("closed", threadId, headline, `Closed: ${text}${alsoOlderMails(alsoCovers)}`);
      });
      return;
    }
    batch(() => {
      setAsked((s) => new Set(s).add(threadId));
      setGiven((m) => new Map(m).set(threadId, [words]));
    });
  }

  /**
   * `Send` (ADR 0052, rule 8): the text becomes a reply draft by the composer's own rules, and the
   * draft goes to the outbox with its undo window. Nothing else sends. A draft the person already
   * had is never overwritten and never sent from here: the composer opens on it.
   */
  async function send(thing: Pick<Thing, "threadId">, body: string): Promise<SendOutcome> {
    if (busy().has(thing.threadId)) return "failed";
    put("busy", thing.threadId, true);
    put("problems", thing.threadId, "");
    try {
      const made = await backend.agentDraftFromPrepared(thing.threadId, body);
      if (made.existing) {
        await options.openDraft(made.draftId);
        return "openedExisting";
      }
      await backend.requestSend(made.draftId);
      // The reply is in the outbox: the backend leaves the thing out from now on (ADR 0112).
      dealtWith(thing.threadId, true);
      return "sent";
    } catch (error) {
      put("problems", thing.threadId, messageOf(error, "That could not be sent."));
      return "failed";
    } finally {
      put("busy", thing.threadId, false);
    }
  }

  /**
   * `Edit myself`: the same draft, in the composer; from there it is the person's. If they already
   * had a draft for the thread, that one opens, untouched, and the agent's text stays a proposal.
   */
  async function editMyself(
    thing: Pick<Thing, "threadId">,
    body: string,
  ): Promise<"took" | "existing" | "failed"> {
    if (busy().has(thing.threadId)) return "failed";
    put("busy", thing.threadId, true);
    put("problems", thing.threadId, "");
    try {
      const made = await backend.agentDraftFromPrepared(thing.threadId, body);
      await options.openDraft(made.draftId);
      if (made.existing) return "existing";
      setTook((m) => new Map(m).set(thing.threadId, body));
      return "took";
    } catch (error) {
      put("problems", thing.threadId, messageOf(error, "The draft could not be opened."));
      return "failed";
    } finally {
      put("busy", thing.threadId, false);
    }
  }

  /** The selected thing, when it holds a draft that is ready to go (not one still being read). */
  function readyDraft(): { thing: Thing; body: string } | null {
    const thing = selected();
    const work = thing === undefined ? undefined : preparedOf(thing);
    if (thing === undefined || thing.updating === true || work?.kind !== "draft") return null;
    if (took().has(thing.threadId)) return null;
    return { thing, body: work.body };
  }

  /**
   * Shows what the agent kept from the person's words. On the line of a closing of this thread that
   * is still showing, it is added to that line; otherwise it is a line of its own with an Undo that
   * removes exactly what was kept. A refusal, a failure or nothing to keep shows nothing.
   */
  async function remember(threadId: string, words: string): Promise<void> {
    let items: RememberResult["items"];
    try {
      items = (await backend.agentRemember(threadId, words)).items;
    } catch {
      return;
    }
    const first = items[0];
    if (first === undefined) return;
    const text = `${rememberedText(first)}${items.length > 1 ? ` +${items.length - 1}` : ""}`;
    const current = line();
    if (current !== null && current.kind === "closed" && current.threadId === threadId) {
      setLine({ ...current, text: `${current.text} · Remembered: ${text}` });
      return;
    }
    showLine("remembered", threadId, "", `Remembered: ${text}`, items);
  }

  /**
   * `Not like this…` (ADR 0068, rule 3): a rule for a kind of mail or for a sender, made from the
   * thing in front of the person. The row leaves at once, and the line says what was kept with an
   * Undo that removes exactly that rule and brings the row back.
   */
  async function notLikeThis(thing: Thing, choice: NotLikeThis): Promise<boolean> {
    let rule: AgentRule;
    try {
      rule =
        choice.id === "category"
          ? await backend.agentAddRule({ scope: "category", subject: choice.category })
          : await backend.agentAddRule({ threadId: thing.threadId, scope: "sender" });
    } catch (error) {
      put("problems", thing.threadId, messageOf(error, "That rule could not be added."));
      return false;
    }
    batch(() => {
      // The rule is stored; it hides the thread at the next read.
      dealtWith(thing.threadId, true);
      showLine(
        "remembered",
        thing.threadId,
        thing.headline,
        `Remembered: ${ruleText(rule)}`,
        [{ kind: "rule", rule }],
        [thing.threadId],
      );
    });
    return true;
  }

  /**
   * A few words of the person's own for the reading, kept as a standing instruction for what is read
   * from now on (ADR 0068, rule 3). The thing stays: nothing is read again for it.
   */
  async function notLikeThisWords(thing: Thing, words: string): Promise<boolean> {
    const text = words.trim();
    if (text === "") return false;
    try {
      const instruction = await backend.agentAddInstruction({ scope: "understand", text });
      showLine("remembered", thing.threadId, thing.headline, `Remembered: ${instruction.text}`, [
        { kind: "instruction", instruction },
      ]);
      return true;
    } catch (error) {
      put("problems", thing.threadId, messageOf(error, "That could not be kept."));
      return false;
    }
  }

  /**
   * The thing leaves the list at once; the selection goes to the next one. `done`: the backend
   * already holds what makes it leave, so the next read of the list has the final word; otherwise
   * `recorded()` says so once it does.
   */
  function dealtWith(threadId: string, done = false) {
    // What the person did must not rearrange what they are looking at (ADR 0062).
    if (held === null && query() === "" && listedFor === "") {
      held = things().map((t) => ({ threadId: t.threadId, now: t.now === true }));
    }
    const list = visible();
    const at = list.findIndex((t) => t.threadId === threadId);
    setHidden((h) => new Map(h).set(threadId, done ? thingsSeq : null));
    if (selectedId() === threadId) {
      const next = list[at + 1] ?? list[at - 1];
      setSelectedId(next?.threadId ?? null);
      ensureSelection();
    }
  }

  function unhide(threadIds: readonly string[]) {
    holdRest();
    setHidden((h) => {
      const next = new Map(h);
      for (const id of threadIds) next.delete(id);
      return next;
    });
  }

  /**
   * The backend recorded what made these things leave: the first read of the list asked from now
   * on decides whether they stay out (ADR 0112). A read already on its way may predate it.
   */
  function recorded(threadIds: readonly string[]) {
    setHidden((h) => {
      if (!threadIds.some((id) => h.get(id) === null)) return h;
      const next = new Map(h);
      for (const id of threadIds) if (next.get(id) === null) next.set(id, thingsSeq);
      return next;
    });
  }

  function clearLine() {
    cancelLine?.();
    cancelLine = null;
    setLine(null);
  }

  /**
   * `Not important`, `Later` (ADR 0052, rule 9), `No reply needed` (ADR 0054) and the closings that
   * say what they meant (ADR 0066, rule 7), with a line in the tray and an Undo.
   */
  async function feedback(
    thing: Thing,
    kind: FeedbackKind,
    outcome?: ClosingOutcome,
  ): Promise<boolean> {
    const index = visible().findIndex((t) => t.threadId === thing.threadId);
    dealtWith(thing.threadId);
    let alsoCovers: number;
    try {
      alsoCovers = await backend.agentFeedback(thing.threadId, kind, outcome);
    } catch (error) {
      // Not recorded: the thing comes back and the reason is said where it was.
      setHidden((h) => {
        const next = new Map(h);
        next.delete(thing.threadId);
        return next;
      });
      put("problems", thing.threadId, messageOf(error, "That did not work."));
      if (index >= 0) select(thing.threadId);
      return false;
    }
    recorded([thing.threadId]);
    // A closing that says what it meant (done, taken, declined) is not a no to the sender: the
    // tray offers no rule for it. Only the plain "no reply needed" and "not important" do.
    showLine(
      kind,
      thing.threadId,
      thing.headline,
      `${outcome === undefined ? FEEDBACK_TEXT[kind] : OUTCOME_TEXT[outcome]}${alsoOlderMails(alsoCovers)}`,
      undefined,
      undefined,
      outcome === undefined,
    );
    return true;
  }

  /**
   * The same for several things at once (ADR 0056, rule 5): one line and one Undo for all of them.
   * What the backend refused comes back, and the line counts only what was recorded.
   */
  async function feedbackMany(group: readonly Thing[], kind: FeedbackKind): Promise<number> {
    const [only] = group;
    if (only === undefined) return 0;
    if (group.length === 1) return (await feedback(only, kind)) ? 1 : 0;
    batch(() => {
      for (const thing of group) dealtWith(thing.threadId);
    });
    const results = await Promise.allSettled(
      group.map((thing) => backend.agentFeedback(thing.threadId, kind)),
    );
    const done = group.filter((_, i) => results[i]?.status === "fulfilled");
    const refused = group.filter((_, i) => results[i]?.status !== "fulfilled");
    recorded(done.map((t) => t.threadId));
    if (refused.length > 0) {
      unhide(refused.map((t) => t.threadId));
      for (const thing of refused) put("problems", thing.threadId, "That did not work.");
    }
    const [first] = done;
    if (first !== undefined) {
      const alsoCovers = results.reduce(
        (sum, r) => sum + (r.status === "fulfilled" ? (r.value ?? 0) : 0),
        0,
      );
      showLine(
        kind,
        first.threadId,
        "",
        `${thingsCount(done.length)}: ${FEEDBACK_TEXT[kind].toLowerCase()}${alsoOlderMails(alsoCovers)}`,
        undefined,
        done.map((t) => t.threadId),
      );
    }
    return done.length;
  }

  /** The one place the tray's line is set, with the time Undo is offered. */
  function showLine(
    kind: LineKind,
    threadId: string,
    headline: string,
    text: string,
    added?: RememberResult["items"],
    threadIds?: readonly string[],
    offersRule = true,
  ) {
    cancelLine?.();
    const id = ++lineSeq;
    setLine({
      id,
      kind,
      threadId,
      headline,
      text,
      ...(added === undefined ? {} : { added }),
      ...(threadIds === undefined ? {} : { threadIds }),
    });
    cancelLine = schedule(() => {
      if (lineSeq === id) setLine(null);
    }, FEEDBACK_UNDO_MS);
    // After saying no to one thing; the backend decides when that adds up to a rule (ADR 0058, rule
    // 4). Not after `Later` or a group. The line does not wait for it.
    if ((kind === "closed" || kind === "notImportant") && threadIds === undefined && offersRule) {
      void offerRule(id, threadId);
    }
  }

  async function offerRule(id: number, threadId: string): Promise<void> {
    try {
      const offer = await backend.agentRuleOffer(threadId);
      if (offer === null) return;
      const current = line();
      if (lineSeq === id && current?.id === id) setLine({ ...current, offer });
    } catch {
      // No offer: the closing stands as it is.
    }
  }

  /** `Always for <address>` on the tray's line: a rule for the sender, made by this click. */
  async function addRuleFromLine(): Promise<void> {
    const current = line();
    const offer = current?.offer;
    if (current === null || offer === undefined) return;
    try {
      await backend.agentAddRule(
        offer.scope === "domain"
          ? { scope: "domain", subject: offer.subject }
          : { threadId: current.threadId, scope: "sender" },
      );
    } catch (error) {
      // The line stays, with the offer, and says why.
      if (lineSeq === current.id) {
        setLine({ ...current, text: messageOf(error, "That rule could not be added.") });
      }
      return;
    }
    if (lineSeq !== current.id) return;
    const { offer: _offer, ...rest } = current;
    setLine({ ...rest, text: ruleText(offer) });
  }

  /** Undo on the tray's line: the feedback is forgotten and the thing returns. */
  async function undoFeedback(): Promise<void> {
    const current = line();
    if (current === null) return;
    clearLine();
    if (current.kind === "remembered") {
      // Exactly what this result added, by id; the thing itself was never hidden.
      for (const item of current.added ?? []) {
        try {
          if (item.kind === "rule") await backend.agentRemoveRule(item.rule.id);
          else await backend.agentRemoveInstruction(item.instruction.id);
        } catch {
          // What could not be removed stays, and shows in Settings with its own Undo.
        }
      }
      // A rule made from a thing hid its row; the rule is gone, so the row returns.
      if (current.threadIds !== undefined) {
        unhide(current.threadIds);
        await loadThings();
      }
      return;
    }
    const kind = current.kind;
    const ids = current.threadIds ?? [current.threadId];
    const results = await Promise.allSettled(ids.map((id) => backend.agentUndoFeedback(id, kind)));
    const back = ids.filter((_, i) => results[i]?.status === "fulfilled");
    if (back.length === 0) return;
    unhide(back);
    await loadThings();
  }

  // --- Settings the page changes ---

  /** The buttons of the reading screen. The status they return is shown at once. */
  const screenAction = (work: () => Promise<AgentStatus>) => async (): Promise<void> => {
    try {
      await change(work());
    } catch {
      // The screen keeps what it said; the next push or status read corrects it.
    }
  };

  async function change(work: Promise<AgentStatus>): Promise<AgentStatus> {
    const next = await order.settle(work, (value) => {
      batch(() => {
        setStatus(value);
        statusAt = now();
      });
      writeEnabledHint(value.settings.enabled);
    });
    void loadThings();
    return next;
  }

  return {
    status,
    things: visible,
    loaded,
    /** AI is on: the tab exists. */
    enabled,
    /** Every thing there is, loaded or not, minus what was just dealt with. */
    count: () => Math.max(0, total() - hidden().size),
    loadMore,
    /** Things are split into what is for now and the rest (ADR 0058, rule 2). */
    sections,
    /** How many rows of what shows are for now. */
    nowRows: () => visible().filter((t) => t.now === true).length,
    /** How many are in the rest, loaded or not. */
    restCount: () => Math.max(0, total() - (nowCount() ?? total())),
    restOpen,
    setRestOpen(open: boolean) {
      setRestOpen(open);
      ensureSelection();
      if (open) void loadMore();
    },
    /** The bar's text, while it constrains anything: Matters shows what matches it. */
    setQuery(text: string) {
      if (text === query()) return;
      batch(() => {
        setQueryText(text);
        setSearching(text !== "");
      });
      wanted = THINGS_PAGE;
      void loadThings();
    },
    /** A search is on, so an empty list says nothing about the mail or the reading. */
    filtered: () => query() !== "",
    /** The bar's text is not answered yet. */
    searching,
    feedbackMany,
    /**
     * The thread is being moved out of the mail (delete, spam): out of the list until the move is
     * recorded (`recorded`) and the list read after that says so, or until `unhide` (ADR 0112).
     */
    hide: (threadIds: readonly string[]) => {
      batch(() => {
        for (const id of threadIds) dealtWith(id);
      });
    },
    unhide,
    recorded,
    selected,
    selectedIndex,
    selectedId,
    /** The person opened a thing themselves; false while the first one opened by itself. */
    chose,
    detail,
    threadMessages,
    line,
    busy: (threadId: string) => busy().has(threadId),
    problem: (threadId: string) => problems().get(threadId) ?? "",
    preparedOf,
    /** The direction picked on the thread's question, if any. */
    directionOf: (threadId: string): string | undefined => chosen().get(threadId),
    chooseDirection(threadId: string, direction: string) {
      setChosen((m) => new Map(m).set(threadId, direction));
    },
    /** The text the person took over from the agent, if they did. */
    tookOver: (threadId: string): string | undefined => took().get(threadId),
    /** The words the person gave for this thread in this window. */
    givenFor: (threadId: string): readonly string[] => given().get(threadId) ?? [],
    /** The draft was asked for by the person, so the writing model wrote it. */
    askedFor: (threadId: string) => asked().has(threadId),
    /** The first read. */
    start: refresh,
    refresh,
    /** Matters is on screen (or not): the status is then kept fresh. */
    setShown(on: boolean) {
      shown = on;
      // A status a push skipped is read now too: the reading screen shows all of it.
      if (on && (cancelStatusLater !== null || now() - statusAt > STATUS_AGE_MS)) {
        void loadStatus();
      }
      if (!on && held !== null) {
        held = null;
        settle = true;
      } else if (on && settle) {
        settle = false;
        void loadThings();
      }
    },
    /** ⌘↵: the ready draft of the selected thing, by the same path as the Send button. */
    async sendSelected(): Promise<SendOutcome | "none"> {
      const ready = readyDraft();
      return ready === null ? "none" : send(ready.thing, ready.body);
    },
    /** `e`: the ready draft of the selected thing, in the composer. */
    async editSelected(): Promise<"took" | "existing" | "failed" | "none"> {
      const ready = readyDraft();
      return ready === null ? "none" : editMyself(ready.thing, ready.body);
    },
    /** A digit key on a question: picks that direction. Returns whether it picked one. */
    pickDirection(digit: string): boolean {
      const thing = selected();
      const work = thing === undefined ? undefined : preparedOf(thing);
      if (thing === undefined || work?.kind !== "needs" || !/^[1-9]$/.test(digit)) return false;
      const direction = work.directions[Number(digit) - 1];
      if (direction === undefined) return false;
      setChosen((m) => new Map(m).set(thing.threadId, direction));
      return true;
    },
    select,
    move,
    prepare,
    talkMade,
    send,
    editMyself,
    feedback,
    notLikeThis,
    notLikeThisWords,
    undoFeedback,
    addRuleFromLine,
    dismissLine: clearLine,
    /** `Pause` and `Continue` on the reading screen (ADR 0053, rule 8). */
    pauseReading: screenAction(() => backend.agentPauseReading()),
    resumeReading: screenAction(() => backend.agentResumeReading()),
    /** `Look again`: asks the program who is signed in. It never starts a login. */
    lookAgain: screenAction(() => backend.agentInspect()),
    /** `Try again`: the test with a made-up message. */
    tryAgain: screenAction(() => backend.agentTestRuntime()),
    /** `Read further back`: the window grows to the next step (30, then 90 days). */
    readFurtherBack: async (): Promise<void> => {
      const days = nextWindow(status()?.settings.windowDays ?? 30);
      if (days === undefined) return;
      await screenAction(() => backend.agentSetWindowDays(days))();
    },
    /** After a setting changed in this window (models, week share, window, consent). */
    change,
    setStatus(next: AgentStatus) {
      batch(() => {
        setStatus(next);
        statusAt = now();
      });
      writeEnabledHint(next.settings.enabled);
    },
  };
}

export type AgentStore = ReturnType<typeof createAgentStore>;
