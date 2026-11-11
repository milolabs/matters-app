import type { MoveSummary } from "@matters/contracts";
import type { MoveKind } from "@matters/core";
import { describeMove } from "@matters/core";
import { createEffect, createSignal, onCleanup } from "solid-js";
import type { Backend } from "./client.ts";

/** One action in its undo window, as the tray draws it (ADR 0044, rule 10). */
export interface MoveLine {
  readonly id: string;
  readonly action: MoveKind;
  readonly place?: string;
  readonly count: number;
  /** The thread's subject, when this window did the move: the line says which mail it was. */
  readonly subject?: string;
  readonly notBeforeMs: number;
}

/** What the tray says of a move line. Pure, so the words are tested without a page. */
export interface MoveView {
  readonly line: string;
  readonly actions: readonly "undo"[];
  /** What a screen reader hears when the line appears: the result, never the countdown. */
  readonly announce: string;
}

export function describeLine(line: MoveLine, secondsLeft: number): MoveView {
  const text = describeMove(line.action, line.place);
  return { line: text, actions: secondsLeft > 0 ? ["undo"] : [], announce: text };
}

/** What the tray says when the server turned a move down for good (rule 15). */
export function refusedText(action: MoveKind): string {
  return action === "purge"
    ? "Couldn't delete: the server refused."
    : "Couldn't move: the server refused.";
}

/** How long a word under the lines stays when nobody dismisses it. */
const NOTICE_MS = 8000;

export const TOO_LATE = "Too late to undo: it has already gone to the server.";

/** A line that exists only here until the backend has answered with the id of the action. */
const isLocal = (id: string) => id.startsWith("local:");

/**
 * The moves in their undo window, kept current by pushes, and the words the tray has for the rest:
 * what could not be moved, what was already there, what came too late. A line is added the moment
 * a key is pressed and carries the backend's id as soon as it answers, so the tray confirms a move
 * even in a view where the row stays (All mail and Archive), and ⌘Z has something to take back.
 */
export function createMovesStore(backend: Backend, clock: () => number = Date.now) {
  const [remote, setRemote] = createSignal<readonly MoveSummary[]>([]);
  const [local, setLocal] = createSignal<readonly MoveLine[]>([]);
  // The subjects of lines this window made, by action id, for when the backend's summary arrives.
  const [subjects, setSubjects] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [nowMs, setNowMs] = createSignal(clock());
  const [notice, setNotice] = createSignal("");
  // Said to a screen reader through the live region, whatever the tray shows.
  const [announcement, setAnnouncement] = createSignal("");
  const answers = new Map<string, Promise<string | null>>();
  let counter = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  // The line objects are kept between reads while nothing they are made of changed: the tray keys
  // its rows by them, and a row that is made again starts its dot over.
  let cached:
    | {
        remote: readonly MoveSummary[];
        local: readonly MoveLine[];
        subjects: ReadonlyMap<string, string>;
        lines: readonly MoveLine[];
      }
    | undefined;

  /** The summaries of the backend, then the local lines it has not heard back about, oldest first. */
  function lines(): readonly MoveLine[] {
    const r = remote();
    const l = local();
    const known = subjects();
    if (cached && cached.remote === r && cached.local === l && cached.subjects === known) {
      return cached.lines;
    }
    const ids = new Set(r.map((x) => x.id));
    const fromBackend = r.map((x): MoveLine => {
      const subject = known.get(x.id);
      return {
        id: x.id,
        action: x.action,
        count: x.count,
        notBeforeMs: x.notBeforeMs,
        ...(x.place === undefined ? {} : { place: x.place }),
        ...(subject === undefined ? {} : { subject }),
      };
    });
    const out = [...fromBackend, ...l.filter((x) => !ids.has(x.id))].sort(
      (a, b) => a.notBeforeMs - b.notBeforeMs,
    );
    cached = { remote: r, local: l, subjects: known, lines: out };
    return out;
  }
  const pending = () => lines().filter((x) => x.notBeforeMs > nowMs());

  // The countdown needs a clock signal; it ticks only while some move waits.
  createEffect(() => {
    if (pending().length === 0) return;
    setNowMs(clock());
    const timer = setInterval(() => setNowMs(clock()), 250);
    onCleanup(() => clearInterval(timer));
  });

  backend.onEvent((event) => {
    if (event.type === "moves") {
      setRemote(event.operations);
      // A line the backend now lists, or one whose window is over, needs no local twin.
      const listed = new Set(event.operations.map((o) => o.id));
      setLocal((all) => all.filter((l) => !listed.has(l.id)));
    } else if (event.type === "moveRefused") {
      say(refusedText(event.action));
    }
  });

  function say(text: string) {
    setNotice(text);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => setNotice((n) => (n === text ? "" : n)), NOTICE_MS);
    // The same words twice in a row must be heard twice: clear, then set.
    setAnnouncement("");
    queueMicrotask(() => setAnnouncement(text));
  }

  return {
    /** Every line in its window, oldest first. */
    pending,
    /** The action ⌘Z takes back: the one made last. */
    latestPending: () => pending().at(-1),
    /** Whole seconds left of the undo window; 0 when it is over. */
    secondsLeft: (line: MoveLine) => Math.max(0, Math.ceil((line.notBeforeMs - nowMs()) / 1000)),
    /** Words under the lines that are not about one of them; empty when there are none. */
    notice,
    announcement,
    dismissNotice: () => setNotice(""),
    say,
    /**
     * A move was asked for: the line appears now, before the backend has answered. Returns the
     * function to call with the backend's answer (the action id, or null when nothing moved).
     */
    begin(line: Omit<MoveLine, "id" | "notBeforeMs">, windowMs: number) {
      const id = `local:${++counter}`;
      const entry: MoveLine = { ...line, id, notBeforeMs: clock() + windowMs };
      setNowMs(clock());
      setLocal((all) => [...all, entry]);
      let settle!: (operationId: string | null) => void;
      answers.set(
        id,
        new Promise<string | null>((resolve) => {
          settle = resolve;
        }),
      );
      setAnnouncement(describeMove(line.action, line.place));
      return (operationId: string | null) => {
        settle(operationId);
        if (operationId === null) {
          setLocal((all) => all.filter((l) => l.id !== id));
          return;
        }
        if (line.subject !== undefined) {
          const subject = line.subject;
          setSubjects((m) => new Map(m).set(operationId, subject));
        }
        setLocal((all) => all.map((l) => (l.id === id ? { ...l, id: operationId } : l)));
        answers.delete(id);
      };
    },
    /** The backend's id of a line, waiting for its answer if it has not come yet. */
    async idOf(line: MoveLine): Promise<string | null> {
      return isLocal(line.id) ? ((await answers.get(line.id)) ?? null) : line.id;
    },
    /** The line goes now, whatever the answer: the move was undone or refused. */
    forget(id: string) {
      setLocal((all) => all.filter((l) => l.id !== id));
      setRemote((all) => all.filter((r) => r.id !== id));
    },
  };
}

export type MovesStore = ReturnType<typeof createMovesStore>;

/** Used where a store is made without a tray (tests of the list). */
export const NO_MOVES = {
  begin: () => () => {},
  say: () => {},
  forget: () => {},
} as unknown as Pick<MovesStore, "begin" | "say" | "forget">;
