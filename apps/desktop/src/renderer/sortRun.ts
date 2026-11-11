// A ranked order without a prompt (ADR 0116, rule 4b): `sort:relevance` is computed over a
// bounded pool in the sync worker, only after `↵`. While typing the list stays
// the dated one; editing the text after a ranked order was shown goes back to it. Nothing here is
// on the keystroke path: the text is only noted, and every answer for older text is dropped.
import type { Message, ParsedQuery, SortRanked } from "@matters/core";
import { batch, createSignal } from "solid-js";
import type { Backend } from "./client.ts";

/** After the last `changes` event, before the shown order is computed again. */
export const RERANK_QUIET_MS = 1500;

export type SortBackend = Pick<Backend, "sortRanked" | "onEvent">;

/** The ranked order a query asks for, if any: only without a prompt (rule 4b). */
export function rankedSortOf(parsed: Pick<ParsedQuery, "sort" | "prompt">): "relevance" | null {
  return parsed.prompt === undefined && parsed.sort?.value === "relevance" ? "relevance" : null;
}

const num = (n: number) => n.toLocaleString("en-US");

/** The quiet line under the bar while the text asks for a ranked order. */
export type SortLineState =
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "sorting"; readonly text: string }
  | { readonly kind: "sorted"; readonly text: string }
  | { readonly kind: "problem"; readonly text: string };

/** Before `↵`: the line is the key itself. */
export const SORT_READY = "↵ to sort by relevance.";
export const SORTING = "Sorting…";
export const SORT_FAILED = "Could not sort this list. Try again.";

/**
 * After `↵`, on one line of the narrow column: `Sorted by relevance.`, with the pool when it cut
 * the matches: `Sorted by relevance, newest 2,000 of 14,300.`
 */
export function sortedText(r: SortRanked): string {
  const of = `${num(r.pool)} of ${num(r.matches)}${r.more === true ? "+" : ""}`;
  return r.matches > r.pool ? `Sorted by relevance, newest ${of}.` : "Sorted by relevance.";
}

interface Options {
  readonly schedule?: (run: () => void, ms: number) => () => void;
  readonly quietMs?: number;
}

const realSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export function createSortRun(backend: SortBackend, options: Options = {}) {
  const schedule = options.schedule ?? realSchedule;
  const quietMs = options.quietMs ?? RERANK_QUIET_MS;
  const [text, setText] = createSignal("");
  const [sort, setSort] = createSignal<"relevance" | null>(null);
  const [rows, setRows] = createSignal<readonly Message[] | null>(null);
  const [result, setResult] = createSignal<SortRanked | null>(null);
  const [sorting, setSorting] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let gen = 0;
  let cancelChanges: (() => void) | null = null;

  /** The text in the bar changed: back to the dated list until `↵` (rule 4b). */
  function setQuery(next: string, mine: "relevance" | null) {
    if (next === text() && mine === sort()) return;
    gen++;
    cancelChanges?.();
    cancelChanges = null;
    batch(() => {
      setText(next);
      setSort(mine);
      setRows(null);
      setResult(null);
      setSorting(false);
      setFailed(false);
    });
  }

  /** `↵`: the ranked order of the text, computed in the worker. */
  async function run(): Promise<void> {
    if (sort() === null) return;
    const mine = ++gen;
    const q = text();
    batch(() => {
      setSorting(true);
      setFailed(false);
    });
    try {
      const r = await backend.sortRanked(q);
      if (mine !== gen) return;
      batch(() => {
        setSorting(false);
        setResult(r);
        setRows(r.sort === null ? null : r.rows);
      });
    } catch {
      if (mine !== gen) return;
      batch(() => {
        setSorting(false);
        setFailed(true);
      });
    }
  }

  const off = backend.onEvent((event) => {
    // Mail moved under a ranked list: it is computed again after a quiet moment, so new mail
    // takes its place in the order.
    if (event.type !== "changes" || rows() === null) return;
    cancelChanges?.();
    cancelChanges = schedule(() => {
      cancelChanges = null;
      if (rows() !== null) void run();
    }, quietMs);
  });

  /** The line for the text, or null when it asks for no ranked order. */
  function line(): SortLineState | null {
    if (sort() === null) return null;
    if (sorting()) return { kind: "sorting", text: SORTING };
    if (failed()) return { kind: "problem", text: SORT_FAILED };
    const r = result();
    if (r === null || r.sort === null) return { kind: "ready", text: SORT_READY };
    return { kind: "sorted", text: sortedText(r) };
  }

  return {
    text,
    /** The text asks for a ranked order. */
    has: () => sort() !== null,
    rows,
    result,
    line,
    setQuery,
    run,
    dispose() {
      off();
      cancelChanges?.();
    },
  };
}

export type SortRunStore = ReturnType<typeof createSortRun>;
