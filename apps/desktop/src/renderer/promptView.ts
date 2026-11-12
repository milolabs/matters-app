// A prompt is a filter (ADR 0116): what the page says about the prompt in the query bar. Pure: the
// state comes from promptRun.ts, the words are the app's own and hold no mail.
import {
  type AgentStatus,
  type ParsedQuery,
  PROMPT_ASK_ABOVE,
  type PromptCount,
  type PromptPhase,
  type PromptStep,
  type QueryDiagnostic,
} from "@matters/core";

/** Why a prompt does nothing now (rule 11), or null while it can be read. */
export type PromptOff = "off" | "noConsent";

/**
 * From the same state that decides whether Matters is there: AI is off, or the status says no
 * account is shared with the runtime for understanding mail, which reads for a prompt (ADR 0121,
 * rule 9). A status not read yet says nothing more.
 */
export function promptOff(enabled: boolean, status: AgentStatus | null): PromptOff | null {
  if (!enabled) return "off";
  if (status === null) return null;
  const runtime = status.settings.kindRuntime.understand;
  return status.consents.some((c) => c.runtimeId === runtime) ? null : "noConsent";
}

/** The parser's diagnostic for a prompt while AI is off, in words that say where to turn it on. */
export function promptOffText(why: PromptOff): string {
  return why === "off"
    ? "AI is off, so the prompt does nothing. Turn it on in Settings › Agents."
    : "No account is shared with the assistant, so the prompt does nothing. Choose accounts in Settings › Agents.";
}

/** `parsed` with the `prompt-off` diagnostic put in the app's words (rule 11). */
export function withPromptOffText(parsed: ParsedQuery, why: PromptOff | null): ParsedQuery {
  if (why === null || !parsed.diagnostics.some((d) => d.code === "prompt-off")) return parsed;
  const message = promptOffText(why);
  return {
    ...parsed,
    diagnostics: parsed.diagnostics.map(
      (d): QueryDiagnostic => (d.code === "prompt-off" ? { ...d, message } : d),
    ),
  };
}

/** A count as the app writes it: `1,240`. */
const num = (n: number) => n.toLocaleString("en-US");
const threads = (n: number) => `${num(n)} ${n === 1 ? "thread" : "threads"}`;

/**
 * Threads a run would read now, as the backend counted them (rule 4a): under a limit at most that
 * many, as the run stops once the limit's worth fit. An answer without it: found less read.
 */
export function toReadOf(count: Pick<PromptCount, "found" | "read" | "toRead">): number {
  return count.toRead ?? Math.max(count.found - count.read, 0);
}

/**
 * Whether `↵` now asks for more than `PROMPT_ASK_ABOVE` to be read (rule 4): nothing of it is read
 * yet, so the number is a question, not a progress. Never under a limit: it is the person's own
 * bound (rule 4a).
 */
export function asksToRead(count: PromptCount): boolean {
  return (
    count.searched &&
    count.limit === undefined &&
    count.read === 0 &&
    toReadOf(count) > PROMPT_ASK_ABOVE
  );
}

/** What the run ended with, when that needs saying: a fixed sentence, and whether to offer again. */
export interface PromptOutcome {
  readonly problem?: string;
  /** Batches whose answer the code did not accept (rule 6): their threads stay unread. */
  readonly rejected: number;
  /** The run itself was refused or failed: trying again may help. */
  readonly failed?: boolean;
}

/** How far a run is, as the page knows it (rule 9). */
export interface PromptProgressShown {
  readonly phase: PromptPhase;
  readonly done: number;
  readonly total: number;
  readonly step?: PromptStep;
  /** Under a limit: the threads that fit so far (rule 4a). */
  readonly fits?: number;
}

/** The one quiet line under the bar while the query holds a prompt (rules 4 and 9). */
export type PromptLine =
  | { readonly kind: "searching"; readonly text: string; readonly stopping: boolean }
  | { readonly kind: "reading"; readonly text: string; readonly stopping: boolean }
  /** Not searched yet with these mail filters: the whole line is the `↵` that searches. */
  | { readonly kind: "ready"; readonly text: string }
  /** The search found more than `PROMPT_ASK_ABOVE` and nothing is read: `↵` reads them all. */
  | { readonly kind: "ask"; readonly text: string; readonly key: string }
  /** Searched, and threads it finds have no verdict yet: `↵` reads them. */
  | { readonly kind: "count"; readonly text: string }
  /**
   * Every thread found is read: how many fit, and `Search again` unless no search ran (`whole`:
   * the mail filters alone were read).
   */
  | { readonly kind: "allRead"; readonly text: string; readonly whole: boolean }
  /** The search found nothing: `Search again`. */
  | { readonly kind: "none"; readonly text: string }
  | { readonly kind: "problem"; readonly text: string; readonly retry: boolean };

export const STOPPING = "Stopping…";
export const SEARCHING = "Searching…";
export const SOME_REJECTED = "Some threads could not be read.";
/** Before a run (rule 4): nothing is known of the mail yet. The line is the key itself. */
export const READY = "↵ to search your mail with this prompt.";
/** What the `↵` of a question above `PROMPT_ASK_ABOVE` says beside the count. */
export const READ_ALL = "↵ to read them all.";
/** After the fits of a reading that stopped at the person's own `limit:` (rule 4a). */
export const AT_LIMIT = "Stopped at your limit.";
export const FOUND_NOTHING = "The search found nothing for this prompt.";
/** The list under a prompt when nothing it read fits (rule 7). */
export const NOTHING_FITS = "No thread fits this prompt.";

/**
 * How far a reading is: `Reading 12 of 37 threads…`. Under a limit what counts is how many fit,
 * not how many are read (rule 4a): `Reading… 4 of 10 found`.
 */
export function readingText(
  done: number,
  total: number,
  limit?: { readonly fits: number; readonly limit: number },
): string {
  if (limit !== undefined) {
    return `Reading… ${num(Math.min(limit.fits, limit.limit))} of ${num(limit.limit)} found`;
  }
  // Before the run has said how many it reads.
  if (total === 0) return "Reading…";
  return `Reading ${num(Math.min(done, total))} of ${threads(total)}…`;
}

/** The search's last true step, a query that ran (rule 4): `Searched: invoice 2023 → 12 threads`. */
export function searchingText(step: PromptStep | undefined): string {
  return step === undefined ? SEARCHING : `Searched: ${step.query} → ${threads(step.threads)}`;
}

/** The end of a run: `3 of 12 threads fit.` */
export function fitText(fits: number, read: number): string {
  return `${num(fits)} of ${threads(read)} ${fits === 1 ? "fits" : "fit"}.`;
}

/** A reading that stopped at the limit (rule 4a): `10 threads fit. Stopped at your limit.` */
export function limitText(fits: number): string {
  return `${threads(fits)} ${fits === 1 ? "fits" : "fit"}. ${AT_LIMIT}`;
}

/**
 * What `↵` reads under a limit (rule 4a): `10 to find among 1,240 threads.`; with some found
 * already, `3 more to find…`. With the limit's worth found and unread threads before them (by
 * date: new mail, or what is newer or older than the last of them), those:
 * `1,924 threads to read to be sure of these 10.` One `↵` reads at most `PROMPT_ASK_ABOVE`.
 */
export function toFindText(limit: number, fits: number, todo: number): string {
  if (fits >= limit) return `${threads(todo)} to read to be sure of these ${num(limit)}.`;
  const more = fits === 0 ? num(limit) : `${num(limit - fits)} more`;
  return `${more} to find among ${threads(todo)}.`;
}

/** The question above `PROMPT_ASK_ABOVE`: `Found 1,240 threads.` beside `↵ to read them all.` */
export function foundText(n: number): string {
  return `Found ${threads(n)}.`;
}

/**
 * The line for a prompt: a run going on, how it ended, or what a run would do. Null while
 * nothing is known yet or AI is off: the diagnostic says that.
 */
export function promptLine(state: {
  readonly count: PromptCount | null;
  readonly progress: PromptProgressShown | null;
  readonly stopping: boolean;
  readonly outcome: PromptOutcome | null;
}): PromptLine | null {
  const { count, progress, outcome } = state;
  if (progress !== null) {
    const stopping = state.stopping;
    return progress.phase === "searching"
      ? { kind: "searching", text: stopping ? STOPPING : searchingText(progress.step), stopping }
      : {
          kind: "reading",
          text: stopping
            ? STOPPING
            : readingText(
                progress.done,
                progress.total,
                count?.limit === undefined
                  ? undefined
                  : { fits: progress.fits ?? count.fits, limit: count.limit },
              ),
          stopping,
        };
  }
  if (outcome?.problem !== undefined) {
    return {
      kind: "problem",
      text: outcome.problem,
      retry: outcome.failed === true || outcome.rejected > 0,
    };
  }
  if (outcome !== null && outcome.rejected > 0) {
    return { kind: "problem", text: SOME_REJECTED, retry: true };
  }
  if (count === null || count.ai === "off") return null;
  if (!count.searched) return { kind: "ready", text: READY };
  if (count.found === 0) return { kind: "none", text: FOUND_NOTHING };
  const todo = toReadOf(count);
  if (todo === 0) {
    return {
      kind: "allRead",
      text:
        count.limit !== undefined && count.fits >= count.limit
          ? limitText(count.fits)
          : fitText(count.fits, count.read),
      whole: count.whole === true,
    };
  }
  if (asksToRead(count)) return { kind: "ask", text: foundText(todo), key: READ_ALL };
  if (count.limit !== undefined) {
    return { kind: "count", text: toFindText(count.limit, count.fits, todo) };
  }
  const read = count.read > 0 ? `, ${num(count.read)} read already` : "";
  return { kind: "count", text: `${threads(todo)} to read${read}.` };
}
