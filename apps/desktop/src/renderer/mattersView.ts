// What the Matters view says, as pure functions, so the words are tested without a page
// (ADR 0052). Nothing here reads the DOM or talks to the backend.
import type {
  AgentModels,
  AgentRuntimeInfo,
  AgentStatus,
  JournalEntry,
  PlanLimits,
  PlanWindow,
  PreparedWork,
  ReadingProgress,
  Thing,
  ThingBundle,
  ThreadCategory,
} from "@matters/core";

const DAY_MS = 86_400_000;

/** The window asks for this many more things as the list nears its end (ADR 0055). */
export const THINGS_PAGE = 50;

/** How many of the best things get a draft ahead: `DRAFTED_AHEAD` of the backend (ADR 0055). */
export const DRAFTED_AHEAD = 7;

/** Below this many percent left the plan's number turns to the late colour. */
export const LOW_LEFT_PERCENT = 20;

export type RowKind = "working" | "draft" | "nudge" | "question" | "needs";

export interface RowLine {
  readonly kind: RowKind;
  /** The first words of the third line: the state, in the agent's or the late colour. */
  readonly label: string;
  /** What follows ` · `, derived by code from the facts; empty when there is none. */
  readonly note: string;
  /** Agent-prepared work is drawn with the ring and the agent colour; the rest needs the person. */
  readonly agent: boolean;
}

/** The third line of a row (ADR 0052, rule 10): who made what is ready, or what needs the person. */
export function rowLine(thing: Thing, prepared: PreparedWork | undefined): RowLine {
  const note = thing.why;
  if (thing.updating === true) {
    return { kind: "working", label: "Agent working", note, agent: true };
  }
  if (prepared?.kind === "draft") {
    return prepared.nudge
      ? { kind: "nudge", label: "Agent nudge ready", note, agent: true }
      : { kind: "draft", label: "Agent draft ready", note, agent: true };
  }
  if (prepared?.kind === "needs") {
    return { kind: "question", label: "Agent has a question", note, agent: true };
  }
  // What the thing asks of the person, said truly (ADR 0066, rule 8): not every one is a reply.
  const label = INTENT_LABEL[thing.intent ?? "none"] ?? "Needs you";
  return { kind: "needs", label, note, agent: false };
}

const INTENT_LABEL: Partial<Record<NonNullable<Thing["intent"]>, string>> = {
  decide: "To decide",
  act: "To do",
  know: "Worth knowing",
};

/**
 * The small mark on a row that is not what it seems (ADR 0066, rules 4 and 5): a sender nobody can
 * vouch for, or a thing that nothing has come about for a while. Empty for the rest. A suspect
 * sender is the stronger word and wins.
 */
export function rowMark(thing: Thing): string {
  if (thing.suspect === true || thing.unverified === true) return "Check the sender";
  if (thing.official === true) return "Official";
  if (thing.check === true) return "Check once";
  return "";
}

const moneyFormat = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

const AMOUNT_WORD = { debt: "To pay", price: "Price", refund: "Refund", other: "Amount" } as const;

/**
 * What the reader says of an amount and a date beside a thing that is not a reply (ADR 0066, rule 8):
 * the amount with what it is (1090 as a price, a debt and a refund are three things), the end of an
 * offer, a due date. Each part comes from code. Empty when there is nothing to say.
 */
export function intentFacts(thing: Thing): string[] {
  const parts: string[] = [];
  if (thing.amount !== undefined) {
    parts.push(
      `${AMOUNT_WORD[thing.amount.role]} ${moneyFormat.format(thing.amount.value)} ${thing.amount.currency}`,
    );
  }
  if (thing.windowEndMs !== undefined) {
    parts.push(`Ends ${dueFormat.format(new Date(thing.windowEndMs))}`);
  }
  const when = dateOrLateness(thing).text;
  if (when !== "") parts.push(when);
  return parts;
}

/** The facts of the reader's card, one chip each; `late` is drawn in the late colour (ADR 0095). */
export function readerFacts(thing: Thing): { readonly text: string; readonly late: boolean }[] {
  const when = dateOrLateness(thing);
  return intentFacts(thing).map((text) => ({ text, late: when.late && text === when.text }));
}

/** The ways to deal with a thing, by what it asks of the person (ADR 0066, rule 8). */
export type ThingAction =
  | "take"
  | "decline"
  | "details"
  | "done"
  | "gotIt"
  | "ignore"
  | "noReply"
  | "later"
  | "notImportant";

/**
 * Where a button stands (ADR 0095): `primary` is the one answer the thing expects, drawn solid;
 * `plain` is a button beside it; `menu` goes under `Not for me`, with the ways to teach the agent.
 */
export type ActionWeight = "primary" | "plain" | "menu";

export interface ActionSpec {
  readonly id: ThingAction;
  readonly label: string;
  /** What happens, in the person's words: the line under the buttons says it (ADR 0095). */
  readonly hint: string;
  readonly weight: ActionWeight;
}

const LATER: ActionSpec = {
  id: "later",
  label: "Remind me tomorrow",
  hint: "Hides it until tomorrow morning, then brings it back.",
  weight: "plain",
};
const NOT_IMPORTANT: ActionSpec = {
  id: "notImportant",
  label: "Not important",
  hint: "Closes it, and mail from this sender ranks lower.",
  weight: "menu",
};
const REOPENS = "A new message opens it again.";

/**
 * The buttons of the reading column for a thing, in order. A decision is taken or declined, an act is
 * done, news is got, and none of them has a draft prepared ahead; `details` is the one that asks for a
 * draft. A reply, a wait or no stated intent keeps what it had, and has no primary: its draft's Send
 * is the one. A suspect thing closes with `Ignore`, never `Done`. `Not important` is always last.
 */
export function readerActions(thing: Thing): readonly ActionSpec[] {
  const closeAs = (spec: ActionSpec): ActionSpec =>
    thing.suspect === true
      ? { id: "ignore", label: "Ignore", hint: `Closes it. ${REOPENS}`, weight: spec.weight }
      : spec;
  switch (thing.intent) {
    case "decide":
      return [
        { id: "take", label: "I'll take it", hint: "Closes it as taken.", weight: "primary" },
        {
          id: "decline",
          label: "Not this year",
          hint: "Closes it, and keeps this offer closed until the year ends.",
          weight: "plain",
        },
        {
          id: "details",
          label: "Ask for details",
          hint: "The agent writes a draft asking for what would help you decide.",
          weight: "plain",
        },
        LATER,
        NOT_IMPORTANT,
      ];
    case "act":
      return [
        closeAs({
          id: "done",
          label: "Mark as done",
          hint: `Closes it. ${REOPENS}`,
          weight: "primary",
        }),
        LATER,
        NOT_IMPORTANT,
      ];
    case "know":
      return [
        closeAs({ id: "gotIt", label: "Got it", hint: `Closes it. ${REOPENS}`, weight: "primary" }),
        LATER,
        NOT_IMPORTANT,
      ];
    default:
      return [
        thing.suspect === true
          ? closeAs({ id: "noReply", label: "Ignore", hint: "", weight: "plain" })
          : {
              id: "noReply",
              label: "No reply needed",
              hint: `Nothing to answer here. Closes it. ${REOPENS}`,
              weight: "plain",
            },
        LATER,
        NOT_IMPORTANT,
      ];
  }
}

/** The small words above the agent's part of the reader: what the thing asks of the person. */
export function readerEyebrow(thing: Thing): string {
  switch (thing.intent) {
    case "decide":
      return "To decide";
    case "act":
      return "To do";
    case "know":
      return "Worth knowing";
    case "reply":
      return "Needs a reply";
    case "wait":
      return "Waiting on them";
    default:
      return "Needs you";
  }
}

/** The line under the buttons before any is pointed at: what the primary does, or nothing. */
export function defaultHint(actions: readonly ActionSpec[]): string {
  return actions.find((a) => a.weight === "primary")?.hint ?? "";
}

/** Whether the reader gives the thing its own bar of buttons instead of `Prepare now`. */
export function hasIntentBar(thing: Thing): boolean {
  return thing.intent === "decide" || thing.intent === "act" || thing.intent === "know";
}

/** The direction `Ask for details` gives the writing turn. */
export const ASK_FOR_DETAILS = "Ask for the details that would help decide";

const dueFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/**
 * The right-hand side of a row: how late, or when it is due. Empty when the facts give no date.
 * `late` selects the late colour; lateness is also in the words, so colour is never alone.
 */
export function dateOrLateness(thing: Thing): { readonly text: string; readonly late: boolean } {
  const days = thing.lateByDays;
  if (days !== undefined && days > 0) {
    return { text: days === 1 ? "1 day late" : `${days} days late`, late: true };
  }
  if (thing.dueMs !== undefined) {
    return { text: `Due ${dueFormat.format(new Date(thing.dueMs))}`, late: false };
  }
  return { text: "", late: false };
}

/** What the row of a series says about it (ADR 0061): `9 mails, newest 16 Sept`. Empty for no series. */
export function seriesLine(thing: Thing): string {
  const mails = thing.series?.mails;
  const newest = mails?.[0];
  if (mails === undefined || newest === undefined) return "";
  return `${mails.length} mails, newest ${dueFormat.format(new Date(newest.dateMs))}`;
}

/**
 * A series as the map of a matter draws it: one line per mail, newest first, with its date where a
 * person's name would be. Nothing holds up anything else, so it has no edges. Undefined: no series.
 */
export function seriesMap(
  thing: Thing,
): { readonly bundle: ThingBundle; readonly summary: string } | undefined {
  const series = thing.series;
  if (series === undefined) return undefined;
  return {
    bundle: {
      id: thing.threadId,
      name: series.name,
      members: series.mails.map((m) => ({
        threadId: m.threadId,
        who: dueFormat.format(new Date(m.dateMs)),
        headline: m.headline,
      })),
      edges: [],
    },
    summary: `Sent ${series.mails.length} times. This is about the newest; dealing with it deals with them all.`,
  };
}

/** The count in the tab: every thing there is, loaded or not. */
export function tabCount(count: number): string | undefined {
  return count === 0 ? undefined : String(count);
}

/** The list's rows and headings, in px. */
export const HEADING_HEIGHT = 34;
export const THING_ROW_HEIGHT = 68;

/** The list as drawn: `boundary` is how many rows are for now, and the rest's heading follows them. */
export interface DrawnList {
  readonly things: readonly Thing[];
  /** Zero or less: one part, with no heading in the middle. */
  readonly boundary: number;
}

function rowStart(row: number, boundary: number): number {
  const below = boundary > 0 && row >= boundary ? HEADING_HEIGHT : 0;
  return HEADING_HEIGHT + row * THING_ROW_HEIGHT + below;
}

function rowAtOffset(offset: number, boundary: number): number {
  const row = Math.floor(Math.max(0, offset - HEADING_HEIGHT) / THING_ROW_HEIGHT);
  if (boundary <= 0 || row < boundary) return row;
  return Math.max(boundary, Math.floor((offset - 2 * HEADING_HEIGHT) / THING_ROW_HEIGHT));
}

/**
 * Where to scroll when the list changes, so that what the person is looking at stays where it is:
 * the row at the top, or if that one is gone, the first one under it that is still there. The offset
 * is unchanged when nothing on screen or below it is left to hold on to.
 */
export function keptScroll(before: DrawnList, after: DrawnList, scrollTop: number): number {
  const top = rowAtOffset(scrollTop, before.boundary);
  for (let row = top; row < before.things.length; row++) {
    const id = before.things[row]?.threadId;
    const at = after.things.findIndex((t) => t.threadId === id);
    if (at >= 0) {
      return scrollTop + rowStart(at, after.boundary) - rowStart(row, before.boundary);
    }
  }
  return scrollTop;
}

/** Where a row stood when the person acted, and on which side of the heading (ADR 0062). */
export interface HeldRow {
  readonly threadId: string;
  readonly now: boolean;
}

function asHeld(thing: Thing, now: boolean): Thing {
  if ((thing.now === true) === now) return thing;
  const { now: _now, ...rest } = thing;
  return now ? { ...rest, now: true } : rest;
}

/**
 * The list the person is working through, after a new one came (ADR 0062). Rows that were there keep
 * their order and their section, whatever the ranking says now. A new row goes after the row the
 * ranking puts before it. `held` also keeps the rows that left, in their place, so that an Undo puts
 * one back where it was.
 */
export function holdList(
  next: readonly Thing[],
  held: readonly HeldRow[],
): { readonly things: readonly Thing[]; readonly held: readonly HeldRow[] } {
  const at = new Map(held.map((r, i) => [r.threadId, i]));
  const placed = next
    .filter((t) => at.has(t.threadId))
    .sort((a, b) => (at.get(a.threadId) as number) - (at.get(b.threadId) as number))
    .map((t) => asHeld(t, held[at.get(t.threadId) as number]?.now === true));
  next.forEach((t, i) => {
    if (at.has(t.threadId)) return;
    const before = next[i - 1]?.threadId;
    const to = before === undefined ? 0 : placed.findIndex((p) => p.threadId === before) + 1;
    placed.splice(to, 0, t);
  });
  const things = [...placed.filter((t) => t.now === true), ...placed.filter((t) => t.now !== true)];
  const rows: HeldRow[] = things.map((t) => ({ threadId: t.threadId, now: t.now === true }));
  const listed = new Set(rows.map((r) => r.threadId));
  held.forEach((r, i) => {
    if (listed.has(r.threadId)) return;
    const before = held[i - 1]?.threadId;
    rows.splice(before === undefined ? 0 : rows.findIndex((x) => x.threadId === before) + 1, 0, r);
  });
  return { things, held: rows };
}

/**
 * What the reader says while a thing has nothing prepared. Only the best few are drafted ahead, and
 * not while drafting is off or paused, so anything else must not claim that work is under way.
 */
export function notPreparedLine(busy: boolean, rank: number, status: AgentStatus | null): string {
  if (busy) return "The agent is writing this.";
  const ahead =
    rank >= 0 &&
    rank < DRAFTED_AHEAD &&
    status?.settings.models.draftAhead !== "off" &&
    status?.progress.state !== "paused";
  return ahead ? "The agent is preparing this." : "Not prepared yet.";
}

export interface MattersTab {
  /** The small figure after the name: `12/214` while reading, else the count. Absent: none. */
  readonly badge: string | undefined;
  /** What is added to the tab's name for a screen reader. Empty: nothing. */
  readonly spoken: string;
}

const thingsText = (n: number) => `${n} ${n === 1 ? "thing" : "things"}`;
const threadsText = (n: number) => `${n} ${n === 1 ? "thread" : "threads"}`;

/**
 * What the Matters tab shows (ADR 0053, rule 7). While reading it is how far the reading is, so
 * that the person can be in All mail and still see it move; otherwise the number of things.
 */
export function mattersTab(shown: number, progress: ReadingProgress | undefined): MattersTab {
  const count = tabCount(shown);
  if (progress?.state === "reading" && progress.total > 0) {
    const found = count === undefined ? "" : `, ${thingsText(Number(count))} found`;
    return {
      badge: `${progress.done}/${progress.total}`,
      spoken: `, reading ${progress.done} of ${threadsText(progress.total)}${found}`,
    };
  }
  return { badge: count, spoken: count === undefined ? "" : `, ${thingsText(Number(count))}` };
}

// --- The list's own words ---

/** Under the rows while a reading runs. The reader says the rest. */
export const MORE_COMING = "More will appear here as I read.";
/** Under the rows while the person's pause holds. */
export const PAUSED_LINE = "Reading is paused.";

/**
 * The one short line under the rows (ADR 0053, rule 4): that more will come while a reading
 * runs, or that it is paused by the person. Only with rows; with none the reader explains and the
 * list says nothing. "Nothing here." is never said in Matters.
 */
export function listNote(
  shown: number,
  progress: ReadingProgress | undefined,
): "more" | "paused" | null {
  if (shown === 0 || progress === undefined) return null;
  if (progress.state === "reading") return "more";
  if (progress.state === "paused" && progress.reason === "pausedByPerson") return "paused";
  return null;
}

/** The footer's words during a reading: "Reading last 30 days · 84 of 214". */
export function readingFooter(status: AgentStatus | null): string | null {
  const p = status?.progress;
  if (!status || !p || p.state !== "reading") return null;
  return `Reading last ${status.settings.windowDays} days · ${p.done} of ${p.total}`;
}

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
 * paused. The session is the window that decides what can run now.
 */
export function planButton(status: AgentStatus, now: number): PlanButton {
  const name = status.runtime?.name ?? "Agent";
  const p = status.progress;
  if (p.state === "paused") {
    const until = p.untilMs === undefined ? "" : ` until ${resetText(p.untilMs, now)}`;
    const why = p.reason === "limit" || p.reason === "sessionLimit" || p.reason === "weekLimit";
    return { text: `Paused${until}${why ? " · plan limit" : pausedWhy(p.reason)}`, late: true };
  }
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

/** The program's shorter name in a sentence that says where mail goes: `Claude`. */
export function vendorName(runtime: AgentRuntimeInfo | null): string {
  if (runtime?.id === "claude-code") return "Claude";
  return runtime?.name ?? "the assistant";
}

/** "Matters this week: about 4% of Claude". The share is of the plan's week, as counted by us. */
export function ourShare(status: AgentStatus): string {
  const used = status.settings.usedByUsPercent;
  const about = used < 1 ? "less than 1%" : `about ${Math.round(used)}%`;
  return `Matters this week: ${about} of ${vendorName(status.runtime)}`;
}

/** The model that writes what the person asks for, shown on the chip. */
export function writingModel(models: AgentModels): string {
  return modelName(models.write);
}

/** The model that wrote a draft: the one used for drafts ahead, or the writer when that is off. */
export function writtenByLine(
  runtime: AgentRuntimeInfo | null,
  models: AgentModels,
  asked: boolean,
): string {
  const model = asked || models.draftAhead === "off" ? models.write : models.draftAhead;
  return `${runtime?.name ?? "Agent"}, ${modelName(model)}, your plan`;
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

/** The directions the digit keys pick: `1` to `3`. */
export function directionOf(work: PreparedWork | undefined, digit: string): string | undefined {
  if (work?.kind !== "needs" || !/^[1-9]$/.test(digit)) return undefined;
  return work.directions[Number(digit) - 1];
}

// --- The reading screen (ADR 0053, rule 4) ---

/** The windows `Read further back` goes through, in days. */
export const WINDOW_STEPS: readonly number[] = [30, 90];

/** The next window after `days`, or `undefined` when there is none further back. */
export function nextWindow(days: number): number | undefined {
  return WINDOW_STEPS.find((d) => d > days);
}

/** The command to run in Terminal for a runtime that is signed out (ADR 0051, rule 2). */
export const SIGN_IN_COMMAND = "claude auth login";

export type ReadingAction =
  | "pause"
  | "resume"
  | "openAllMail"
  | "openSettings"
  | "copy"
  | "lookAgain"
  | "tryAgain"
  | "readFurtherBack";

export type ReadingKind =
  | "checking"
  | "reading"
  | "pausedByPerson"
  | "pausedByPlan"
  | "signedOut"
  | "missing"
  | "failed"
  | "windowEmpty"
  | "finished"
  | "noAccount";

export interface ReadingScreen {
  readonly kind: ReadingKind;
  readonly title: string;
  /** Plain sentences under the title, in order. Shown as text, never as markup. */
  readonly lines: readonly string[];
  readonly actions: readonly ReadingAction[];
  /** The command the person copies, when the screen is about signing in. */
  readonly command?: string;
  /**
   * The ring: how far the reading is from 0 to 1, or `null` when there is no measure and the
   * ring only breathes. Absent: no ring.
   */
  readonly ring: number | null;
}

/** `found 2 things so far`. */
export function foundText(found: number): string {
  if (found <= 0) return "found nothing yet";
  return `found ${thingsText(found)} so far`;
}

/** `About 8 minutes left`. From the time the reading measured, rounded the way a person says it. */
export function etaText(etaMs: number): string {
  const minutes = etaMs / 60_000;
  if (minutes < 1) return "Less than a minute left";
  if (minutes < 90) {
    const m = Math.max(1, Math.round(minutes));
    return `About ${m} ${m === 1 ? "minute" : "minutes"} left`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `About ${hours} hours left`;
  return "More than a day left";
}

/** `94% of your session left`, or nothing while the windows are not known. */
export function sessionLeftText(limits: PlanLimits | undefined, now: number): string {
  const left = percentLeft(limits?.session, now);
  return left === undefined ? "" : `${left}% of your session left`;
}

/** The time line of a reading: the measured time, or that it is being estimated, and the plan. */
export function timeLine(status: AgentStatus, now: number): string {
  const p = status.progress;
  const time = p.etaMs === undefined ? "Estimating time left" : etaText(p.etaMs);
  const plan = sessionLeftText(status.settings.limits, now);
  return plan === "" ? time : `${time} · ${plan}`;
}

function progressLine(p: ReadingProgress): string {
  return `Read ${p.done} of ${threadsText(p.total)} · ${foundText(p.found ?? 0)}`;
}

function planWords(status: AgentStatus): string {
  const p = status.progress;
  const vendor = vendorName(status.runtime);
  switch (p.reason) {
    case "sessionLimit":
    case "limit":
      return `The session limit of your ${vendor} plan is reached.`;
    case "weekLimit":
      return `The weekly limit of your ${vendor} plan is reached.`;
    case "overage":
      return `Your ${vendor} plan's own allowance is used up. I don't read on extra usage.`;
    case "budget":
      return `I have used my share of your plan's week (${status.settings.weekSharePercent}%). You can raise it in Settings.`;
    default:
      return `Your ${vendor} plan has no room for reading right now.`;
  }
}

/**
 * What the reader says while no thing is open (ADR 0053, rule 4), as data: the state in full
 * sentences and the actions that go with it. `null`: nothing to say yet (AI off, or no status).
 * Pure; the page only draws it.
 */
export function readingScreen(status: AgentStatus | null, now: number): ReadingScreen | null {
  if (status === null || !status.settings.enabled) return null;
  const p = status.progress;
  const name = status.runtime?.name ?? "the assistant";
  const days = status.settings.windowDays;
  const fraction = p.total > 0 ? Math.min(1, p.done / p.total) : 0;

  const signIn = (title: string, lead: string): ReadingScreen => ({
    kind: "signedOut",
    title,
    lines: [
      lead,
      "This app never signs in for you and never sees your login. Run this in Terminal:",
    ],
    actions: ["copy", "lookAgain"],
    command: SIGN_IN_COMMAND,
    ring: null,
  });

  switch (p.state) {
    case "checking":
      return {
        kind: "checking",
        title: `Checking ${name}`,
        lines: ["Making sure it works before it reads any mail."],
        actions: [],
        ring: null,
      };
    case "reading":
      return {
        kind: "reading",
        title: `Reading your last ${days} days`,
        lines: [
          progressLine(p),
          timeLine(status, now),
          "You can keep using your mail. I'll show things here as I find them.",
        ],
        actions: ["pause", "openAllMail"],
        ring: fraction,
      };
    case "paused": {
      if (p.reason === "pausedByPerson") {
        return {
          kind: "pausedByPerson",
          title: "Paused",
          lines: [progressLine(p), "Nothing more is read until you continue."],
          actions: ["resume", "openAllMail"],
          ring: fraction,
        };
      }
      if (p.reason === "signedOut")
        return signIn(`${name} is not signed in`, `${name} is on this Mac but not signed in.`);
      if (p.reason === "notPlan") {
        return signIn(
          `${name} is not using your Claude plan`,
          `${name} is signed in, but not with a Claude plan.`,
        );
      }
      return {
        kind: "pausedByPlan",
        title: p.untilMs === undefined ? "Paused" : `Paused until ${resetText(p.untilMs, now)}`,
        lines: [planWords(status), progressLine(p)],
        actions: ["openSettings"],
        ring: fraction,
      };
    }
    case "off": {
      if (p.reason === "consent") {
        return {
          kind: "noAccount",
          title: "No account is set to be read",
          lines: ["Choose which accounts the assistant may read in Settings."],
          actions: ["openSettings"],
          ring: null,
        };
      }
      if (p.reason === "disabled") return null;
      const state = status.runtime?.status;
      if (p.reason === "signedOut" || state === "signedOut") {
        return signIn(`${name} is not signed in`, `${name} is on this Mac but not signed in.`);
      }
      if (state === "missing") {
        return {
          kind: "missing",
          title: `${name} was not found`,
          lines: [
            "Install it from its own documentation, then sign in. This app never signs in for you. Run this in Terminal:",
          ],
          actions: ["copy", "lookAgain"],
          command: SIGN_IN_COMMAND,
          ring: null,
        };
      }
      return {
        kind: "failed",
        title: `${name} did not pass its check`,
        lines: [p.problem ?? status.runtime?.problem ?? "The check did not pass."],
        actions: ["tryAgain"],
        ring: null,
      };
    }
    case "idle": {
      if (p.windowEmpty === true) {
        return {
          kind: "windowEmpty",
          title: `Nothing to read in the last ${days} days`,
          lines: ["No thread in this window has mail that needs reading."],
          actions: nextWindow(days) === undefined ? [] : ["readFurtherBack"],
          ring: null,
        };
      }
      if ((p.found ?? 0) > 0) return null;
      return {
        kind: "finished",
        title:
          p.done === p.total
            ? `Read ${threadsText(p.done)}. Nothing needs you right now.`
            : `Read ${p.done} of ${threadsText(p.total)}. Nothing needs you right now.`,
        lines: [`From the last ${days} days. New mail is read as it arrives.`],
        actions: [],
        ring: 1,
      };
    }
  }
}

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

/** One choice under "Not like this…" (ADR 0068, rule 3). */
export type NotLikeThis =
  | { readonly id: "category"; readonly label: string; readonly category: ThreadCategory }
  | { readonly id: "sender"; readonly label: string };

/**
 * The choices of "Not like this…" for a thing, for every intent: not this kind of mail, when the
 * reading named one; not mail from this sender; and a few words of the person's own, which the page
 * adds as a standing instruction (that choice is always there and is not listed here).
 */
export function notLikeThisChoices(thing: Thing): readonly NotLikeThis[] {
  const out: NotLikeThis[] = [];
  const kind = thing.category;
  if (kind !== undefined && kind !== "other") {
    out.push({ id: "category", label: `Don't show ${CATEGORY_WORDS[kind]}`, category: kind });
  }
  if (thing.who.trim() !== "")
    out.push({ id: "sender", label: `Don't show mail from ${thing.who}` });
  return out;
}

/** The honest line under the text box of "Not like this…". */
export const NOT_LIKE_THIS_LATER = "Applies to mail read from now on.";

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
