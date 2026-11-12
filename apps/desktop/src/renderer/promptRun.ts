// A prompt is a filter (ADR 0116), on the page: what is known before a run, the run the person
// asks for (a search, then the reading), its progress with Stop, `Search again`, and the rows it
// kept. It holds signals only; the app decides what
// the list shows from them. Nothing here is on the keystroke path: the count waits for a quiet
// moment, and every answer for text that is no longer in the bar is dropped.
import {
  PROMPT_ASK_ABOVE,
  type PromptCount,
  type PromptList,
  type PromptProgress,
  type PromptRow,
} from "@matters/core";
import { batch, createSignal } from "solid-js";
import { type Backend, BackendError } from "./client.ts";
import {
  type BackgroundShown,
  type PromptOutcome,
  type PromptProgressShown,
  toReadOf,
} from "./promptView.ts";

/** After the last keystroke, before the count is asked (rule 4). */
export const COUNT_QUIET_MS = 400;
/** After the last `changes` event, before the rows shown are read again. */
export const CHANGES_QUIET_MS = 1500;
/**
 * While a run reads, the rows are read again at most this often: a run of thousands of threads
 * must not read every verdict after every batch of ten.
 */
export const PROGRESS_READ_MS = 1000;

const FAILED = "The assistant could not work on this prompt. Try again.";

export type PromptBackend = Pick<
  Backend,
  "agentPromptCount" | "agentPromptVerdicts" | "agentPromptRun" | "agentPromptStop" | "onEvent"
>;

export interface PromptRunOptions {
  /** Runs `run` after `ms`; returns a cancel. Tests inject one they control. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
  readonly countQuietMs?: number;
  readonly changesQuietMs?: number;
  /** 0: the rows are read again after every batch. */
  readonly progressReadMs?: number;
}

const realSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/** What the line shows of a progress event: how far, what is out, and who reads (rule 3a). */
const shownOf = (event: PromptProgress): BackgroundShown => ({
  phase: event.phase,
  done: event.done,
  total: event.total,
  ...(event.step === undefined ? {} : { step: event.step }),
  ...(event.fits === undefined ? {} : { fits: event.fits }),
  ...(event.inFlight === undefined ? {} : { inFlight: event.inFlight }),
  ...(event.answered === undefined ? {} : { answered: event.answered }),
  ...(event.runtime === undefined ? {} : { runtime: event.runtime }),
  ...(event.local === true ? { local: true as const } : {}),
  ...(event.waiting === undefined ? {} : { waiting: event.waiting }),
  ...(event.view === undefined ? {} : { view: event.view }),
});

const countOf = (l: PromptList): PromptCount => ({
  ai: l.ai,
  promptKey: l.promptKey,
  searched: l.searched,
  found: l.found,
  ...(l.limit === undefined ? {} : { limit: l.limit }),
  read: l.read,
  fits: l.fits,
  ...(l.toRead === undefined ? {} : { toRead: l.toRead }),
  ...(l.reached === undefined ? {} : { reached: l.reached }),
  ...(l.whole === undefined ? {} : { whole: l.whole }),
});

/** A run this window asked for. `gen` is the text it was for; `key` its prompt, once known. */
interface Run {
  readonly gen: number;
  key: string | null;
  done: Promise<void>;
}

export function createPromptRun(backend: PromptBackend, options: PromptRunOptions = {}) {
  const schedule = options.schedule ?? realSchedule;
  const countQuietMs = options.countQuietMs ?? COUNT_QUIET_MS;
  const changesQuietMs = options.changesQuietMs ?? CHANGES_QUIET_MS;
  const progressReadMs = options.progressReadMs ?? PROGRESS_READ_MS;

  const [text, setText] = createSignal("");
  const [has, setHas] = createSignal(false);
  const [count, setCount] = createSignal<PromptCount | null>(null);
  // The rows the list shows in place of the mail filters' result; null: the result shows.
  const [rows, setRows] = createSignal<readonly PromptRow[] | null>(null);
  const [progress, setProgress] = createSignal<PromptProgressShown | null>(null);
  const [stopping, setStopping] = createSignal(false);
  const [outcome, setOutcome] = createSignal<PromptOutcome | null>(null);
  // This prompt read in the background now (ADR 0117, rule 3a): shown on the line by itself.
  const [background, setBackground] = createSignal<BackgroundShown | null>(null);
  // A saved view was opened and what it keeps is not here yet: the list is empty, and says nothing.
  const [opening, setOpening] = createSignal(false);

  // Bumped by every new text: an answer for an older one is dropped.
  let gen = 0;
  let run: Run | null = null;
  let cancelCount: (() => void) | null = null;
  let cancelChanges: (() => void) | null = null;
  let cancelProgressRead: (() => void) | null = null;
  // One read of the verdicts at a time; one asked for meanwhile goes when it answers.
  let reading = false;
  let readAgain = false;
  // The text is a saved view's, opened (rule 3): the tab is named for the prompt, so the list is
  // only ever what fits it. The mail filters' result alone would show mail the prompt never kept.
  let asView = false;
  const [viewShown, setViewShown] = createSignal(false);

  /** The prompt's key, learned from any answer for this text: progress of other prompts is not ours. */
  function learn(key: string) {
    if (run !== null && run.gen === gen && run.key === null && key !== "") run.key = key;
  }

  function apply(l: PromptList) {
    learn(l.promptKey);
    batch(() => {
      // Before the first search there is no list of the prompt's: the mail filters' result shows,
      // unless the text is a view's, which shows nothing until something fits.
      setRows(l.searched ? l.rows : asView ? [] : null);
      setCount(countOf(l));
    });
  }

  async function askCount(mine: number) {
    try {
      const c = await backend.agentPromptCount(text());
      if (mine !== gen) return;
      learn(c.promptKey);
      setCount(c);
      // A search is kept for this text: the list is the prompt's, what fits of what is read so
      // far, also while more is left to read. The mail filters' result beside a line that counts
      // the prompt's threads would pass for what the prompt kept.
      if (c.ai === "on" && c.searched && rows() === null) void readVerdicts();
    } catch {
      // The line stays quiet; ↵ still runs.
    }
  }

  async function readVerdicts() {
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    try {
      do {
        readAgain = false;
        const mine = gen;
        if (!has()) break;
        try {
          const l = await backend.agentPromptVerdicts(text());
          if (mine === gen && l.ai === "on") apply(l);
        } catch {
          // What is shown stays; the next batch or change asks again.
        }
      } while (readAgain);
    } finally {
      reading = false;
    }
  }

  function stopInFlight() {
    backend.agentPromptStop().catch(() => {});
  }

  /** The text in the bar changed, and whether it holds a prompt (with AI on, rule 11). */
  function setQuery(next: string, hasPrompt: boolean) {
    if (next === text() && hasPrompt === has()) return;
    gen++;
    cancelCount?.();
    cancelCount = null;
    cancelChanges?.();
    cancelChanges = null;
    cancelProgressRead?.();
    cancelProgressRead = null;
    // One run at a time, of the text it was asked for (rule 9): other text stops it.
    if (run !== null) stopInFlight();
    asView = false;
    batch(() => {
      setViewShown(false);
      setText(next);
      setHas(hasPrompt);
      setOpening(false);
      setCount(null);
      setRows(null);
      setProgress(null);
      setStopping(false);
      setOutcome(null);
      setBackground(null);
    });
    if (!hasPrompt) return;
    const mine = gen;
    cancelCount = schedule(() => {
      cancelCount = null;
      void askCount(mine);
    }, countQuietMs);
  }

  /**
   * `↵` with a prompt (rule 3), `P0`: the agent's search first when none is kept for this text,
   * or with `again` (rule 4), then the reading of what it found that has no verdict. Everything
   * read already shows the kept rows and spends nothing. A run of this text going on is left to go
   * on. `readAll`: the person saw how many are left, so above `PROMPT_ASK_ABOVE` it reads them
   * all (rule 4); without it the backend stops there and asks.
   */
  function start(again = false, readAll = false): Promise<void> {
    if (!has()) return Promise.resolve();
    if (run !== null && run.gen === gen) return run.done;
    const c = count();
    if (c?.ai === "off") return Promise.resolve();
    if (!again && c !== null && c.searched && toReadOf(c) === 0) return readVerdicts();
    const mine = gen;
    const q = text();
    const previous = run;
    const entry: Run = {
      gen: mine,
      key: c === null || c.promptKey === "" ? null : c.promptKey,
      done: Promise.resolve(),
    };
    run = entry;
    batch(() => {
      setOutcome(null);
      setStopping(false);
      setProgress(
        !again && c?.searched === true
          ? { phase: "reading", done: 0, total: toReadOf(c) }
          : { phase: "searching", done: 0, total: 0 },
      );
    });
    entry.done = (async () => {
      try {
        // The backend runs one prompt at a time: a stopped one ends first.
        if (previous !== null) await previous.done;
        if (mine !== gen) return;
        // What is kept shows at once; each batch adds to it.
        void readVerdicts();
        const r = await backend.agentPromptRun(q, again, readAll);
        if (mine !== gen) return;
        if (r.ai === "off") {
          setProgress(null);
          return;
        }
        learn(r.promptKey);
        batch(() => {
          setRows(r.searched ? r.rows : asView ? [] : null);
          setCount(countOf(r));
          setProgress(null);
          setStopping(false);
          setOutcome(
            r.problem !== undefined || r.rejected > 0
              ? { ...(r.problem === undefined ? {} : { problem: r.problem }), rejected: r.rejected }
              : null,
          );
        });
      } catch (error) {
        if (mine !== gen) return;
        batch(() => {
          setProgress(null);
          setStopping(false);
          setOutcome({
            problem: error instanceof BackendError && error.message !== "" ? error.message : FAILED,
            rejected: 0,
            failed: true,
          });
        });
      } finally {
        if (run === entry) run = null;
      }
    })();
    return entry.done;
  }

  /** Stop (rule 9): the batches that finished are kept, and the run's answer says the rest. */
  function stop() {
    if (run === null || run.gen !== gen || stopping()) return;
    setStopping(true);
    stopInFlight();
  }

  /**
   * A saved view whose text holds a prompt was opened (rule 3): its kept rows show at once, and a
   * run starts for what it has not read; with no kept search, the run searches first.
   */
  async function open(): Promise<void> {
    if (!has()) return;
    const mine = gen;
    // The verdicts carry the count.
    cancelCount?.();
    cancelCount = null;
    // At once, before anything is asked: the mail filters' result never shows under the view's name.
    asView = true;
    batch(() => {
      setViewShown(true);
      if (rows() === null) setRows([]);
      setOpening(true);
    });
    try {
      const l = await backend.agentPromptVerdicts(text());
      if (mine !== gen) return;
      if (l.ai === "off") {
        // AI is off: nothing can fit (rule 11), and the diagnostic says why. The list stays empty.
        batch(() => {
          setRows([]);
          setOpening(false);
          setCount(countOf(l));
        });
        return;
      }
      batch(() => {
        apply(l);
        setOpening(false);
      });
      // More than `PROMPT_ASK_ABOVE` to read: the line asks, and nothing runs (rule 4). Under a
      // limit nothing is asked: the run stops once that many fit (rule 4a).
      const c = countOf(l);
      const todo = toReadOf(c);
      if (!l.searched || (todo > 0 && (c.limit !== undefined || todo <= PROMPT_ASK_ABOVE))) {
        await start();
      }
    } catch {
      if (mine !== gen) return;
      setOpening(false);
      void askCount(mine);
    }
  }

  const off = backend.onEvent((event) => {
    if (event.type === "agentPromptProgress" && event.background === true) {
      // A saved view's reading in the background (ADR 0117, rule 3) is no run of ours: its
      // verdicts show in the list of the same prompt, read at most once per `progressReadMs`.
      if (!has() || count()?.promptKey !== event.promptKey) return;
      // The line shows it as it goes, with no key pressed (rule 3a).
      setBackground(event.finished ? null : shownOf(event));
      if (run !== null) return;
      if (rows() === null && count()?.searched !== true) return;
      if (cancelProgressRead === null) {
        cancelProgressRead = schedule(() => {
          cancelProgressRead = null;
          void readVerdicts();
        }, progressReadMs);
      }
    } else if (event.type === "agentPromptProgress") {
      const mine = run;
      if (mine === null || mine.gen !== gen) return;
      if (mine.key === null) {
        // Only one prompt runs at a time: the start of a run while ours waits for its key is ours.
        if (event.finished || event.done !== 0) return;
        mine.key = event.promptKey;
      } else if (event.promptKey !== mine.key) return;
      if (!event.finished) {
        const { view: _view, ...shown } = shownOf(event);
        setProgress(shown);
      }
      // A batch that returned adds rows; a query that ran adds none. While reading, at most once
      // per `progressReadMs`, so a long run costs reads by the second and not by the batch.
      if (event.finished || progressReadMs === 0) {
        cancelProgressRead?.();
        cancelProgressRead = null;
        if (event.phase === "reading" || event.finished) void readVerdicts();
      } else if (event.phase === "reading" && cancelProgressRead === null) {
        cancelProgressRead = schedule(() => {
          cancelProgressRead = null;
          void readVerdicts();
        }, progressReadMs);
      }
    } else if (event.type === "changes") {
      // Mail moved under rows that are shown: which still fit is read again after a quiet moment.
      if (rows() === null || run !== null) return;
      cancelChanges?.();
      cancelChanges = schedule(() => {
        cancelChanges = null;
        void readVerdicts();
      }, changesQuietMs);
    }
  });

  return {
    /** The text these signals are about. */
    text,
    /** That text holds a prompt, with AI on. */
    has,
    count,
    rows,
    /** A run of this text is going on: searching, or threads read of those it set out to read. */
    progress,
    stopping,
    /** What the last run ended with, when that needs saying. */
    outcome,
    /** This prompt read in the background now, as its events tell it (ADR 0117, rule 3a). */
    background,
    /** A view was opened and its kept rows are on their way: an empty list is not yet an answer. */
    opening,
    /** The text is a saved view's, opened as one. */
    isView: () => viewShown(),
    setQuery,
    /** `↵`: once the count is known the person has seen it, so it reads everything (rule 4). */
    run: () => {
      const c = count();
      return start(false, c !== null && c.ai === "on" && c.searched);
    },
    /** `Search again` (rule 4): the kept search is replaced by a new one, then what it finds is read. */
    searchAgain: () => start(true),
    stop,
    open,
    dispose() {
      off();
      cancelCount?.();
      cancelChanges?.();
      cancelProgressRead?.();
    },
  };
}

export type PromptRunStore = ReturnType<typeof createPromptRun>;
