// What the agent's parts of the window say, as pure functions, so the words are tested without a
// page: the plans line, the runtime, a draft's pieces and who wrote it, rules and instructions.
// Nothing here reads the DOM or talks to the backend.
import type {
  AgentEffortSetting,
  AgentModels,
  AgentRuntimeId,
  AgentRuntimeInfo,
  AgentStatus,
  AgentWorkKind,
  PlanLimits,
  PlanWindow,
  PromptProgress,
  ReadingProgress,
  ReadingStatus,
  ReadingView,
  ReadingWait,
  ThreadCategory,
} from "@matters/core";

import {
  AGENT_EFFORTS,
  AGENT_WORK_KINDS,
  kindsOn,
  kindTakesMail,
  levelsFor,
  modelUsesTools,
  NO_WEEK_LIMIT_PERCENT,
  planUseOf,
  runtimeInfo,
  TITLES_OFF,
} from "@matters/core";

const DAY_MS = 86_400_000;

/** Below this many percent left the plan's number turns to the late colour. */
export const LOW_LEFT_PERCENT = 20;

const dueFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

// --- The status of the plans (ADR 0052, rule 11) ---

/** `Mon 14:00` for another day, `14:00` for today. */
export function resetText(ms: number, now: number): string {
  const d = new Date(ms);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === new Date(now).toDateString()) return time;
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(d);
  return ms - now < 6 * DAY_MS ? `${day} ${time}` : `${dueFormat.format(d)} ${time}`;
}

/** Percent of a window left, or `undefined` when the window is unknown. A passed reset counts as full. */
export function percentLeft(window: PlanWindow | undefined, now: number): number | undefined {
  if (window === undefined) return undefined;
  if (now >= window.resetsAtMs) return 100;
  return Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)));
}

/** "as of 10:42": limits are known only after a turn, so they age. */
export function seenText(limits: PlanLimits | undefined, now: number): string {
  return limits === undefined ? "" : `as of ${resetText(limits.seenAtMs, now)}`;
}

/** `Haiku` for `haiku`: the alias the runtime accepts, written for people. */
/** The words for each effort (ADR 0118, rule 2). */
export const EFFORT_WORDS: Readonly<Record<AgentEffortSetting, string>> = {
  default: "Default",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/**
 * The effort a kind of work can be set to on this runtime: `Default`, then the levels it lists,
 * lowest first. None when it lists none, and the control is not shown (ADR 0118, rule 4). With
 * `model`, the levels of that model, where they differ by model (ADR 0119, rule 9).
 */
export function effortOptions(
  runtime: Pick<AgentRuntimeInfo, "efforts" | "modelEfforts"> | null,
  model?: string,
): readonly (readonly [AgentEffortSetting, string])[] {
  const listed =
    runtime?.modelEfforts !== undefined && model !== undefined
      ? levelsFor(runtime, model)
      : runtime?.efforts;
  const levels = AGENT_EFFORTS.filter((level) => listed?.includes(level) === true);
  if (levels.length === 0) return [];
  return (["default", ...levels] as const).map((value) => [value, EFFORT_WORDS[value]] as const);
}

/** The effort a ledger line's turn was sent with, in words; nothing when none was (rule 7). */
export function ledgerEffort(entry: { readonly effort?: AgentEffortSetting }): string {
  if (entry.effort === undefined || entry.effort === "default") return "";
  return `${EFFORT_WORDS[entry.effort].toLowerCase()} effort`;
}

/**
 * The account a ledger line's turn went for, in words: none for a turn no account was asked for,
 * as a theme's (ADR 0134, rule 15), and a plain phrase for one since removed.
 */
export function ledgerAccount(
  entry: { readonly accountId: string },
  addressOf: (id: string) => string | undefined,
): string {
  if (entry.accountId === "") return "";
  return addressOf(entry.accountId) ?? "an account that was removed";
}

/** What the control shows: a stored level the runtime does not list goes as `Default` (rule 4). */
export function effortShown(
  setting: AgentEffortSetting,
  runtime: Pick<AgentRuntimeInfo, "efforts" | "modelEfforts"> | null,
  model?: string,
): AgentEffortSetting {
  return effortOptions(runtime, model).some(([value]) => value === setting) ? setting : "default";
}

export function modelName(model: string): string {
  if (model === "") return model;
  return model.charAt(0).toUpperCase() + model.slice(1);
}

export interface PlanButton {
  readonly text: string;
  /** Under 20% left, or paused: the late colour. */
  readonly late: boolean;
}

/**
 * The button of a question from the agent: `Write the draft` once a way forward is chosen, and
 * `Answer` until then, which takes the person to the prompt in the agent's column (ADR 0069,
 * rule 8). Words are never typed in the question's frame.
 */
export function questionButtonText(busy: boolean, directionChosen: boolean): string {
  if (busy) return "Writing…";
  return directionChosen ? "Write the draft" : "Answer";
}

/**
 * The button of the status line for the runtime a talk runs on: `Claude Code 61% left`, `limits
 * not known yet`, or why the reading is paused. The session is the window that decides what can
 * run now; the windows are that runtime's own (ADR 0121, rule 6). A runtime with no plan has no
 * button but while reading is paused (ADR 0119, rule 7): null.
 */
export function planButton(
  status: AgentStatus,
  runtimeId: AgentRuntimeId | undefined,
  now: number,
): PlanButton | null {
  const runtime = runtimeInfo(status, runtimeId);
  const name = runtime?.name ?? "Agent";
  const p = status.progress;
  if (p.state === "paused") {
    const until = p.untilMs === undefined ? "" : ` until ${resetText(p.untilMs, now)}`;
    const why = p.reason === "limit" || p.reason === "sessionLimit" || p.reason === "weekLimit";
    return { text: `Paused${until}${why ? " · plan limit" : pausedWhy(p.reason)}`, late: true };
  }
  if (hasNoPlan(runtime)) return null;
  const left = percentLeft(planUseOf(status.settings, runtimeId).limits?.session, now);
  if (left === undefined) return { text: `${name} · limits not known yet`, late: false };
  return { text: `${name} ${left}% left`, late: left < LOW_LEFT_PERCENT };
}

function pausedWhy(reason: ReadingProgress["reason"]): string {
  switch (reason) {
    case "budget":
      return " · your share of the week";
    case "overage":
      return " · plan limit";
    case "signedOut":
      return " · signed out";
    case "notPlan":
      return " · not on your plan";
    default:
      return "";
  }
}

// --- The reading in the background (ADR 0117, rule 3a) ---

const count = (n: number) => n.toLocaleString("en-US");

/**
 * Why the reading in the background does not read now, in a few words: `Reading paused`,
 * `Waits for room in Codex's session until 14:00`. The time is the one the gate or the runtime
 * gave; none is made up. The foot row, a view's line, the popover and Settings all say it so.
 */
export function readingWaitText(wait: ReadingWait, runtime: string, now: number): string {
  const who = runtime === "" ? "the assistant" : runtime;
  const whose = runtime === "" ? "the assistant's" : `${runtime}'s`;
  const until = (ms: number | undefined) =>
    ms === undefined ? "" : ` until ${resetText(ms, now)}`;
  switch (wait.kind) {
    case "pausedByPerson":
      return "Reading paused";
    case "limit":
      return `Reading paused at ${whose} limit${until(wait.untilMs)}`;
    case "plan":
      if (wait.unknown === true) return `Waits until ${whose} limits are known`;
      switch (wait.reason) {
        case "sessionLimit":
          return `Waits for room in ${whose} session${until(wait.untilMs)}`;
        case "weekLimit":
          return `Waits for room in ${whose} week${until(wait.untilMs)}`;
        case "budget":
          return `Waits for its share of ${whose} week${until(wait.untilMs)}`;
        case "overage":
          return `Waits: ${who} is past its plan's limit`;
      }
      return `Waits for ${who}`;
    case "checking":
      return `Waits while ${who} is checked`;
    case "signedOut":
      return `Waits: sign in to ${who}`;
    case "notPlan":
      return `Waits: ${who} is not on your plan`;
    case "runtime":
      return `Waits: ${who} is not ready`;
    case "consent":
      return `Waits: no account is shared with ${who}`;
    case "soon":
      return "Reading goes on in a moment";
    case "failed":
      return "Stopped after a turn failed; tries again with new mail";
  }
}

/** The reason is the person's to act on (`--late`): reading cannot go on until they do. */
export function readingWaitActs(wait: ReadingWait | undefined): boolean {
  const k = wait?.kind;
  return k === "consent" || k === "signedOut" || k === "runtime" || k === "notPlan";
}

/** `292 of 754 read`, or `292 read` once nothing is left; nothing for a view never run. */
export function readingCountText(view: ReadingView, live?: PromptProgress | null): string {
  if (view.state === "notRun") return "";
  const v = live?.view;
  if (live != null && v !== undefined && v.id === view.viewId && v.total > 0) {
    return `${count(Math.min(v.read + live.done, v.total))} of ${count(v.total)} read`;
  }
  const total = view.read + view.toRead;
  return view.toRead === 0
    ? `${count(view.read)} read`
    : `${count(view.read)} of ${count(total)} read`;
}

/** The state of one view in the popover, in words. */
export function readingStateText(view: ReadingView, runtime: string, now: number): string {
  switch (view.state) {
    case "reading":
      return "Reading now";
    case "upToDate":
      return "Up to date";
    case "notRun":
      return "Not run yet: it is read once you open it";
    case "left": {
      const n = view.left ?? view.toRead;
      return `${count(n)} sent twice came back with nothing; read again when they change`;
    }
    case "waiting":
      return view.wait === undefined ? "Waits" : readingWaitText(view.wait, runtime, now);
  }
}

/** The reading's segment of the list's foot row (ADR 0117, rule 3a). */
export interface ReadingFoot {
  /** Its words, which carry the state by themselves: `Needs you 292 / 754`, `Reading paused · …`. */
  readonly text: string;
  /** `reading`: the ring and the agent's colour; `waiting`: a still dot; `act`: the person acts. */
  readonly kind: "reading" | "waiting" | "act";
  /** Reading: how far the view read is, 0 to 1, for the line along the row's top edge. */
  readonly fraction?: number;
  /** Reading: a turn is out now, so the line shows work in flight. */
  readonly inFlight?: boolean;
  /** Waiting: `text` in two parts, why and which view how far, each a line of its own. */
  readonly why?: string;
  readonly which?: string;
}

/** `292 / 754`: how far, in the foot row's short form; it never breaks across lines. */
const far = (done: number, total: number) =>
  `${count(Math.min(done, total))}\u00a0/\u00a0${count(total)}`;

/**
 * What the list's foot row says of the reading in the background: while a view is read, which
 * and how far (`Needs you 292 / 754`); while views have threads left and nothing reads them, why,
 * with the time when known, and which and how far (`Reading paused · Needs you 292 / 754`). Null
 * when everything is read, when AI is off, or when nothing is known yet.
 */
export function readingFoot(
  status: ReadingStatus | null,
  live: PromptProgress | null,
  now: number,
): ReadingFoot | null {
  if (live !== null && live.view !== undefined && !live.finished) {
    const v = live.view;
    const total = v.total > 0 ? v.total : live.total;
    const done = v.total > 0 ? v.read + live.done : live.done;
    return {
      text: total > 0 ? `${v.name} ${far(done, total)}` : v.name,
      kind: "reading",
      fraction: total > 0 ? Math.min(1, done / total) : 0,
      inFlight: live.inFlight !== undefined,
    };
  }
  if (status === null || status.ai === "off") return null;
  const reading = status.views.find((v) => v.state === "reading");
  if (reading !== undefined) {
    const total = reading.read + reading.toRead;
    return {
      text: total > 0 ? `${reading.name} ${far(reading.read, total)}` : reading.name,
      kind: "reading",
      fraction: total > 0 ? reading.read / total : 0,
    };
  }
  const waiting = status.views.filter((v) => v.state === "waiting");
  if (waiting.length === 0) {
    // No view to speak of; but a reason that holds all of them back still says so.
    if (status.wait?.kind === "consent") {
      return { text: readingWaitText(status.wait, status.runtime, now), kind: "act" };
    }
    return null;
  }
  const first = waiting[0] as ReadingView;
  const wait = status.wait ?? first.wait;
  const why = wait === undefined ? "Waits" : readingWaitText(wait, status.runtime, now);
  const which =
    waiting.length === 1
      ? `${first.name} ${far(first.read, first.read + first.toRead)}`
      : `${waiting.length} views, ${count(waiting.reduce((n, v) => n + v.toRead, 0))} left`;
  return {
    text: `${why} · ${which}`,
    kind: readingWaitActs(wait) ? "act" : "waiting",
    why,
    which,
  };
}

/** Settings › Agents, beside `Pause reading`: the same words as the foot row, or that all is read. */
export function readingSettingsText(
  status: ReadingStatus | null,
  live: PromptProgress | null,
  now: number,
  /** What is out, in words (promptView's `inFlightText`): it ticks with `now`. */
  out = "",
): string {
  const foot = readingFoot(status, live, now);
  if (foot !== null) {
    const head = foot.kind === "reading" ? `Reading ${foot.text}` : foot.text;
    return out === "" ? head : `${head} · ${out}`;
  }
  if (status === null || status.ai === "off") return "";
  if (status.views.length === 0) return "No saved view has a prompt.";
  if (status.views.every((v) => v.state === "notRun")) return "No view with a prompt was run yet.";
  return "Every view with a prompt is read.";
}

export interface WindowLine {
  readonly label: string;
  readonly left: string;
  readonly resets: string;
}

/** One window as the popover and Settings say it; "limits not known yet" when there is none. */
export function windowLine(label: string, window: PlanWindow | undefined, now: number): WindowLine {
  const left = percentLeft(window, now);
  if (left === undefined || window === undefined) {
    return { label, left: "limits not known yet", resets: "" };
  }
  return { label, left: `${left}% left`, resets: `resets ${resetText(window.resetsAtMs, now)}` };
}

/** The state of a runtime, as its card says it. */
const STATUS_WORDS: Record<AgentRuntimeInfo["status"], string> = {
  ready: "Ready",
  found: "Signed in · not checked yet",
  signedOut: "Not signed in",
  missing: "Not found on this Mac",
  failed: "The check did not pass",
  notRunning: "Not running",
  noModel: "No model installed",
};

/** The state of a runtime in a few words; one on this Mac has no sign-in to speak of. */
export function statusWords(runtime: AgentRuntimeInfo | null): string {
  if (runtime === null) return "Not looked at yet";
  if (runtime.status === "found" && runtime.onThisMachine === true) {
    return "Installed · not checked yet";
  }
  return STATUS_WORDS[runtime.status];
}

/**
 * Whether Settings offers the search in a loop (ADR 0083): only when the model for writing, which
 * the loop runs on, can use our tools. On another it would do nothing, so it is not shown (ADR
 * 0119, rule 10).
 */
export function loopOffered(runtime: AgentRuntimeInfo | null | undefined, model: string): boolean {
  return modelUsesTools(runtime, model);
}

/** The runtime has no plan (ADR 0119, rule 7): windows, shares and limits do not show. */
export function hasNoPlan(runtime: Pick<AgentRuntimeInfo, "noPlan"> | null | undefined): boolean {
  return runtime?.noPlan === true;
}

/** What is said of a runtime on a plan: where mail goes, the plan, whose privacy settings. */
interface RuntimeWords {
  /** Who mail goes to: `Claude`, `OpenAI`. */
  readonly vendor: string;
  /** The plan it goes under, when the vendor's name does not say it already. */
  readonly plan?: string;
  /** Whose privacy settings apply. */
  readonly privacy: string;
  /** What to run in Terminal to sign in (ADR 0051, rule 2). */
  readonly signIn: string;
}

const RUNTIME_WORDS: Readonly<Record<string, RuntimeWords>> = {
  "claude-code": { vendor: "Claude", privacy: "Claude", signIn: "claude auth login" },
  codex: {
    vendor: "OpenAI",
    plan: "your ChatGPT plan",
    privacy: "ChatGPT",
    signIn: "codex login",
  },
};

/** Who mail goes to, in a sentence that says so: `Claude`, `OpenAI`. */
export function vendorName(runtime: Pick<AgentRuntimeInfo, "id" | "name"> | null): string {
  return RUNTIME_WORDS[runtime?.id ?? ""]?.vendor ?? runtime?.name ?? "the assistant";
}

/** The command to run in Terminal for a runtime that is signed out (ADR 0051, rule 2). */
export function signInCommand(runtime: Pick<AgentRuntimeInfo, "id"> | null): string {
  return RUNTIME_WORDS[runtime?.id ?? ""]?.signIn ?? SIGN_IN_COMMAND;
}

/**
 * The consent question's line about where mail goes (ADR 0051, rule 6; ADR 0120, rule 10): to the
 * vendor, under the person's plan, only when asked and for views with a prompt.
 */
export function consentText(runtime: AgentRuntimeInfo | null): string {
  if (runtime?.onThisMachine === true) {
    return `${vendorName(runtime)} reads mail only when you ask about it, and for views with a prompt, such as Needs you, which read new mail as it comes. It runs on this Mac: your mail stays on this Mac.`;
  }
  const words = RUNTIME_WORDS[runtime?.id ?? ""];
  const plan = words?.plan === undefined ? "" : `, under ${words.plan},`;
  const privacy = words?.privacy ?? vendorName(runtime);
  return `Mail goes to ${vendorName(runtime)}${plan} only when you ask about it, and for views with a prompt, such as Needs you, which read new mail as it comes. Your ${privacy} privacy settings apply to what is sent.`;
}

/**
 * What goes whole of a file with no text, said for the runtime chosen (ADR 0090; ADR 0120, rule
 * 7). Empty when nothing does.
 */
export function wholeFilesText(
  runtime: Pick<AgentRuntimeInfo, "id" | "name" | "modelFiles"> | null,
): string {
  if (runtime === null) return "";
  if (runtime.id === "claude-code") {
    return "With Claude Code, a scan or a photo that has no text goes whole, its pages as they look, up to three a question.";
  }
  const kinds = Object.values(runtime.modelFiles ?? {}).flat();
  if (!kinds.some((k) => k.startsWith("image/"))) return "";
  return `With ${runtime.name}, a photo that has no text goes whole, up to three a question; a scan in a PDF does not.`;
}

/**
 * "Matters this week: about 4% of Claude". The share is of this runtime's plan's week, as counted
 * by us (ADR 0121, rule 6).
 */
export function ourShare(status: AgentStatus, runtimeId: AgentRuntimeId | undefined): string {
  const used = planUseOf(status.settings, runtimeId).usedByUsPercent;
  const about = used < 1 ? "less than 1%" : `about ${Math.round(used)}%`;
  return `Matters this week: ${about} of ${vendorName(runtimeInfo(status, runtimeId))}`;
}

// --- The background limit (ADR 0131) ---

/** The shares of the week the list names; any other whole percent is `Custom…`. */
export const WEEK_SHARES: readonly number[] = [5, 10, 25, 50];

/** What the background limit's list shows for a stored share: a preset, `none` or `custom`. */
export function shareChoice(percent: number): string {
  if (percent >= NO_WEEK_LIMIT_PERCENT) return "none";
  return WEEK_SHARES.includes(percent) ? String(percent) : "custom";
}

/** The options of the background limit, `[value, label]`. */
export function shareOptions(): readonly (readonly [string, string])[] {
  return [
    ...WEEK_SHARES.map((n) => [String(n), `Up to ${n}% of my week`] as const),
    ["none", "No limit"],
    ["custom", "Custom…"],
  ];
}

/** A typed share of the week: a whole number from 1 to 99, else undefined. */
export function customShare(text: string): number | undefined {
  const t = text.trim();
  if (!/^\d{1,2}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= 99 ? n : undefined;
}

/** What the background limit says under its label, for what the list shows. */
export function shareHint(choice: string): string {
  return choice === "none"
    ? "Runs until the plan's limit, then waits for the reset. Never on paid credits."
    : "Of each plan that shows limits. It stops there, never on paid credits.";
}

// --- A runtime for each kind of work (ADR 0121) ---

/** The kinds of work in the person's words, lower case, for a sentence. */
export const KIND_WORDS: Readonly<Record<AgentWorkKind, string>> = {
  understand: "understanding mail",
  write: "writing",
  answer: "questions",
  titles: "talk titles",
  appearance: "making themes",
};

/** `understanding mail and writing`, or `understanding mail, writing and questions`. */
export function kindsWords(kinds: readonly AgentWorkKind[]): string {
  const words = kinds.map((k) => KIND_WORDS[k]);
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** What a runtime does, as its card says it: `Used for writing and questions`, or `Not used`. */
export function usedForLine(status: AgentStatus, runtimeId: AgentRuntimeId): string {
  const kinds = kindsOn(status.settings, runtimeId);
  if (kinds.length === 0) return "Not used";
  if (kinds.length === AGENT_WORK_KINDS.length) return "Used for all work";
  return `Used for ${kindsWords(kinds)}`;
}

/**
 * Why a kind of work waits, in one sentence, or "" while it can run (ADR 0121, rule 3): its runtime
 * is not ready, or no account agreed to it. Another kind is not stopped by it.
 */
export function kindWaits(status: AgentStatus, kind: AgentWorkKind): string {
  const id = status.settings.kindRuntime[kind];
  if (id === undefined) return "";
  if (kind === "titles" && status.settings.models.titles === TITLES_OFF) return "";
  const runtime = runtimeInfo(status, id);
  const name = runtime?.name ?? status.runtimes.find((r) => r.id === id)?.name ?? id;
  if (runtime !== null && runtime.status !== "ready") {
    return `Waits: ${name} is ${statusWords(runtime).toLowerCase()}.`;
  }
  // Making a theme takes no mail, so it waits on no account (ADR 0134, rule 14).
  if (
    kindTakesMail(kind) &&
    status.settings.enabled &&
    !status.consents.some((c) => c.runtimeId === id)
  ) {
    return `Waits: you have not let ${name} read any account yet.`;
  }
  return "";
}

/** The name of the runtime the talk in view runs on: its own choice, else its kind's (rule 8). */
export function talkRuntimeName(
  status: AgentStatus | null,
  scope: "thread" | "all",
  choice: { readonly runtimeId: AgentRuntimeId } | null,
): string {
  if (status === null) return "The agent";
  const id = choice?.runtimeId ?? status.settings.kindRuntime[scope === "all" ? "answer" : "write"];
  return status.runtimes.find((r) => r.id === id)?.name ?? "The agent";
}

/** One runtime a talk can run on (ADR 0121, rule 8), with the models it lists. */
export interface TalkRuntime {
  readonly id: AgentRuntimeId;
  readonly name: string;
  readonly models: readonly string[];
}

/**
 * The runtimes the model choice of a talk lists (ADR 0121, rule 8): every one that is ready and
 * that the mail in question agreed to (the thread's account, or any account across all mail), in
 * the order the app offers them.
 */
export function talkRuntimes(
  status: AgentStatus,
  accountId: string | null,
): readonly TalkRuntime[] {
  return status.runtimes.flatMap((r) => {
    const info = r.info;
    if (info === null || info.status !== "ready" || info.models.length === 0) return [];
    const agreed = status.consents.some(
      (c) => c.runtimeId === r.id && (accountId === null || c.accountId === accountId),
    );
    return agreed ? [{ id: r.id, name: r.name, models: info.models }] : [];
  });
}

/**
 * The runtimes that run on this machine, by the name a talk entry keeps (ADR 0119): their answers
 * were made here, on no plan.
 */
const ON_THIS_MACHINE = new Set(["Ollama"]);

/** Who answered in a talk: `Claude Code, Sonnet, your plan`, or `Ollama, Qwen3:8b, on this Mac`. */
export function answeredByLine(runtimeName: string, model: string): string {
  const where = ON_THIS_MACHINE.has(runtimeName) ? "on this Mac" : "your plan";
  return `${runtimeName}, ${modelName(model)}, ${where}`;
}

/** What left the machine for an answer about one thread. */
export function sentLine(runtimeName: string): string {
  return ON_THIS_MACHINE.has(runtimeName)
    ? `Read this thread with ${runtimeName}, on this Mac. Nothing left this Mac.`
    : `Sent this thread to ${runtimeName}. Nothing else left this Mac.`;
}

/** The model that wrote a draft: every draft is written on request, on the runtime for writing. */
export function writtenByLine(runtime: AgentRuntimeInfo | null, models: AgentModels): string {
  const where = runtime?.onThisMachine === true ? "on this Mac" : "your plan";
  return `${runtime?.name ?? "Agent"}, ${modelName(models.write)}, ${where}`;
}

// --- The words the person gave (ADR 0052, rule 10) ---

export interface Piece {
  readonly text: string;
  /** The person's own words: underlined inside the sheet. */
  readonly yours: boolean;
}

/**
 * Splits a draft into the agent's words and the person's. Only a passage that occurs word for
 * word counts: a rephrasing is the agent's. Text is returned unchanged, only cut in pieces.
 */
export function splitYours(body: string, given: readonly string[]): readonly Piece[] {
  let pieces: Piece[] = [{ text: body, yours: false }];
  for (const words of given) {
    const needle = words.trim();
    if (needle === "") continue;
    const next: Piece[] = [];
    for (const piece of pieces) {
      if (piece.yours) {
        next.push(piece);
        continue;
      }
      let from = 0;
      for (;;) {
        const at = piece.text.indexOf(needle, from);
        if (at < 0) break;
        if (at > from) next.push({ text: piece.text.slice(from, at), yours: false });
        next.push({ text: needle, yours: true });
        from = at + needle.length;
      }
      if (from < piece.text.length) next.push({ text: piece.text.slice(from), yours: false });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.text !== "");
}

/** The command to run in Terminal for a runtime that is signed out (ADR 0051, rule 2). */
export const SIGN_IN_COMMAND = "claude auth login";

/** A kind of mail in the person's words, for "Don't show …" (ADR 0068, rule 3). */
export const CATEGORY_WORDS: Record<ThreadCategory, string> = {
  personal: "personal mail",
  work: "work mail",
  official: "mail from public offices",
  bill: "bills",
  paymentProblem: "payment problems",
  account: "account notices",
  order: "orders and shipments",
  offer: "offers",
  terms: "changes of terms",
  newsletter: "newsletters",
  notification: "notifications",
  other: "other mail",
};

/** What a rule says, in the person's words: `No reply needed from alerts@x.com`. */
export function ruleText(rule: {
  readonly scope: "sender" | "domain" | "type" | "category";
  readonly subject: string;
}): string {
  if (rule.scope === "category") {
    const words = CATEGORY_WORDS[rule.subject as ThreadCategory] ?? rule.subject;
    return `Don't show ${words}`;
  }
  return rule.scope === "type"
    ? "No reply needed from addresses that look like programs (alerts@, updates@…)"
    : `No reply needed from ${rule.subject}`;
}

/** Where an instruction applies, in the person's words. */
export function instructionScopeWords(
  scope: "general" | "understand" | "write" | "thread",
): string {
  return scope === "general"
    ? "In general"
    : scope === "understand"
      ? "When reading"
      : scope === "write"
        ? "When writing"
        : "For this thread";
}

/** What the tray says was kept: the instruction's text, or what the rule means for its sender. */
export function rememberedText(
  item:
    | { readonly kind: "instruction"; readonly instruction: { readonly text: string } }
    | {
        readonly kind: "rule";
        readonly rule: {
          readonly scope: "sender" | "domain" | "type" | "category";
          readonly subject: string;
        };
      },
): string {
  return item.kind === "instruction" ? item.instruction.text : ruleText(item.rule);
}
