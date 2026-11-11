import {
  type FileHit,
  foldText,
  type Message,
  type ParsedQuery,
  type PersonSuggestion,
  parseQuery,
} from "@matters/core";
import type { Backend } from "./client.ts";
import { hitWords } from "./hits.ts";

/**
 * ADR 0076. The live part of the search panel: what is asked while the person types, and how the
 * answers are cut down to the rows the panel shows. Pure but for the one `Backend` it is given.
 */
export const LIVE_THREADS = 4;
export const LIVE_PEOPLE = 2;
export const LIVE_FILES = 3;
/** Messages asked for, so that four distinct threads are likely in the first window. */
const THREAD_WINDOW = 24;
/** Words shorter than this (folded) are not worth a request on their own. */
export const LIVE_WORD_MIN = 2;

/** The free words of the query where they stand: plain words and phrases, not negated, not a field's value. */
export function freeSpans(
  text: string,
  parsed: ParsedQuery,
): { start: number; end: number; word: string }[] {
  const out: { start: number; end: number; word: string }[] = [];
  let negated = false;
  // Inside a negated group (`-(a b)`) nothing is free: depth counts the brackets left to close.
  let skipping = 0;
  for (const t of parsed.tokens) {
    if (skipping > 0) {
      if (t.kind === "open") skipping++;
      else if (t.kind === "close") skipping--;
      continue;
    }
    if (t.kind === "minus" || t.kind === "not") {
      negated = true;
      continue;
    }
    if (negated && t.kind === "open") {
      skipping = 1;
      negated = false;
      continue;
    }
    const isFree =
      (t.kind === "word" || t.kind === "phrase") &&
      t.field === undefined &&
      t.state !== "invalid" &&
      !negated;
    if (isFree) {
      out.push({
        start: t.start,
        end: t.end,
        word: text.slice(t.start, t.end).replace(/^"|"$/g, ""),
      });
    }
    if (t.kind !== "open" && t.kind !== "close") negated = false;
  }
  return out;
}

export const freeWords = (text: string, parsed: ParsedQuery): string[] =>
  freeSpans(text, parsed).map((s) => s.word);

/**
 * ADR 0077. The words a query asks to find, for marking them in the list and the reader: its free
 * words (never a field's value, an operator or something negated), folded and split the way the
 * search compares them, longest first, each once. Empty when the query has none.
 */
export function queryHitWords(text: string): string[] {
  if (text.trim() === "") return [];
  return hitWords(freeWords(text, parseQuery(text)));
}

/** Whether the words call for live results: one real word of two characters or more. */
export function wantsLive(words: readonly string[]): boolean {
  return hitWords(words).some((w) => [...w].length >= LIVE_WORD_MIN);
}

export interface ThreadRow {
  readonly threadId: string;
  readonly message: Message;
}

/** One row per thread, newest first: the newest matching message stands for its thread. */
export function threadRows(messages: readonly Message[], max = LIVE_THREADS): ThreadRow[] {
  const best = new Map<string, Message>();
  for (const m of messages) {
    const seen = best.get(m.threadId);
    if (seen === undefined || m.dateMs > seen.dateMs) best.set(m.threadId, m);
  }
  return [...best.values()]
    .sort((a, b) => b.dateMs - a.dateMs || b.key - a.key)
    .slice(0, max)
    .map((message) => ({ threadId: message.threadId, message }));
}

export interface PersonRow {
  readonly name?: string;
  readonly address: string;
  /** Messages with this person, as the people index counts them. */
  readonly messages?: number;
  /** Threads of the live result they wrote. */
  readonly threads?: number;
}

const wordsOf = (s: string) =>
  foldText(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Whether every typed word starts a word of the person's name or address. */
function fitsPerson(p: { name?: string; address: string }, words: readonly string[]): boolean {
  const have = wordsOf(`${p.name ?? ""} ${p.address}`);
  return words.length > 0 && words.every((w) => have.some((h) => h.startsWith(w)));
}

/**
 * People for the panel: the ones whose name or address matches the words, then the senders of the
 * matched threads. Never the reader's own addresses, each once, at most `max`.
 */
export function peopleRows(
  matched: readonly PersonSuggestion[],
  threads: readonly ThreadRow[],
  words: readonly string[],
  own: ReadonlySet<string>,
  max = LIVE_PEOPLE,
): PersonRow[] {
  const typed = hitWords(words);
  const out = new Map<string, PersonRow>();
  for (const p of matched) {
    const key = p.address.toLowerCase();
    if (own.has(key) || out.has(key) || !fitsPerson(p, typed)) continue;
    out.set(key, { name: p.name, address: p.address, messages: p.count });
  }
  const wrote = new Map<string, PersonRow>();
  for (const { message } of threads) {
    const p = message.from;
    const key = p.address.toLowerCase();
    if (own.has(key)) continue;
    const before = wrote.get(key);
    wrote.set(key, {
      name: before?.name ?? p.name,
      address: before?.address ?? p.address,
      threads: (before?.threads ?? 0) + 1,
    });
  }
  for (const [key, row] of wrote) {
    const have = out.get(key);
    if (have) out.set(key, { ...have, threads: row.threads });
    else out.set(key, row);
  }
  return [...out.values()].slice(0, max);
}

export interface LiveAnswer {
  /** The query text this answers. */
  readonly text: string;
  /** The free words the files and people were asked with. */
  readonly words: readonly string[];
  readonly threads: readonly ThreadRow[];
  readonly people: readonly PersonSuggestion[];
  readonly files: readonly FileHit[];
}

/** The three reads of one live result. A failed read is an empty one: the panel just has none. */
export async function askLive(
  backend: Pick<Backend, "search" | "suggestPeople" | "searchFiles">,
  text: string,
  words: readonly string[],
): Promise<LiveAnswer> {
  const typed = words.join(" ");
  const [found, people, files] = await Promise.all([
    backend.search({ query: text, limit: THREAD_WINDOW }).then(
      (r) => r.messages,
      () => [] as readonly Message[],
    ),
    backend.suggestPeople(typed, LIVE_PEOPLE * 3).then(
      (r) => r,
      () => [] as readonly PersonSuggestion[],
    ),
    backend.searchFiles(typed, LIVE_FILES).then(
      (r) => r,
      () => [] as readonly FileHit[],
    ),
  ]);
  return { text, words, threads: threadRows(found), people, files };
}

/**
 * One request at a time, and the latest wins. An ask made while one is in flight replaces any ask
 * waiting behind it; the answer in flight is dropped as stale, and when it lands the latest ask
 * goes out. An ask for the text already asked for changes nothing. A failed run is ignored.
 */
export function createCoalescer<T>(
  run: (text: string) => Promise<T>,
  onAnswer: (text: string, answer: T) => void,
) {
  let version = 0;
  let flying = false;
  let pending: string | null = null;
  let wanted: string | null = null;

  function pump(): void {
    if (flying || pending === null) return;
    const text = pending;
    pending = null;
    const mine = version;
    flying = true;
    const done = () => {
      flying = false;
      pump();
    };
    run(text).then((answer) => {
      if (mine === version) onAnswer(text, answer);
      done();
    }, done);
  }

  return {
    ask(text: string): void {
      if (text === wanted) return;
      wanted = text;
      version++;
      pending = text;
      pump();
    },
    /** Nothing in flight or waiting counts any more. */
    stop(): void {
      wanted = null;
      version++;
      pending = null;
    },
  };
}
