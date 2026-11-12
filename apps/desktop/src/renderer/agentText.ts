// What the agent's parts of the window say, as pure functions, so the words are tested without a
// page: the plans line, the runtime, a draft's pieces and who wrote it, rules, instructions and the
// journal. Nothing here reads the DOM or talks to the backend.
import type {
  AgentEffortSetting,
  AgentModels,
  AgentRuntimeInfo,
  AgentStatus,
  JournalEntry,
  PlanLimits,
  PlanWindow,
  ReadingProgress,
  ThreadCategory,
} from "@matters/core";

import { AGENT_EFFORTS, levelsFor, modelUsesTools } from "@matters/core";

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
 * The button of the status line: `Claude Code 61% left`, `limits not known yet`, or why work is
 * paused. The session is the window that decides what can run now. A runtime with no plan has no
 * button but while reading is paused (ADR 0119, rule 7): null.
 */
export function planButton(status: AgentStatus, now: number): PlanButton | null {
  const name = status.runtime?.name ?? "Agent";
  const p = status.progress;
  if (p.state === "paused") {
    const until = p.untilMs === undefined ? "" : ` until ${resetText(p.untilMs, now)}`;
    const why = p.reason === "limit" || p.reason === "sessionLimit" || p.reason === "weekLimit";
    return { text: `Paused${until}${why ? " · plan limit" : pausedWhy(p.reason)}`, late: true };
  }
  if (hasNoPlan(status.runtime)) return null;
  const left = percentLeft(status.settings.limits?.session, now);
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

/** "Matters this week: about 4% of Claude". The share is of the plan's week, as counted by us. */
export function ourShare(status: AgentStatus): string {
  const used = status.settings.usedByUsPercent;
  const about = used < 1 ? "less than 1%" : `about ${Math.round(used)}%`;
  return `Matters this week: ${about} of ${vendorName(status.runtime)}`;
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

/** The model that wrote a draft: every draft is written on request, by the writing model. */
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

// --- The journal (ADR 0054, rule 6) ---

/** One line of `What the agent did`: plain strings only, drawn as text. */
export interface JournalLine {
  readonly entry: JournalEntry;
  /** Who did what: `Closed by the agent`. */
  readonly title: string;
  /** The ground: what the agent gave and what the person typed. Empty when there is none. */
  readonly detail: string;
  /** What the thing was about, from the reading of the mail; empty for a rule or an instruction. */
  readonly headline: string;
  /** Undo can be pressed on this line. */
  readonly undoable: boolean;
  readonly undone: boolean;
}

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

const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/** The words added to a line when a closing hid older threads too (ADR 0065): empty when none. */
export function alsoOlderMails(count: number | undefined): string {
  if (count === undefined || count <= 0) return "";
  return ` · also ${count} older ${count === 1 ? "mail" : "mails"}`;
}

/**
 * What a journal entry says. Undo is offered unless it was taken back already or a `later` has
 * come back by itself. Whether it is the newest of its kind for the thread is for `journalLines`.
 */
export function journalLine(entry: JournalEntry, nowMs: number): JournalLine {
  if (entry.action === "ruleAdded") {
    const words = (entry.words ?? "").trim();
    const undone = entry.undoneAtMs !== undefined;
    return {
      entry,
      title: entry.actor === "agent" ? "Rule added by the agent" : "Rule added by you",
      headline: "",
      detail: words === "" ? ruleText(entry) : `${sentence(ruleText(entry))} You said: "${words}"`,
      undoable: !undone,
      undone,
    };
  }
  if (entry.action === "instructionAdded") {
    const words = (entry.words ?? "").trim();
    const undone = entry.undoneAtMs !== undefined;
    const said = words !== "" && words !== entry.text.trim() ? ` You said: "${words}"` : "";
    return {
      entry,
      title: entry.actor === "agent" ? "Remembered by the agent" : "Instruction added by you",
      headline: "",
      detail: `${instructionScopeWords(entry.scope)}: ${sentence(entry.text.trim())}${said}`,
      undoable: !undone,
      undone,
    };
  }
  const title =
    entry.action === "closed"
      ? entry.actor === "agent"
        ? "Closed by the agent"
        : "Closed by you"
      : entry.action === "notImportant"
        ? "Marked not important"
        : "Set aside";
  const reason = (entry.reason ?? "").trim();
  const words = (entry.words ?? "").trim();
  const detail = [
    ...(reason === "" ? [] : [sentence(reason)]),
    ...(words === "" ? [] : [`You said: "${words}"`]),
  ].join(" ");
  const undone = entry.undoneAtMs !== undefined;
  const expired = entry.action === "later" && entry.untilMs !== undefined && entry.untilMs <= nowMs;
  return {
    entry,
    title: `${title}${alsoOlderMails(entry.alsoCovers)}`,
    detail,
    headline: (entry.headline ?? "").trim(),
    undoable: !undone && !expired,
    undone,
  };
}

/**
 * The lines of a list of entries, newest first as the backend gives them. Undo takes back the
 * newest feedback of a kind for a thread, so only the newest entry of a thread and action that is
 * not undone can be undone; an older one is shown without the button.
 */
export function journalLines(entries: readonly JournalEntry[], nowMs: number): JournalLine[] {
  const newest = new Map<string, number>();
  for (const e of entries) {
    if (e.action === "ruleAdded" || e.action === "instructionAdded" || e.undoneAtMs !== undefined) {
      continue;
    }
    const key = `${e.threadId}\u0000${e.action}`;
    const seen = newest.get(key);
    if (seen === undefined || e.id > seen) newest.set(key, e.id);
  }
  return entries.map((e) => {
    const line = journalLine(e, nowMs);
    // A rule or instruction line is undone by its own id, so it has no newest-of-a-thread to wait for.
    if (e.action === "ruleAdded" || e.action === "instructionAdded") return line;
    const latest = newest.get(`${e.threadId}\u0000${e.action}`) === e.id;
    return line.undoable && !latest ? { ...line, undoable: false } : line;
  });
}
