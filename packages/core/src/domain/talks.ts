// The talks across all mail (ADR 0086): where one ends, what it is called. Pure.

/** A question after this long a pause starts a new talk (rule 4). */
export const TALK_PAUSE_MS = 2 * 60 * 60 * 1000;

/** A title is never longer than this, from the model or from the first question (rules 6, 7). */
export const MAX_TALK_TITLE_CHARS = 60;

/** The questions of a talk the title turn sees (rule 6). */
export const TALK_TITLE_QUESTIONS = 3;

/** Who named a talk. Absent: nobody did, and it is named by its first question. */
export type TalkTitleBy = "model" | "person";

/** One talk across all mail, as the list of talks shows it. */
export interface TalkSummary {
  readonly id: number;
  readonly startedAtMs: number;
  /** The time of its last entry; `startedAtMs` while it has none. */
  readonly lastAtMs: number;
  /** The name the model or the person gave; absent while it has none. */
  readonly title?: string;
  readonly titleBy?: TalkTitleBy;
  /** The person's first words in it; empty while it has none. */
  readonly firstWords: string;
  readonly entries: number;
}

/** White space folded to one space, ends trimmed. */
function folded(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * At most `MAX_TALK_TITLE_CHARS`, cut at the last word boundary that fits, with `…` when cut. A
 * single word longer than that is cut where it has to be.
 */
export function cutTitle(text: string): string {
  const one = folded(text);
  if (one.length <= MAX_TALK_TITLE_CHARS) return one;
  const room = one.slice(0, MAX_TALK_TITLE_CHARS - 1);
  const space = room.lastIndexOf(" ");
  const kept = space >= MAX_TALK_TITLE_CHARS / 3 ? room.slice(0, space) : room;
  return `${kept.replace(/[\s,.;:–—-]+$/, "")}…`;
}

/** What the list calls a talk: its given name, else its first question, else `New talk`. */
export function talkTitle(talk: Pick<TalkSummary, "title" | "firstWords">): string {
  if (talk.title !== undefined && folded(talk.title) !== "") return cutTitle(talk.title);
  const first = cutTitle(talk.firstWords);
  return first === "" ? "New talk" : first;
}

/**
 * Whether the next question starts a new talk (rule 4): there is no open talk, or the open one has
 * entries and its last is older than the pause and the person did not choose it from the list.
 */
export function startsNewTalk(
  open: Pick<TalkSummary, "lastAtMs" | "entries"> | null,
  nowMs: number,
  chosen: boolean,
): boolean {
  if (open === null) return true;
  if (open.entries === 0 || chosen) return false;
  return nowMs - open.lastAtMs > TALK_PAUSE_MS;
}

/**
 * Talk numbers for entries in time order: a new talk wherever two entries are more than the pause
 * apart (rule 15). Index `i` of the result is the talk of `atMs[i]`, counting from 0.
 */
export function splitByPause(atMs: readonly number[]): number[] {
  const talks: number[] = [];
  let n = 0;
  for (let i = 0; i < atMs.length; i++) {
    const now = atMs[i] ?? 0;
    const before = atMs[i - 1];
    if (before !== undefined && now - before > TALK_PAUSE_MS) n++;
    talks.push(n);
  }
  return talks;
}

/** Where a talk sits in the list (rule 5), by the local day of its last entry. */
export type TalkGroup = "today" | "yesterday" | "week" | "earlier";

export const TALK_GROUP_LABELS: Readonly<Record<TalkGroup, string>> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  earlier: "Earlier",
};

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** `This week` is the five days before yesterday, so the groups never overlap. */
export function talkGroup(lastAtMs: number, nowMs: number): TalkGroup {
  const today = startOfDay(nowMs);
  const day = startOfDay(lastAtMs);
  if (day >= today) return "today";
  const yesterday = startOfDay(today - 12 * 60 * 60 * 1000);
  if (day >= yesterday) return "yesterday";
  let weekStart = yesterday;
  for (let i = 0; i < 5; i++) weekStart = startOfDay(weekStart - 12 * 60 * 60 * 1000);
  return day >= weekStart ? "week" : "earlier";
}
