/**
 * A prompt is a filter (ADR 0116): the person's own question in the query bar. A run searches for
 * its own candidates, and the agent judges them thread by thread. A verdict is kept per prompt,
 * thread and last message, and the searches per prompt and mail filters, so a saved view that
 * holds a prompt reads only what is new.
 */
import type { Message } from "./entities.ts";

/** Bumped when the instructions or the schema change what a verdict means; older ones go unread. */
export const PROMPT_VERSION = 2;
/**
 * Starting value (rule 4): above this many threads to read, the reading waits for one more `↵`.
 * A question, not a cap: after that `↵` everything found is read.
 */
export const PROMPT_ASK_ABOVE = 200;
/** The lowest fit the list shows (rule 7): a fit of 1 is kept and not shown. */
export const PROMPT_SHOWN_FIT = 2;
/** Starting value: verdicts of a prompt that no saved view holds go after this (rule 12). */
export const PROMPT_KEEP_DAYS = 30;

/** 0 does not fit, 3 fits strongly (rule 6). */
export type PromptFit = 0 | 1 | 2 | 3;

/** What the agent said about one thread for one prompt, as the code accepted it (rule 6). */
export interface PromptVerdict {
  readonly promptKey: string;
  readonly threadId: string;
  /** The thread as it stood: a new message makes the verdict stale (rule 5). */
  readonly lastMessageKey: number;
  readonly version: number;
  /** Above 0 only with a quote found in the message it names. */
  readonly fit: PromptFit;
  /** The model's own sentence (rule 6): shown in the agent's colour, never as a fact. */
  readonly why: string;
  /** The passage that shows the fit, with the key of the message that holds it. */
  readonly quote?: { readonly text: string; readonly messageKey: number };
  readonly atMs: number;
}

/**
 * Local facts that go with a thread (rule 8): counts and flags, no address. The History line of
 * ADR 0066, rule 1 goes with the thread itself.
 */
export interface PromptSignals {
  readonly unread: boolean;
  readonly starred: boolean;
  /** The person answered a message of the thread. */
  readonly answered: boolean;
  readonly messages: number;
}

/**
 * What the search of a prompt left (rule 4): the queries it wrote and the threads it named, kept
 * under the prompt and the query's mail filters. Coming back runs the queries again here, with no
 * model; `Search again` replaces it. Thread ids and queries, never mail text.
 */
export interface PromptSearch {
  readonly promptKey: string;
  /** The query's mail filters as text, white space folded: everything but the prompt. */
  readonly filters: string;
  /** The valid queries the search ran, in order. */
  readonly queries: readonly string[];
  /** The threads the search named, best first: they stay candidates while the filters match. */
  readonly threadIds: readonly string[];
  readonly atMs: number;
  /**
   * No search ran: the mail filters alone matched at most `PROMPT_ASK_ABOVE` threads, so the
   * candidates are everything they match (rule 4). `queries` and `threadIds` are empty.
   */
  readonly whole?: true;
  /**
   * When the prompt last read what this search finds (ADR 0117, rule 3): a run that read all it
   * set out to, or a reading in the background that read every new thread. The background reads
   * only mail newer than this. Absent: `atMs`.
   */
  readonly readAtMs?: number;
}

/**
 * The number on the tab of a view with a prompt (ADR 0117, rule 4): unread threads among those
 * it shows, from stored verdicts, no model. `unread` is null for a view never read (no kept
 * search): it shows no number. `ai` is `off` while AI is off or no account has consent.
 */
export interface PromptBadge {
  readonly ai: "on" | "off";
  readonly unread: number | null;
}

/** What a run of a prompt is doing now (rule 9). */
export type PromptPhase = "searching" | "reading";

/** A run of a prompt going on: its phase, and threads read of those it set out to read. */
export interface PromptRunning {
  readonly phase: PromptPhase;
  readonly done: number;
  readonly total: number;
}

/**
 * The prompt of a query as the agent sees it (rule 4). `ai` is `off` while AI is off or no account
 * has consent (rule 11): then nothing else is counted, and the list shows the mail filters' result.
 * Before the first search nothing is known of the mail: `searched` is false and the counts are 0.
 */
export interface PromptCount {
  readonly ai: "on" | "off";
  /** The hash of the prompt with white space folded (rule 5). Empty while AI is off. */
  readonly promptKey: string;
  /** The search of this prompt with these mail filters has run, and what it wrote is kept. */
  readonly searched: boolean;
  /** Threads the kept search finds now, all of them (rule 4): no cap of ours. */
  readonly found: number;
  /**
   * The person's `limit:` (rule 4a): the candidates are read in the order of `sort:` until this
   * many fit, and only those are listed. Absent: no limit.
   */
  readonly limit?: number;
  /**
   * Of them, the threads that already have a verdict for their last message; under a limit, those
   * up to the last thread that fits once the limit is reached.
   */
  readonly read: number;
  /** Of those read, the threads that fit enough to show (rule 7); at most the limit. */
  readonly fits: number;
  /**
   * Threads a run would read now (rule 4a). Without a limit, every one found with no verdict;
   * under one, at most that, as the run stops once the limit's worth fit. 0: nothing to read.
   * Absent (older answers): found less read.
   */
  readonly toRead?: number;
  /** The limit is reached (rule 4a): that many fit and nothing before them is unread. */
  readonly reached?: true;
  /** The kept "search" is the mail filters' whole match: no search ran, so none to run again. */
  readonly whole?: true;
  /** A run of this prompt is going on (rule 9). */
  readonly running?: PromptRunning;
}

/** A thread the prompt kept (rule 7): the newest message the list shows, and its verdict. */
export interface PromptRow {
  readonly threadId: string;
  /** The newest message of the thread outside Trash and Spam, as the lists show it. */
  readonly message: Message;
  /** How many messages of the thread are unread. */
  readonly unread: number;
  /** 2 or 3: a fit of 1 is not shown (rule 7). */
  readonly fit: 2 | 3;
  readonly why: string;
  readonly quote?: { readonly text: string; readonly messageKey: number };
}

/**
 * What the list under a prompt shows (rule 7): fit 2 or 3, in the order of `sort:` (rule 4b);
 * by default the highest first, newest among equals.
 */
export interface PromptList extends PromptCount {
  readonly rows: readonly PromptRow[];
}

/** A run that ended: the list as it stands, and why it ended early, if it did. */
export interface PromptRunResult extends PromptList {
  /**
   * The person pressed Stop. In the search nothing is kept; in the reading the batches that
   * finished are kept (rule 9).
   */
  readonly stopped: boolean;
  /** A fixed sentence when the run could not go on (the plan, the runtime); no mail text. */
  readonly problem?: string;
  /** Batches whose answer the code did not accept; their threads stay unread. */
  readonly rejected: number;
  /**
   * The reading did not start: more than `PROMPT_ASK_ABOVE` threads are left to read, and the run
   * was not asked to read them all (rule 4). The next `↵` asks with `readAll`.
   */
  readonly ask?: true;
}

/** A query the search ran, as the tool or the trail reported it: a fact, not the model's words. */
export interface PromptStep {
  readonly query: string;
  readonly threads: number;
}

/** How far a run is, pushed to the window as it goes (rule 9). Not stored. */
export interface PromptProgress {
  readonly promptKey: string;
  readonly phase: PromptPhase;
  /** Reading: threads the run has read so far (sent and answered), of those it set out to read. */
  readonly done: number;
  readonly total: number;
  /** Searching: the last query that ran and how many threads it listed. */
  readonly step?: PromptStep;
  /** Reading under a limit (rule 4a): the threads that fit so far, of the limit. */
  readonly fits?: number;
  /** The run ended (done, stopped or failed). */
  readonly finished: boolean;
  /**
   * A reading in the background for a saved view (ADR 0117, rule 3), not a run a window asked
   * for: no window shows its progress, but verdicts came, so lists and badges are read again.
   */
  readonly background?: true;
  /**
   * In the background: the saved view read, so a window can name it (ADR 0117, rule 3a), with
   * what was read of it when this pass started and what there was to read in all then:
   * `read + done` of `total` is how far the view is.
   */
  readonly view?: {
    readonly id: string;
    readonly name: string;
    readonly read: number;
    readonly total: number;
  };
  /** The runtime that reads, by name: `Ollama`, `Codex`. */
  readonly runtime?: string;
  /** The runtime runs on this Mac: a slow turn is the model's, on this machine. */
  readonly local?: true;
  /**
   * Reading: the threads sent and not answered yet, and when the first of those turns went (the
   * backend's clock). Absent: no turn is out. The count above moves only when a turn answers.
   */
  readonly inFlight?: { readonly threads: number; readonly sinceMs: number };
  /** Reading: turns that answered so far, and when the first turn went: the pace, measured. */
  readonly answered?: { readonly turns: number; readonly sinceMs: number };
  /**
   * The run waits before it reads: for the turns a reading in the background already sent
   * (`background`), or for the runtime's last gates, its check and its plan (`gate`).
   */
  readonly waiting?: "background" | "gate";
}

/**
 * Why the reading in the background does not read now (ADR 0117, rule 3a). From the gates a pass
 * met, never guessed: the person's pause, the plan's gate for background work at the priority it
 * was refused at (`plan`, with the window that said no), a limit the runtime named, the runtime's
 * state, consent, or a turn that failed.
 */
export type ReadingWait =
  | { readonly kind: "pausedByPerson" }
  | {
      readonly kind: "plan";
      readonly reason: "sessionLimit" | "weekLimit" | "overage" | "budget";
      readonly untilMs?: number;
      /** The plan's windows are not known yet: older mail waits for a turn that shows them. */
      readonly unknown?: true;
    }
  | { readonly kind: "limit"; readonly untilMs?: number }
  | { readonly kind: "checking" }
  | { readonly kind: "signedOut" }
  | { readonly kind: "notPlan" }
  | { readonly kind: "runtime"; readonly problem?: string }
  | { readonly kind: "consent" }
  /** A pass is about to start: the debounce after a sync, or a run of the person's that ended. */
  | { readonly kind: "soon" }
  | { readonly kind: "failed"; readonly problem: string };

/** One saved view with a prompt, as the reading in the background stands for it (rule 3a). */
export interface ReadingView {
  readonly viewId: string;
  readonly name: string;
  readonly promptKey: string;
  /** What its kept search finds now, how many of those have a verdict, how many a run would read. */
  readonly found: number;
  readonly read: number;
  readonly toRead: number;
  /**
   * - `reading`: a pass reads it now (`done` of `total` of this pass).
   * - `waiting`: threads are left and nothing reads them; `wait` says why.
   * - `upToDate`: nothing is left to read.
   * - `notRun`: never searched; it is read only after the person runs it once.
   * - `left`: what is left was sent twice and came back with nothing; it waits until it changes.
   */
  readonly state: "reading" | "waiting" | "upToDate" | "notRun" | "left";
  readonly done?: number;
  readonly total?: number;
  readonly wait?: ReadingWait;
  /** Of `toRead`, the threads tried twice with nothing back. */
  readonly left?: number;
}

/** The reading in the background as a window shows it (ADR 0117, rule 3a). No model is asked. */
export interface ReadingStatus {
  readonly ai: "on" | "off";
  /** The runtime for understanding mail, by name; empty when there is none. */
  readonly runtime: string;
  /** The person's `Pause reading`. */
  readonly paused: boolean;
  /** Why nothing reads now, when nothing does; absent while a pass reads or nothing is left. */
  readonly wait?: ReadingWait;
  readonly views: readonly ReadingView[];
}
