// The ADR 0012 budgets, checked by `MATTERS_SMOKE=1` (one phase; tools/smoke-desktop.ts runs two).

export interface SmokeReport {
  /** Wall-clock epoch of the frame in which the first list rows were painted. */
  readonly firstRowsEpochMs?: number;
  readonly samples?: readonly { query: string; results: number; workMs: number; frameMs: number }[];
  /** ADR 0076: ⌘K, and the live Threads in the search panel while typing. */
  readonly livePanel?: {
    readonly cmdKFocuses: boolean;
    readonly keyLabelIdle: string;
    readonly keyLabelFocused: string;
    readonly samples: readonly {
      query: string;
      threads: number;
      workMs: number;
      frameMs: number;
    }[];
    readonly burstShowsLast: boolean;
    readonly askHidden: boolean;
    readonly footer: string;
    readonly escCloses: boolean;
  };
  /** ADR 0077: marks in the list and the reader for a search, and ⌘G through the matches. */
  readonly hits?: {
    readonly listMarks: number;
    readonly readerMarks: number;
    readonly stops: number;
    readonly countText: string;
    readonly currentIndexes: readonly number[];
    readonly wrapped: boolean;
    readonly plainBodiesUntouched: boolean;
    readonly expandedCollapsed: boolean;
  };
  /** Selection -> body painted, one entry per opened thread. */
  readonly openSamples?: readonly {
    threadId: string;
    bodyChars: number;
    workMs: number;
    frameMs: number;
  }[];
  /** ADR 0039: `u` -> the row and the thread show the new state, in one frame. */
  readonly markRead?: {
    readonly frameMs: readonly number[];
    readonly letterNodesKept: boolean;
    readonly stayedRead: boolean;
    readonly unreadAgain: boolean;
  };
  /**
   * ADR 0078 as ADR 0099 left it: avatars in every row, and each open letter's own header (the
   * 28 px avatar of the thread's grid, ADR 0073) after the subject.
   */
  readonly senderHead?: {
    readonly rows: number;
    readonly rowsWithAvatar: number;
    readonly headPresent: boolean;
    readonly avatarSize: number;
    readonly avatarLetters: string;
    readonly name: string;
    readonly afterSubject: boolean;
    readonly lineText: string;
    readonly lineHeightStable: boolean;
  };
  /** ADR 0044: `e` -> the thread's rows are gone, the next is selected and the tray has its line. */
  readonly archive?: {
    readonly frameMs: readonly number[];
    readonly lineShown: boolean;
    readonly selectedNext: boolean;
    readonly restored: boolean;
  };
  /** The composer scenario of ADR 0020: keystroke -> preview frame painted. */
  readonly composer?: {
    readonly samples: readonly { workMs: number; frameMs: number }[];
    readonly quoted: boolean;
    readonly quoteDetail?: string;
    readonly styled: boolean;
    readonly polish: boolean;
    readonly closed: boolean;
    /** The first `r` of the run -> the editor is on screen (ADR 0046, rule 3). */
    readonly openMs?: number;
  };
  /**
   * ADR 0041: files dragged over the window, and 120 MB of pasted images through grants and the
   * attachment worker. The upload to a test server is not part of it (see tools/smoke-desktop.ts).
   */
  readonly attach?: {
    readonly overlay: {
      readonly hiddenAtRest: boolean;
      readonly classOn: boolean;
      readonly overlayShown: boolean;
      readonly framesInert: boolean;
      readonly dragoverMutations: number;
      readonly stillOver: boolean;
      readonly cleared: boolean;
      readonly textIgnored: boolean;
      readonly escaped: boolean;
    };
    readonly pastedBytes: number;
    /** Chips in the page when `pasteImages` returned its promise: before anything was awaited. */
    readonly chipsAtOnce: number;
    readonly chipFrameMs: number;
    readonly grantedMs: number;
    readonly copyMs?: number;
    readonly allReady: boolean;
    /** The rows' states once the copies ended. */
    readonly states: readonly string[];
    readonly reasons: readonly string[];
    readonly keyFrameMs: readonly number[];
    readonly keysDuringCopy: number;
  };
  /** Another row of the open thread goes to its letter: opened and in view. */
  readonly rowToLetter?: {
    readonly found: boolean;
    readonly startedHidden: boolean;
    readonly opened: boolean;
    readonly inView: boolean;
  };
  /** The agent's column widened over the window (⇧⌘E). */
  readonly widePane?: {
    readonly opened: boolean;
    readonly strip: number;
    readonly toRightEdge: boolean;
    readonly readerKept: boolean;
    readonly escNarrows: boolean;
    readonly stripNarrows: boolean;
  };
  /** The list's edge (ADR 0038): frame to frame while dragged over a large HTML message. */
  readonly listDivider?: {
    readonly frameMs: readonly number[];
    readonly followed: boolean;
    readonly refitted: boolean;
    readonly keyStepped: boolean;
    readonly keyReset: boolean;
    readonly keptKeys: boolean;
  };
  /**
   * AI on with the demo runtime: the starter view (ADR 0117, rule 2), a draft on request in an
   * ordinary thread (ADR 0063), a closing from the talk (ADR 0054) and Pause reading (rule 3).
   */
  readonly agent?: {
    readonly enabled: boolean;
    readonly starterPresent: boolean;
    readonly starterFirst: boolean;
    readonly starterOpenedByItself: boolean;
    readonly starterOpens: boolean;
    readonly tabFrameMs: readonly number[];
    readonly draftOpened: boolean;
    readonly sheetShown: boolean;
    readonly sendShown: boolean;
    readonly statusLineShown: boolean;
    readonly statusLineHasNoInput: boolean;
    readonly editOpenedComposer: boolean;
    readonly closedInOwnWords: boolean;
    readonly ruleOffered: boolean;
    readonly closedUndone: boolean;
    readonly journalRecorded: boolean;
    readonly remembered: boolean;
    readonly pauseHeld: boolean;
    readonly continueWorked: boolean;
    readonly choiceKeepsItsValue: boolean;
    /** Settings › Agents shows a runtime, a model and an effort per kind of work (ADR 0121). */
    readonly settingsKinds: boolean;
    readonly settingsDetail: string;
    readonly detail: string;
  };
  /** ADR 0116: a prompt counted, run with ↵, and its rows in its order with a reason. */
  readonly prompt?: {
    readonly lineShown: string;
    readonly ran: boolean;
    readonly rows: number;
    readonly inOrder: boolean;
    readonly whyShown: boolean;
    readonly noHeadings: boolean;
    readonly backToFilters: boolean;
    /** ADR 0116, rule 4b: the same prompt by date shows what fits by date, with a heading. */
    readonly datedHeadings: boolean;
    /** Without a prompt, `sort:relevance` is ranked after ↵, with no headings. */
    readonly relevanceSorted: boolean;
    readonly detail: string;
  };
  /** ADR 0117, rule 3a: the reading in the background shows in the foot row, the tab and a popover. */
  readonly reading?: {
    readonly tabRing: boolean;
    readonly footWhileRun: string;
    readonly footWaiting: string;
    readonly popoverListed: boolean;
    readonly escapeReturned: boolean;
    readonly footReading: string;
    readonly readToEnd: boolean;
    readonly detail: string;
  };
  /** Turning AI off left the starter view: it is the person's (ADR 0117, rule 2). */
  readonly starterKeptAfterOff?: boolean;
  /**
   * The backend process's memory (KB) around the attachment scenario, sampled by main. There is no
   * Sent copy in it, so every byte of growth is the copies' doing.
   */
  readonly backendMemory?: ReadonlyMap<
    string,
    { readonly startKB: number; readonly peakKB: number; readonly endKB: number }
  >;
  readonly cspViolations?: readonly string[];
  readonly mailWallProblems?: readonly string[];
  readonly error?: string;
}

export type SmokePhase = "cold" | "warm";

/** stdout line that carries the result of one phase. */
export const SMOKE_PREFIX = "MATTERS_SMOKE_RESULT ";
/** stdout line with which the page asks the driver to do something, e.g. deliver mail. */
export const SMOKE_SIGNAL_PREFIX = "MATTERS_SMOKE_SIGNAL ";

/**
 * Measured from `Date.now() - process.uptime()`, so it leaves out the ~75 ms before Node starts
 * (tools/bench-launch.ts measures from outside). ADR 0046: 201 ms here, ~265 ms from the spawn.
 */
const BUDGET_LAUNCH_MS = 320;
const BUDGET_SEARCH_MS = 16;
const BUDGET_OPEN_THREAD_MS = 50;
const BUDGET_PREVIEW_MS = 50;
/** First `r` of a run -> the editor is there, with the editor loaded on demand (ADR 0046). */
const BUDGET_COMPOSER_OPEN_MS = 150;
const BUDGET_MARK_READ_MS = 16;
const BUDGET_ARCHIVE_MS = 16;
const MIN_PREVIEW_SAMPLES = 20;
/** A drag keeps up with a 60 Hz display, with some room for the timer's jitter. */
const BUDGET_DIVIDER_FRAME_MS = 20;
/** A chip is on screen in the frame of the drop; one frame, with the timer's jitter. */
const BUDGET_CHIP_FRAME_MS = 20;
/** `j` / `k` stay a frame while 120 MB is copied. */
const BUDGET_KEY_FRAME_MS = 16;
const MIN_KEY_SAMPLES = 10;
/** A switch between tabs stays a frame (ADR 0012). */
const BUDGET_TAB_FRAME_MS = 16;
/** The backend holds streams, not files: 120 MB attached may not grow it by more than this. */
const BUDGET_BACKEND_GROWTH_MB = 16;

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return Math.round(value * 100) / 100;
}

interface Sample {
  readonly workMs: number;
  readonly frameMs: number;
  readonly duringSync: boolean;
}

/** What the page measured while an account was syncing (renderer/smoke.ts `runSyncSmoke`). */
export interface SyncSmokeReport {
  readonly samples?: readonly (Sample & { query: string; results: number })[];
  readonly openSamples?: readonly (Sample & { threadId: string; bodyChars: number })[];
  /** Mail delivered while the app runs: did the list follow without moving the reader's place? */
  readonly live?: {
    readonly visibleMs?: number;
    readonly selectionKept: boolean;
    readonly offsetDriftPx: number;
    readonly scrollShiftRows: number;
    readonly expectedShiftRows: number;
  };
  readonly syncedBeforeMeasuring?: boolean;
  readonly cspViolations?: readonly string[];
  readonly error?: string;
}

const MIN_SYNC_SAMPLES = 40;

// The router answers reads while the sync worker writes (ADR 0019): during a sync, the work of
// one request stays inside a frame and the typical search stays far below it.
const BUDGET_SYNC_SEARCH_WORK_MEDIAN_MS = 5;
const BUDGET_SYNC_WORK_MAX_MS = 16;

function percentile(xs: readonly number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const at = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  return Math.round((at ?? 0) * 100) / 100;
}

function spread(xs: readonly number[]) {
  return { median: median(xs), p95: percentile(xs, 0.95), max: percentile(xs, 1) };
}

/** ADR 0012 budgets, held while the initial sync of a large mailbox runs. */
export function runSyncSmoke(report: SyncSmokeReport) {
  const failures: string[] = [];
  if (report.error) failures.push(`renderer error: ${report.error}`);
  if (report.syncedBeforeMeasuring) failures.push("the sync finished before measuring began");

  const samples = (report.samples ?? []).filter((s) => s.duringSync);
  const openSamples = (report.openSamples ?? []).filter((s) => s.duringSync);
  if (samples.length < MIN_SYNC_SAMPLES) {
    failures.push(`only ${samples.length} search samples were taken during the sync`);
  }
  if (openSamples.length < MIN_SYNC_SAMPLES) {
    failures.push(`only ${openSamples.length} open-thread samples were taken during the sync`);
  }
  const search = {
    work: spread(samples.map((s) => s.workMs)),
    frame: spread(samples.map((s) => s.frameMs)),
  };
  const open = {
    work: spread(openSamples.map((s) => s.workMs)),
    frame: spread(openSamples.map((s) => s.frameMs)),
  };
  if (samples.length > 0) {
    if (search.frame.median >= BUDGET_SEARCH_MS) {
      failures.push(`search frame median ${search.frame.median} ms exceeds ${BUDGET_SEARCH_MS} ms`);
    }
    if (search.work.median >= BUDGET_SYNC_SEARCH_WORK_MEDIAN_MS) {
      failures.push(
        `search work median ${search.work.median} ms exceeds ${BUDGET_SYNC_SEARCH_WORK_MEDIAN_MS} ms`,
      );
    }
    if (search.work.max >= BUDGET_SYNC_WORK_MAX_MS) {
      failures.push(`search work max ${search.work.max} ms exceeds ${BUDGET_SYNC_WORK_MAX_MS} ms`);
    }
  }
  if (openSamples.length > 0) {
    if (open.frame.median >= BUDGET_OPEN_THREAD_MS) {
      failures.push(
        `open thread frame median ${open.frame.median} ms exceeds ${BUDGET_OPEN_THREAD_MS} ms`,
      );
    }
    if (open.work.max >= BUDGET_SYNC_WORK_MAX_MS) {
      failures.push(
        `open thread work max ${open.work.max} ms exceeds ${BUDGET_SYNC_WORK_MAX_MS} ms`,
      );
    }
  }
  if (samples.some((s) => s.results === 0)) failures.push("a sample query returned no results");
  if (openSamples.some((s) => s.bodyChars === 0)) failures.push("an opened thread showed no body");

  const live = report.live;
  if (!live) failures.push("the live-mail check did not run");
  else {
    if (live.visibleMs === undefined) failures.push("mail delivered during the run never appeared");
    if (!live.selectionKept) failures.push("the selection moved when new mail arrived");
    if (Math.abs(live.offsetDriftPx) > 1.5) {
      failures.push(`the list jumped ${live.offsetDriftPx} px when new mail arrived`);
    }
    if (live.scrollShiftRows !== live.expectedShiftRows) {
      failures.push(
        `the list scrolled ${live.scrollShiftRows} rows for ${live.expectedShiftRows} new messages`,
      );
    }
  }
  const csp = report.cspViolations ?? [];
  if (csp.length > 0) failures.push(`CSP violations: ${csp.join("; ")}`);

  return {
    ok: failures.length === 0,
    output: {
      ok: failures.length === 0,
      mode: "sync",
      search,
      openThread: open,
      samplesDuringSync: { search: samples.length, openThread: openSamples.length },
      budgets: {
        searchPerKeystrokeMs: BUDGET_SEARCH_MS,
        searchWorkMedianMs: BUDGET_SYNC_SEARCH_WORK_MEDIAN_MS,
        workMaxMs: BUDGET_SYNC_WORK_MAX_MS,
        openThreadMs: BUDGET_OPEN_THREAD_MS,
      },
      live,
      samples: report.samples,
      openSamples: report.openSamples,
      cspViolations: csp,
      failures,
    },
  };
}

export function runSmoke(report: SmokeReport, processStartEpochMs: number, phase: SmokePhase) {
  const failures: string[] = [];
  if (report.error) failures.push(`renderer error: ${report.error}`);

  const launchToRowsMs =
    report.firstRowsEpochMs === undefined
      ? undefined
      : Math.round(report.firstRowsEpochMs - processStartEpochMs);
  if (launchToRowsMs === undefined) failures.push("rows were never painted");
  // A cold start seeds the database first; it is reported, only the warm start is budgeted.
  else if (phase === "warm" && launchToRowsMs >= BUDGET_LAUNCH_MS) {
    failures.push(`launch -> list ${launchToRowsMs} ms exceeds ${BUDGET_LAUNCH_MS} ms`);
  }

  const samples = report.samples ?? [];
  if (samples.length === 0) failures.push("no search samples");
  const searchFrameMedianMs = median(samples.map((s) => s.frameMs));
  const searchWorkMedianMs = median(samples.map((s) => s.workMs));
  if (samples.length > 0 && searchFrameMedianMs >= BUDGET_SEARCH_MS) {
    failures.push(`search median ${searchFrameMedianMs} ms exceeds ${BUDGET_SEARCH_MS} ms`);
  }
  if (samples.some((s) => s.results === 0)) failures.push("a sample query returned no results");

  const live = report.livePanel;
  const liveSamples = live?.samples ?? [];
  const liveFrameMedianMs = median(liveSamples.map((s) => s.frameMs));
  const liveWorkMedianMs = median(liveSamples.map((s) => s.workMs));
  if (!live) failures.push("the live search panel scenario did not run");
  else {
    if (!live.cmdKFocuses) failures.push("⌘K did not put the cursor in the search bar");
    if (live.keyLabelFocused !== "esc") failures.push("the bar's key did not say esc when focused");
    if (liveSamples.some((s) => s.threads === 0)) failures.push("the live panel showed no threads");
    if (liveSamples.length > 0 && liveFrameMedianMs >= BUDGET_SEARCH_MS) {
      failures.push(`live panel median ${liveFrameMedianMs} ms exceeds ${BUDGET_SEARCH_MS} ms`);
    }
    if (!live.burstShowsLast)
      failures.push("a burst of keys did not end on the last text's answer");
    if (!live.askHidden) failures.push("the panel offered to ask the agent while AI was off");
    if (!live.footer.includes("↵ open")) failures.push("the live panel had no footer of keys");
    if (!live.escCloses) failures.push("Escape did not close the panel");
  }

  const hits = report.hits;
  if (!hits) failures.push("the search marks scenario did not run");
  else {
    if (hits.listMarks === 0) failures.push("the list marked no word of the search");
    if (hits.readerMarks === 0) failures.push("the reader marked no word of the search");
    if (hits.stops === 0) failures.push("no thread among the first results had a match to step to");
    else if (hits.currentIndexes[0] !== 0 || hits.currentIndexes[1] === hits.currentIndexes[0]) {
      if (hits.stops > 1)
        failures.push(`⌘G did not move the current match: ${hits.currentIndexes}`);
    }
    if (hits.stops > 0 && hits.currentIndexes.some((i) => i < 0)) {
      failures.push("⌘G did not mark a current match");
    }
    if (!hits.plainBodiesUntouched) failures.push("marks stayed after the search was cleared");
  }

  const head = report.senderHead;
  if (!head) failures.push("the sender header scenario did not run");
  else {
    if (head.rows === 0 || head.rowsWithAvatar !== head.rows) {
      failures.push(`${head.rows - head.rowsWithAvatar} of ${head.rows} list rows had no avatar`);
    }
    if (!head.headPresent) failures.push("an opened thread had no sender header");
    else {
      // ADR 0099: no 48 px sender block on top any more; the letter's avatar sits in the 28 px
      // lead column of the thread's grid (ADR 0073).
      if (head.avatarSize !== 28)
        failures.push(`the letter's header avatar was ${head.avatarSize} px, not 28`);
      if (head.avatarLetters === "") failures.push("the header avatar had no letters");
      if (head.name === "") failures.push("the header showed no sender name");
      if (!head.afterSubject) failures.push("the letter's header did not come after the subject");
      if (!head.lineHeightStable)
        failures.push("the header's second line changed height or was empty");
    }
  }

  const openSamples = report.openSamples ?? [];
  if (openSamples.length === 0) failures.push("no open-thread samples");
  const openFrameMedianMs = median(openSamples.map((s) => s.frameMs));
  const openWorkMedianMs = median(openSamples.map((s) => s.workMs));
  if (openSamples.length > 0 && openFrameMedianMs >= BUDGET_OPEN_THREAD_MS) {
    failures.push(`open thread median ${openFrameMedianMs} ms exceeds ${BUDGET_OPEN_THREAD_MS} ms`);
  }
  if (openSamples.some((s) => s.bodyChars === 0)) failures.push("an opened thread showed no body");

  const mark = report.markRead;
  const markReadFrameMedianMs = median(mark?.frameMs ?? []);
  if (!mark) failures.push("the mark-read scenario did not run");
  else {
    if (markReadFrameMedianMs >= BUDGET_MARK_READ_MS) {
      failures.push(
        `mark read median ${markReadFrameMedianMs} ms exceeds ${BUDGET_MARK_READ_MS} ms`,
      );
    }
    if (!mark.letterNodesKept) failures.push("marking read reloaded or folded the open thread");
    if (!mark.stayedRead) failures.push("a message marked read showed as unread again");
    if (!mark.unreadAgain) failures.push("u on a read row did not mark that message unread");
  }

  const archive = report.archive;
  const archiveFrameMedianMs = median(archive?.frameMs ?? []);
  if (!archive) failures.push("the archive scenario did not run");
  else {
    if (archiveFrameMedianMs >= BUDGET_ARCHIVE_MS) {
      failures.push(`archive median ${archiveFrameMedianMs} ms exceeds ${BUDGET_ARCHIVE_MS} ms`);
    }
    if (!archive.selectedNext) failures.push("e did not take the thread out of the list at once");
    if (!archive.lineShown) failures.push("the tray had no line for the archived thread");
    if (!archive.restored) failures.push("⌘Z did not bring the archived thread back");
  }

  const composer = report.composer;
  const previewSamples = composer?.samples ?? [];
  const previewFrameMedianMs = median(previewSamples.map((s) => s.frameMs));
  const previewWorkMedianMs = median(previewSamples.map((s) => s.workMs));
  if (!composer) failures.push("the composer scenario did not run");
  else {
    if (previewSamples.length < MIN_PREVIEW_SAMPLES) {
      failures.push(`only ${previewSamples.length} preview samples were taken`);
    } else if (previewFrameMedianMs >= BUDGET_PREVIEW_MS) {
      failures.push(
        `keystroke -> preview median ${previewFrameMedianMs} ms exceeds ${BUDGET_PREVIEW_MS} ms`,
      );
    }
    if (composer.openMs === undefined || composer.openMs >= BUDGET_COMPOSER_OPEN_MS) {
      failures.push(
        `first reply -> editor ${composer.openMs} ms exceeds ${BUDGET_COMPOSER_OPEN_MS} ms`,
      );
    }
    if (!composer.quoted) {
      failures.push(`the reply did not quote the message (${composer.quoteDetail ?? ""})`);
    }
    if (!composer.styled) failures.push("the preview lost its inline styles");
    if (!composer.polish) failures.push("Polish text did not reach the preview");
    if (!composer.closed) failures.push("Escape did not close the composer");
  }

  const rowToLetter = report.rowToLetter;
  if (!rowToLetter) failures.push("the row-to-letter scenario did not run");
  else if (!rowToLetter.found)
    failures.push("no read letter of a thread that started folded or out of sight");
  else {
    if (!rowToLetter.opened)
      failures.push("picking a row of the open thread did not open its letter");
    if (!rowToLetter.inView) failures.push("picking a row of the open thread did not scroll to it");
  }

  const wide = report.widePane;
  if (!wide) failures.push("the widened agent scenario did not run");
  else if (!wide.opened) {
    const seen = (wide as { seen?: string }).seen ?? "";
    failures.push(`⇧⌘E did not widen the agent's column ${seen}`.trim());
  } else {
    if (wide.strip !== 54)
      failures.push(`the widened agent left ${wide.strip} px of the list, not 54`);
    if (!wide.toRightEdge) failures.push("the widened agent did not reach the window's right edge");
    if (!wide.readerKept) failures.push("the reader moved under the widened agent");
    if (!wide.escNarrows) failures.push("Escape did not put the widened agent back at its side");
    if (!wide.stripNarrows) failures.push("a click in the list's strip did not put the agent back");
  }

  const divider = report.listDivider;
  const dividerFrameMedianMs = median(divider?.frameMs ?? []);
  if (!divider) failures.push("the list's edge scenario did not run");
  else {
    if (dividerFrameMedianMs >= BUDGET_DIVIDER_FRAME_MS) {
      failures.push(
        `list edge drag median ${dividerFrameMedianMs} ms exceeds ${BUDGET_DIVIDER_FRAME_MS} ms`,
      );
    }
    if (!divider.followed) failures.push("the list did not follow the drag");
    if (!divider.refitted) failures.push("the message was not fitted again after the drag");
    if (!divider.keyStepped) failures.push("an arrow key did not move the list's edge");
    if (!divider.keyReset) failures.push("Enter did not put the list back to its default");
    if (!divider.keptKeys) failures.push("the window's keys acted on a key the list's edge took");
  }

  const agent = report.agent;
  const tabFrameMedianMs = median(agent?.tabFrameMs ?? []);
  if (!agent) failures.push("the agent scenario did not run");
  else {
    if (agent.detail !== "") failures.push(`agent: ${agent.detail}`);
    if (!agent.enabled) failures.push("AI could not be turned on with the demo runtime");
    if (!agent.starterPresent) failures.push("the starter view Needs you did not appear");
    else {
      if (!agent.starterFirst) failures.push("Needs you was not in front of the other views");
      if (!agent.starterOpens) failures.push("opening Needs you did not show its prompt line");
      if (tabFrameMedianMs >= BUDGET_TAB_FRAME_MS) {
        failures.push(
          `switching tabs median ${tabFrameMedianMs} ms exceeds ${BUDGET_TAB_FRAME_MS} ms`,
        );
      }
    }
    if (!agent.draftOpened) failures.push("asking for a draft in a thread showed no agent frame");
    if (!agent.sheetShown) failures.push("the draft's sheet was empty or missing");
    if (!agent.sendShown) failures.push("the draft had no Send button");
    if (!agent.statusLineShown) failures.push("the status of the plans was missing");
    if (!agent.statusLineHasNoInput) failures.push("the status of the plans holds an input");
    if (!agent.editOpenedComposer) failures.push("Edit myself did not open the composer");
    if (!agent.closedInOwnWords) failures.push("the person's words did not close the thread");
    if (!agent.ruleOffered) failures.push("a closing did not offer a rule beside Undo");
    if (!agent.closedUndone) failures.push("Undo did not take the closing back");
    if (!agent.journalRecorded) {
      failures.push("the journal did not record the agent's closing with the person's words");
    }
    if (!agent.remembered) {
      failures.push("the agent did not keep an instruction from the person's words");
    }
    if (!agent.pauseHeld) failures.push("Pause reading did not hold");
    if (!agent.continueWorked) failures.push("Continue did not take the pause away");
    if (!agent.choiceKeepsItsValue) {
      failures.push("a settings select lost its value when a new status arrived");
    }
    if (!agent.settingsKinds) {
      failures.push(`Settings › Agents did not show each kind of work: ${agent.settingsDetail}`);
    }
  }
  const prompt = report.prompt;
  if (!prompt) failures.push("the prompt scenario did not run");
  else if (prompt.lineShown === "") {
    failures.push(`a prompt in the bar showed no count line (${prompt.detail})`);
  } else if (!prompt.ran) {
    failures.push(`↵ with a prompt did not show the prompt's rows (${prompt.detail})`);
  } else {
    if (!prompt.inOrder) failures.push("the prompt's rows were not in the order it gave");
    if (!prompt.whyShown) failures.push("a row the prompt kept did not show its reason");
    if (!prompt.noHeadings) failures.push("the list under a prompt showed headings");
    if (!prompt.backToFilters) {
      failures.push("changing the mail filters did not bring their result back");
    }
    if (!prompt.datedHeadings) {
      failures.push("a prompt under sort:newest did not show what fits by date");
    }
    if (!prompt.relevanceSorted) failures.push("sort:relevance did not rank the list after ↵");
  }
  const reading = report.reading;
  if (!reading) failures.push("the reading scenario did not run");
  else if (reading.detail !== "") failures.push(`the reading scenario: ${reading.detail}`);
  else {
    if (!reading.tabRing) failures.push("a view's tab showed no ring while its run read");
    if (!reading.footWhileRun.startsWith("Reading check")) {
      failures.push(`the foot row did not show the view's run (${reading.footWhileRun})`);
    }
    if (
      !reading.footWaiting.startsWith("Reading paused") ||
      !reading.footWaiting.includes("Reading check")
    ) {
      failures.push(`the foot row did not say why the reading waits (${reading.footWaiting})`);
    }
    if (!reading.popoverListed) failures.push("the reading popover did not list the view");
    if (!reading.escapeReturned) {
      failures.push("Escape did not close the reading popover and give the focus back");
    }
    if (!reading.readToEnd) failures.push("Continue reading did not read the view to its end");
  }
  if (report.starterKeptAfterOff !== true) {
    failures.push("turning AI off took the starter view away");
  }

  const attach = report.attach;
  const keyFrameMedianMs = median(attach?.keyFrameMs ?? []);
  if (!attach) failures.push("the attachment scenario did not run");
  else {
    const o = attach.overlay;
    if (!o.hiddenAtRest) failures.push("the drop overlay showed with no file over the window");
    if (!o.classOn) failures.push("dragging files over the window did not set the body class");
    if (!o.overlayShown) failures.push("the drop overlay did not show under the body class");
    if (!o.framesInert) failures.push("a frame still took the pointer while files were dragged");
    if (o.dragoverMutations !== 0) {
      failures.push(`dragover changed the page ${o.dragoverMutations} times`);
    }
    if (!o.stillOver) failures.push("leaving a child ended the drag (the counter is wrong)");
    if (!o.cleared) failures.push("leaving the window did not end the drag");
    if (!o.textIgnored) failures.push("a text drag showed the file overlay");
    if (!o.escaped) failures.push("Escape did not end the drag");
    if (attach.chipsAtOnce === 0) {
      failures.push(`${attach.chipsAtOnce} chips were in the page when the files were offered`);
    }
    if (attach.chipFrameMs >= BUDGET_CHIP_FRAME_MS) {
      failures.push(`chip frame ${attach.chipFrameMs} ms exceeds ${BUDGET_CHIP_FRAME_MS} ms`);
    }
    if (!attach.allReady) failures.push("the copies of the attached files never ended");
    if (attach.states.length !== attach.chipsAtOnce || attach.states.some((st) => st !== "ready")) {
      failures.push(
        `the copies ended as ${attach.states.join(", ")}: ${attach.reasons.join("; ")}`,
      );
    }
    if (attach.keysDuringCopy === 0) {
      failures.push("no j/k sample was taken while the files were being copied");
    }
    if (attach.keyFrameMs.length < MIN_KEY_SAMPLES) {
      failures.push(`only ${attach.keyFrameMs.length} j/k samples were taken`);
    } else if (keyFrameMedianMs >= BUDGET_KEY_FRAME_MS) {
      failures.push(
        `j/k median ${keyFrameMedianMs} ms exceeds ${BUDGET_KEY_FRAME_MS} ms while files were copied`,
      );
    }
  }

  // The first round warms the process up; the budget is for the second (renderer/smoke.ts).
  const growth = (label: string) => {
    const m = report.backendMemory?.get(label);
    return m ? Math.round((m.peakKB - m.startKB) / 1024) : undefined;
  };
  const backendGrowthMB = growth("round2");
  if (attach && backendGrowthMB === undefined) {
    failures.push("the backend's memory was not sampled during the attach");
  }
  if (backendGrowthMB !== undefined && backendGrowthMB > BUDGET_BACKEND_GROWTH_MB) {
    failures.push(
      `the backend grew ${backendGrowthMB} MB while 120 MB was attached again (budget ${BUDGET_BACKEND_GROWTH_MB} MB)`,
    );
  }

  failures.push(...(report.mailWallProblems ?? []));
  const csp = report.cspViolations ?? [];
  if (csp.length > 0) failures.push(`CSP violations: ${csp.join("; ")}`);

  return {
    ok: failures.length === 0,
    output: {
      ok: failures.length === 0,
      phase,
      markReadFrameMedianMs,
      archiveFrameMedianMs,
      dividerFrameMedianMs,
      agent: agent && {
        starterOpenedByItself: agent.starterOpenedByItself,
        tabFrameMedianMs,
        settings: agent.settingsDetail,
      },
      prompt,
      attach: attach && {
        pastedMB: Math.round(attach.pastedBytes / 1e6),
        chipFrameMs: attach.chipFrameMs,
        grantedMs: attach.grantedMs,
        copyMs: attach.copyMs,
        keyFrameMedianMs,
        keyFrameMaxMs: Math.max(0, ...attach.keyFrameMs),
        keysDuringCopy: attach.keysDuringCopy,
        backendGrowthMB,
        backendWarmupGrowthMB: growth("round1"),
        dragoverMutations: attach.overlay.dragoverMutations,
      },
      dividerFrameMaxMs: Math.max(0, ...(divider?.frameMs ?? [])),
      previewFrameMedianMs,
      previewWorkMedianMs,
      previewSampleCount: previewSamples.length,
      composerOpenMs: composer?.openMs,
      launchToRowsMs,
      searchFrameMedianMs,
      searchWorkMedianMs,
      livePanelFrameMedianMs: liveFrameMedianMs,
      livePanelWorkMedianMs: liveWorkMedianMs,
      livePanelSamples: liveSamples,
      hits: report.hits,
      senderHead: report.senderHead,
      openThreadFrameMedianMs: openFrameMedianMs,
      openThreadWorkMedianMs: openWorkMedianMs,
      budgets: {
        launchToRowsMs: phase === "warm" ? BUDGET_LAUNCH_MS : null,
        searchPerKeystrokeMs: BUDGET_SEARCH_MS,
        openThreadMs: BUDGET_OPEN_THREAD_MS,
        previewKeystrokeMs: BUDGET_PREVIEW_MS,
        composerOpenMs: BUDGET_COMPOSER_OPEN_MS,
        markReadMs: BUDGET_MARK_READ_MS,
        archiveMs: BUDGET_ARCHIVE_MS,
        dividerFrameMs: BUDGET_DIVIDER_FRAME_MS,
        chipFrameMs: BUDGET_CHIP_FRAME_MS,
        keyFrameMs: BUDGET_KEY_FRAME_MS,
      },
      samples,
      openSamples,
      previewSamples: composer?.samples,
      cspViolations: csp,
      failures,
    },
  };
}
