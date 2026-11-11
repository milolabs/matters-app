import { NEEDS_YOU_VIEW, parseQuery, type SavedView } from "@matters/core";
import { batch, createSignal } from "solid-js";
import type { Backend } from "./client.ts";
import type { MailStore } from "./store.ts";

/** ADR 0027. Built in, first, never stored and never edited. */
export const ALL_MAIL_ID = "all";

export interface ViewTab {
  readonly id: string;
  readonly name: string;
  /** The query text the tab stands for; `All mail` is the empty text. */
  readonly query: string;
}

export const ALL_MAIL: ViewTab = { id: ALL_MAIL_ID, name: "All mail", query: "" };

/** ADR 0052, rule 1. Built in like `All mail`: it is not a saved view and has no query. */
export const MATTERS_ID = "matters";
export const MATTERS: ViewTab = { id: MATTERS_ID, name: "Matters", query: "" };

/** The tabs that are not saved views: they cannot be renamed, moved or deleted. */
export const isBuiltInView = (id: string): boolean => id === ALL_MAIL_ID || id === MATTERS_ID;

/** A badge counts up to this many and says `99+` at it. */
export const BADGE_CAP = 99;
/** Quiet time after the last `changes` event or keystroke before badges are counted again. */
export const BADGE_QUIET_MS = 1500;
/** Between two count requests: the router has one thread and a keystroke may be waiting. */
export const BADGE_GAP_MS = 16;

export type Outcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** What the inline naming row is for. */
export type Naming =
  | { readonly mode: "new" }
  | { readonly mode: "rename"; readonly id: string; readonly name: string };

export interface ViewsOptions {
  /** Replaces the whole query text: input, mirror and store (the bar's `setText`). */
  readonly setText?: (text: string) => void;
  /** Resolves after `ms`; tests inject one they control. */
  readonly delay?: (ms: number) => Promise<void>;
  readonly quietMs?: number;
  readonly gapMs?: number;
}

const realDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The text holds a prompt (ADR 0116): what the view shows is not what its mail filters match. */
export const holdsPrompt = (query: string): boolean => parseQuery(query).prompt !== undefined;

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "Something went wrong.";
}

/** Saved views as tabs over the one query text (ADR 0027): never anything the bar does not hold. */
export function createViewsStore(backend: Backend, store: MailStore, options: ViewsOptions = {}) {
  const delay = options.delay ?? realDelay;
  const quietMs = options.quietMs ?? BADGE_QUIET_MS;
  const gapMs = Math.max(options.gapMs ?? BADGE_GAP_MS, BADGE_GAP_MS);
  let setText: (text: string) => void = options.setText ?? ((text) => store.setQuery(text));

  const [saved, setSaved] = createSignal<readonly SavedView[]>([]);
  const [activeId, setActiveId] = createSignal(ALL_MAIL_ID);
  const [loaded, setLoaded] = createSignal(false);
  const [naming, setNaming] = createSignal<Naming | null>(null);
  // Why the last save or edit failed; cleared by the next thing the user does.
  const [problem, setProblem] = createSignal("");
  // Unread count per view id; absent: nothing to show (not counted yet, zero, or a failed count).
  const [counts, setCounts] = createSignal<Readonly<Record<string, number>>>({});
  // `Matters` exists while AI is on (ADR 0052, rule 1). The person's own choice of a tab, or text
  // in the bar, ends the right of the app to open it by default.
  const [mattersOn, setMattersOn] = createSignal(false);
  let chose = false;
  const openedListeners = new Set<(view: ViewTab) => void>();

  const views = (): readonly ViewTab[] =>
    mattersOn() ? [MATTERS, ALL_MAIL, ...saved()] : [ALL_MAIL, ...saved()];
  const active = (): ViewTab => views().find((v) => v.id === activeId()) ?? ALL_MAIL;
  /** The text in the bar differs from the active view's saved text. */
  const changed = () => store.query() !== active().query;
  const isSaved = () => !isBuiltInView(active().id);

  /**
   * The bar's text could be a view. A prompt alone can (ADR 0116, rule 10): it constrains no
   * mail filter, and it is still what the view shows.
   */
  const savable = () =>
    isSaved() ? store.query().trim() !== "" : store.filtered() || holdsPrompt(store.query());

  function put(view: SavedView) {
    setSaved((all) => all.map((v) => (v.id === view.id ? view : v)));
  }

  /** Runs a write; a refusal comes back as a message the UI shows, never as a throw. */
  async function attempt(work: () => Promise<void>): Promise<Outcome> {
    try {
      await work();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }

  // --- badges -------------------------------------------------------------------------------

  // A run holds the generation it began in; any change bumps it and the run stops where it is.
  let generation = 0;

  function restartBadges(afterMs: number) {
    const mine = ++generation;
    void delay(afterMs).then(() => (mine === generation ? countAll(mine) : undefined));
  }

  function setCount(id: string, count: number | undefined) {
    setCounts((all) => {
      if (count === undefined || count === 0) {
        if (!(id in all)) return all;
        const { [id]: _gone, ...rest } = all;
        return rest;
      }
      return all[id] === count ? all : { ...all, [id]: count };
    });
  }

  /**
   * One view at a time, one window per request, a gap between requests. `All mail` counts its
   * unread mail like any view (ADR 0093): every tab's number means the same thing.
   */
  async function countAll(mine: number) {
    const counted = [{ id: ALL_MAIL_ID, query: "is:unread" }, ...saved()];
    for (const view of counted) {
      if (holdsPrompt(view.query)) {
        // ADR 0117, rule 4: the unread threads among those the view shows, from its verdicts.
        // A view never run, or AI off, shows none.
        let n: number | undefined;
        try {
          const b = await backend.agentPromptBadge(view.query);
          n = b.ai === "on" && b.unread !== null ? Math.min(b.unread, BADGE_CAP) : undefined;
        } catch {
          n = undefined;
        }
        if (mine !== generation) return;
        setCount(view.id, n);
        await delay(gapMs);
        if (mine !== generation) return;
        continue;
      }
      let total = 0;
      let before: number | undefined;
      for (;;) {
        let r: Awaited<ReturnType<Backend["countMatches"]>>;
        try {
          r = await backend.countMatches({
            query: view.query,
            cap: BADGE_CAP - total,
            ...(before === undefined ? {} : { beforeKey: before }),
          });
        } catch {
          if (mine === generation) setCount(view.id, undefined);
          break;
        }
        if (mine !== generation) return;
        total += r.count;
        if (total >= BADGE_CAP || r.nextBeforeKey === undefined) {
          setCount(view.id, Math.min(total, BADGE_CAP));
          break;
        }
        before = r.nextBeforeKey;
        await delay(gapMs);
        if (mine !== generation) return;
      }
      await delay(gapMs);
      if (mine !== generation) return;
    }
  }

  // Typing abandons the run and starts the quiet time over. Text in the bar searches the active
  // view, and in Matters that is its own list (ADR 0056, rule 1).
  store.onQueryChange((text) => {
    restartBadges(quietMs);
    if (text !== "") chose = true;
  });

  // --- actions ------------------------------------------------------------------------------

  async function load() {
    const list = await backend.listViews();
    batch(() => {
      setSaved(list);
      setLoaded(true);
    });
    restartBadges(0);
  }

  function select(id: string) {
    const view = views().find((v) => v.id === id);
    // The tab already shown: nothing moves, and the user's unsaved text stays.
    if (!view) return;
    chose = true;
    if (view.id === activeId()) return;
    batch(() => {
      setActiveId(view.id);
      setNaming(null);
      setProblem("");
    });
    // Selecting only moves the text; the bar keeps input, mirror and store in step.
    setText(view.query);
    for (const listener of openedListeners) listener(view);
  }

  /** Back to the saved text; for `All mail` that is clearing the query. */
  function revert() {
    batch(() => {
      setProblem("");
      setNaming(null);
    });
    setText(active().query);
  }

  /** Writes the bar's text into the active saved view. */
  async function save(): Promise<Outcome> {
    const view = active();
    const text = store.query();
    if (isBuiltInView(view.id)) return { ok: false, message: `${view.name} cannot be changed.` };
    const out = await attempt(async () => put(await backend.updateViewQuery(view.id, text)));
    setProblem(out.ok ? "" : out.message);
    if (out.ok) restartBadges(0);
    return out;
  }

  /** A new view from the bar's text; it becomes the active one. */
  async function saveAs(name: string): Promise<Outcome> {
    const text = store.query();
    return attempt(async () => {
      const view = await backend.createView(name, text);
      batch(() => {
        setSaved((all) => [...all, view]);
        setActiveId(view.id);
        setNaming(null);
        setProblem("");
      });
      restartBadges(0);
    });
  }

  /**
   * A new view from a name and a query given whole, as the agent's offers are saved (ADR 0102):
   * the tab is added, the active one and the bar's text stay as they are.
   */
  async function create(
    name: string,
    query: string,
  ): Promise<
    | { readonly ok: true; readonly view: SavedView }
    | { readonly ok: false; readonly message: string }
  > {
    try {
      const view = await backend.createView(name, query);
      setSaved((all) => [...all, view]);
      restartBadges(0);
      return { ok: true, view };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }

  async function rename(id: string, name: string): Promise<Outcome> {
    if (isBuiltInView(id)) return { ok: false, message: "That view cannot be renamed." };
    return attempt(async () => {
      put(await backend.renameView(id, name));
      setNaming(null);
    });
  }

  async function remove(id: string): Promise<Outcome> {
    if (isBuiltInView(id)) return { ok: false, message: "That view cannot be deleted." };
    const wasActive = id === activeId();
    const out = await attempt(async () => {
      await backend.deleteView(id);
      batch(() => {
        setSaved((all) => all.filter((v) => v.id !== id));
        setCount(id, undefined);
        if (wasActive) setActiveId(ALL_MAIL_ID);
        setNaming(null);
        setProblem("");
      });
      // The deleted view's text is not what All mail shows: it starts empty.
      if (wasActive) setText("");
      restartBadges(0);
    });
    if (!out.ok) setProblem(out.message);
    return out;
  }

  /** Moves a saved view by `delta` places (-1 left, 1 right). */
  async function move(id: string, delta: number): Promise<Outcome> {
    const from = saved().findIndex((v) => v.id === id);
    const to = Math.min(Math.max(from + delta, 0), saved().length - 1);
    if (from < 0 || to === from) return { ok: true };
    const out = await attempt(async () => {
      await backend.moveView(id, to);
      setSaved((all) => {
        const next = [...all];
        const [view] = next.splice(from, 1);
        if (view) next.splice(to, 0, view);
        return next;
      });
    });
    if (!out.ok) setProblem(out.message);
    return out;
  }

  /** What the naming row's Save does, for either mode. */
  function submitName(name: string): Promise<Outcome> {
    const mode = naming();
    if (!mode) return Promise.resolve({ ok: true });
    return mode.mode === "rename" ? rename(mode.id, name) : saveAs(name);
  }

  return {
    views,
    saved,
    active,
    changed,
    /** A saved view is active (not `All mail`). */
    isSaved,
    loaded,
    /** The bar's text is empty or only spaces. */
    blank: () => store.query().trim() === "",
    naming,
    problem,
    /** Unread count of a view (`All mail` or saved), `undefined` for none to show. */
    count: (id: string): number | undefined => counts()[id],
    /** The badge text: `99+` at the cap. */
    badge: (id: string): string | undefined => {
      const n = counts()[id];
      return n === undefined ? undefined : n >= BADGE_CAP ? `${BADGE_CAP}+` : String(n);
    },
    load,
    select,
    revert,
    save,
    saveAs,
    create,
    rename,
    remove,
    move,
    submitName,
    /** The bar's text could be saved as a new view: constrained or a prompt on `All mail`, any text in a view. */
    canSaveAs: () => activeId() !== MATTERS_ID && savable(),
    /** Opens the naming row for a new view; true when it is open. */
    startNaming(): boolean {
      if (naming()) return true;
      // A search of Matters is not a saved view: a view searches mail (ADR 0056, rule 1).
      if (activeId() === MATTERS_ID) return false;
      if (!savable()) return false;
      setNaming({ mode: "new" });
      return true;
    },
    startRename(id: string) {
      const view = saved().find((v) => v.id === id);
      if (view) setNaming({ mode: "rename", id, name: view.name });
    },
    cancelNaming: () => setNaming(null),
    clearProblem: () => setProblem(""),
    /** A tab was opened and its text is in the bar (a view with a prompt reads, ADR 0116, rule 3). */
    onOpened(listener: (view: ViewTab) => void) {
      openedListeners.add(listener);
      return () => openedListeners.delete(listener);
    },
    /** The bar's `setText`, once the bar exists. */
    bindText(fn: (text: string) => void) {
      setText = fn;
    },
    /** A `changes` event: counts may have moved. */
    noteChanges: () => restartBadges(quietMs),
    /**
     * AI turned on or off. Turning on opens Matters unless the person already chose a tab or typed;
     * turning off takes the tab away and leaves the app as it was before.
     */
    setMattersAvailable(on: boolean) {
      if (on === mattersOn()) return;
      batch(() => {
        setMattersOn(on);
        if (on && !chose && store.query() === "") {
          setActiveId(MATTERS_ID);
          setNaming(null);
          setProblem("");
        } else if (!on && activeId() === MATTERS_ID) {
          setActiveId(ALL_MAIL_ID);
        }
      });
    },
    /**
     * ADR 0117, rule 2: opens `Needs you` while the person has neither chosen a tab nor typed, as
     * `setMattersAvailable` opens Matters; true when it did. Not wired while Matters exists.
     */
    openStarter(): boolean {
      if (chose || store.query() !== "") return false;
      const view = saved().find((v) => v.id === NEEDS_YOU_VIEW.id);
      if (view === undefined) return false;
      if (activeId() !== view.id) {
        batch(() => {
          setActiveId(view.id);
          setNaming(null);
          setProblem("");
        });
        setText(view.query);
        for (const listener of openedListeners) listener(view);
      }
      return true;
    },
    /** Stops counting; the next trigger starts it again. */
    stop: () => {
      generation++;
    },
  };
}

export type ViewsStore = ReturnType<typeof createViewsStore>;
