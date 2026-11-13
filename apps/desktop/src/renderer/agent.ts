// The window's side of agents (ADR 0051, 0063): the status of the plans, what was prepared in a
// thread on request, and the tray's line after the agent closed or kept something. Everything here
// is a local read or a request the person made; nothing waits for a model except `prepare`, which
// is the person's own ask and blocks nothing else. A push (`agentChanged`) carries no data but
// whether the status itself changed (ADR 0115), so it is coalesced and the status is asked for
// again.
import type {
  AddInstructionInput,
  AgentInstruction,
  AgentRule,
  AgentStatus,
  PrepareResult,
  RememberResult,
  RuleOffer,
  TalkEntry,
} from "@matters/core";
import { PROGRAM_LIKE } from "@matters/core";
import { batch, createSignal } from "solid-js";
import { readEnabledHint, writeEnabledHint } from "./agentPrefs.ts";
import { rememberedText, ruleText } from "./agentText.ts";
import type { Backend } from "./client.ts";
import { BackendError } from "./client.ts";
import { createStatusOrder } from "./statusOrder.ts";

/** What a turn of the talk made. */
type TalkAgentKind = Extract<TalkEntry, { role: "agent" }>["kind"];

/** Quiet time after a push before the status is asked for again: a reading pushes once per step. */
export const COALESCE_MS = 300;
/** The status is asked for again when it is shown, or at most this often while it is not. */
export const STATUS_AGE_MS = 5000;
/** How long the line for "Closed" and "Remembered" offers Undo. */
export const FEEDBACK_UNDO_MS = 8000;

/**
 * `closed`: the agent found nothing to answer in a thread the person asked about (ADR 0054);
 * `remembered`: it kept something from the person's words.
 */
export type LineKind = "closed" | "remembered";

/** The line the tray shows after a closing, or after the agent kept something. */
export interface FeedbackLine {
  readonly id: number;
  readonly kind: LineKind;
  readonly threadId: string;
  readonly headline: string;
  /** What the line says, e.g. `Closed: nothing to answer`. */
  readonly text: string;
  /** After a closing: one click for a rule for the sender (ADR 0054, rule 9). */
  readonly offer?: RuleOffer;
  /** For `remembered`: exactly what was kept, so Undo removes that and nothing else. */
  readonly added?: RememberResult["items"];
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

/** Two reads that came out alike. */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof BackendError && error.message !== "" ? error.message : fallback;
}

/** What `Send` did, for the view and for the tests: the path is only ever these two. */
export type SendOutcome = "sent" | "openedExisting" | "failed";

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
  const [loaded, setLoaded] = createSignal(false);
  // The words the person gave, per thread, so the sheet can underline them.
  const [given, setGiven] = createSignal<ReadonlyMap<string, readonly string[]>>(new Map());
  // The direction picked on a question, per thread: a click or a digit key.
  const [chosen, setChosen] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
  const [problems, setProblems] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [line, setLine] = createSignal<FeedbackLine | null>(null);
  let statusAt = 0;
  // A push said the status changed, and no read has started since (ADR 0115).
  let statusChanged = false;
  let cancelStatusLater: (() => void) | null = null;
  let cancelTimer: (() => void) | null = null;
  let running = false;
  let again = false;
  let lineSeq = 0;
  let cancelLine: (() => void) | null = null;

  const hint = readEnabledHint();
  const enabled = () => {
    const s = status();
    return s === null ? hint : s.settings.enabled === true;
  };

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

  // --- Asking for the status ---

  /**
   * A push the status was not read for, because it was fresh: it is read once it is old enough,
   * so no change waits for a push that may never come (ADR 0115). One at a time, so a reading's
   * pushes cost one status read per `STATUS_AGE_MS`.
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
          setLoaded(true);
        });
        writeEnabledHint(next.settings.enabled);
      });
    } catch {
      // The old status stays: a failed read must not turn AI off on screen.
      setLoaded(true);
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
        const wantStatus = statusChanged || status() === null || now() - statusAt > STATUS_AGE_MS;
        // Taken only by the read that answers it: a push folded into this refresh keeps its own.
        if (wantStatus) {
          statusChanged = false;
          await loadStatus();
        } else statusLater();
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

  // --- What the person asks for ---

  /**
   * `Prepare now` and `Write the draft` in a thread (ADR 0063): the person's ask, which may take a
   * while. `headline` names the thread on the closing line. Gives what the ask came to, or null
   * when it did not run or failed (the failure is in `problem`).
   */
  async function prepare(
    threadId: string,
    guidance?: { direction?: string; answer?: string },
    headline = "",
  ): Promise<PrepareResult | null> {
    if (busy().has(threadId)) return null;
    put("busy", threadId, true);
    put("problems", threadId, "");
    try {
      const work = await backend.agentPrepare(threadId, guidance);
      // Typed words may also say what should hold from now on. That is a second, background turn:
      // the reply below shows at once and `busy` clears as before, and nothing waits for it.
      const typed = (guidance?.answer ?? "").trim();
      if (typed !== "") void remember(threadId, typed);
      if (work.kind === "closed") {
        // The person's words said nothing should be written (ADR 0054): a line says why, with an
        // Undo. The reason is model text and is shown as text only.
        showLine("closed", threadId, headline, `Closed: ${work.reason}`);
        return work;
      }
      const words = [guidance?.answer, guidance?.direction].filter(
        (w): w is string => w !== undefined && w.trim() !== "",
      );
      setGiven((m) => new Map(m).set(threadId, words));
      return work;
    } catch (error) {
      put("problems", threadId, messageOf(error, "The agent could not prepare this. Try again."));
      return null;
    } finally {
      put("busy", threadId, false);
    }
  }

  /**
   * A turn of the talk finished (ADR 0064, rule 6). A closing shows the same line and Undo as any
   * closing. After a draft or a question the words may hold from now on (ADR 0054, rule 7). An answer changes nothing and spends nothing.
   */
  function talkMade(
    threadId: string,
    kind: TalkAgentKind,
    text: string,
    words: string,
    headline: string,
  ) {
    if (kind === "answer") return;
    void remember(threadId, words);
    if (kind === "closed") {
      // The turn recorded the closing before it finished.
      showLine("closed", threadId, headline, `Closed: ${text}`);
      return;
    }
    setGiven((m) => new Map(m).set(threadId, [words]));
  }

  /**
   * `Send` (ADR 0052, rule 8): the text becomes a reply draft by the composer's own rules, and the
   * draft goes to the outbox with its undo window. Nothing else sends. A draft the person already
   * had is never overwritten and never sent from here: the composer opens on it.
   */
  async function send(threadId: string, body: string): Promise<SendOutcome> {
    if (busy().has(threadId)) return "failed";
    put("busy", threadId, true);
    put("problems", threadId, "");
    try {
      const made = await backend.agentDraftFromPrepared(threadId, body);
      if (made.existing) {
        await options.openDraft(made.draftId);
        return "openedExisting";
      }
      await backend.requestSend(made.draftId);
      return "sent";
    } catch (error) {
      put("problems", threadId, messageOf(error, "That could not be sent."));
      return "failed";
    } finally {
      put("busy", threadId, false);
    }
  }

  /**
   * `Edit myself`: the same draft, in the composer; from there it is the person's. If they already
   * had a draft for the thread, that one opens, untouched, and the agent's text stays a proposal.
   */
  async function editMyself(
    threadId: string,
    body: string,
  ): Promise<"took" | "existing" | "failed"> {
    if (busy().has(threadId)) return "failed";
    put("busy", threadId, true);
    put("problems", threadId, "");
    try {
      const made = await backend.agentDraftFromPrepared(threadId, body);
      await options.openDraft(made.draftId);
      return made.existing ? "existing" : "took";
    } catch (error) {
      put("problems", threadId, messageOf(error, "The draft could not be opened."));
      return "failed";
    } finally {
      put("busy", threadId, false);
    }
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

  function clearLine() {
    cancelLine?.();
    cancelLine = null;
    setLine(null);
  }

  /** The one place the tray's line is set, with the time Undo is offered. */
  function showLine(
    kind: LineKind,
    threadId: string,
    headline: string,
    text: string,
    added?: RememberResult["items"],
  ) {
    cancelLine?.();
    const id = ++lineSeq;
    setLine({ id, kind, threadId, headline, text, ...(added === undefined ? {} : { added }) });
    cancelLine = schedule(() => {
      if (lineSeq === id) setLine(null);
    }, FEEDBACK_UNDO_MS);
    // After a closing; the backend decides when that adds up to a rule (ADR 0058, rule 4). The
    // line does not wait for it.
    if (kind === "closed") void offerRule(id, threadId);
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

  /** Undo on the tray's line: the closing is forgotten, or what was kept is removed. */
  async function undoFeedback(): Promise<void> {
    const current = line();
    if (current === null) return;
    clearLine();
    if (current.kind === "remembered") {
      // Exactly what this result added, by id.
      for (const item of current.added ?? []) {
        try {
          if (item.kind === "rule") await backend.agentRemoveRule(item.rule.id);
          else await backend.agentRemoveInstruction(item.instruction.id);
        } catch {
          // What could not be removed stays, and Settings lists it with its own Remove.
        }
      }
      return;
    }
    try {
      await backend.agentUndoFeedback(current.threadId, current.kind);
    } catch {
      // The closing stays; it is still in the journal.
    }
  }

  // --- Settings the page changes ---

  async function change(work: Promise<AgentStatus>): Promise<AgentStatus> {
    return order.settle(work, (value) => {
      batch(() => {
        setStatus(value);
        statusAt = now();
      });
      writeEnabledHint(value.settings.enabled);
    });
  }

  return {
    status,
    /** The first status read answered, or failed. */
    loaded,
    /** AI is on. */
    enabled,
    line,
    busy: (threadId: string) => busy().has(threadId),
    problem: (threadId: string) => problems().get(threadId) ?? "",
    /** The direction picked on the thread's question, if any. */
    directionOf: (threadId: string): string | undefined => chosen().get(threadId),
    chooseDirection(threadId: string, direction: string) {
      setChosen((m) => new Map(m).set(threadId, direction));
    },
    /** The words the person gave for this thread in this window. */
    givenFor: (threadId: string): readonly string[] => given().get(threadId) ?? [],
    /** The first read. */
    start: refresh,
    refresh,
    prepare,
    talkMade,
    send,
    editMyself,
    undoFeedback,
    addRuleFromLine,
    dismissLine: clearLine,
    /** `Pause reading` and `Continue` in Settings (ADR 0053, rule 8; ADR 0117, rule 3). */
    pauseReading: () => change(backend.agentPauseReading()),
    resumeReading: () => change(backend.agentResumeReading()),
    /** After a setting changed in this window (models, week share, consent). */
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
