// A theme from a description (ADR 0134, rules 12 to 16), the page's side: who makes it, whether
// it can be made now, and the one retry. The backend runs the turn and hands back text; main is
// the only judge of that text, through `addTheme` and the check every theme passes (rule 12). Kept
// apart from the section so the loop can be tested without a window.
import type { ThemeAddAnswer, ThemeProblem } from "@matters/contracts";
import type { AgentStatus, ThemeInput } from "@matters/core";
import { kindInfo, MAX_THEME_PROBLEM_CHARS, MAX_THEME_PROBLEMS } from "@matters/core";
import { answeredByLine, statusWords } from "./agentText.ts";

/** Whether the agent can make a theme now, and the line that says who would, or what is missing. */
export type ThemeMaker =
  | { readonly ready: true; readonly by: string }
  | { readonly ready: false; readonly why: string };

const WHERE = "in Settings › Agents";

/**
 * Who makes a theme (rule 16): the runtime and model of the kind `appearance`, or, when it cannot
 * be asked now, what is missing and where to fix it, as the other kinds say it. No account is
 * looked at: no mail goes with this work (rule 14). A runtime found but not checked yet is offered:
 * the turn checks it first, with a made-up message, as every turn the person asks for does.
 */
export function themeMaker(status: AgentStatus | null): ThemeMaker {
  if (status === null) return { ready: false, why: "Looking at the agent…" };
  if (!status.settings.enabled) {
    return { ready: false, why: `AI is off. Turn it on ${WHERE} to make a theme from words.` };
  }
  const id = status.settings.kindRuntime.appearance;
  if (id === undefined) {
    return { ready: false, why: `Choose who makes themes ${WHERE}.` };
  }
  const info = kindInfo(status, "appearance");
  const name = info?.name ?? status.runtimes.find((r) => r.id === id)?.name ?? id;
  const model = status.settings.models.appearance;
  if (status.unlisted.includes("appearance")) {
    return {
      ready: false,
      why: `${model} is not available on ${name} now. Choose another model for appearance ${WHERE}.`,
    };
  }
  if (info !== null && info.status !== "ready" && info.status !== "found") {
    return {
      ready: false,
      why: `${name} is ${statusWords(info).toLowerCase()}. Check it ${WHERE}.`,
    };
  }
  return { ready: true, by: `Made by ${answeredByLine(name, model)}.` };
}

/** What became of one ask. */
export type ThemeMade =
  /** Main kept it and put it on; `tries` is 2 when the first answer was refused. */
  | {
      readonly kind: "added";
      readonly answer: Extract<ThemeAddAnswer, { ok: true }>;
      readonly tries: 1 | 2;
    }
  /** Refused twice (rule 15): these are the problems of the second answer; nothing was added. */
  | { readonly kind: "refused"; readonly problems: readonly ThemeProblem[] }
  /** The turn did not give a theme, or main could not keep it: a sentence for the person. */
  | { readonly kind: "failed"; readonly message: string }
  /** The person stopped it; nothing was added. */
  | { readonly kind: "stopped" };

export interface ThemeMakingDeps {
  /** The backend's turn (`agentMakeTheme`): the theme's text, or an error with a sentence. */
  make(input: ThemeInput): Promise<string>;
  /** Main's check, the one every theme passes: kept and on, or refused with every reason. */
  add(text: string): Promise<ThemeAddAnswer | null>;
  /** The person pressed Cancel. */
  stopped(): boolean;
}

const KEEP_FAILED = "That theme could not be kept. Try again.";
const FAILED = "The assistant could not make a theme. Try again.";

/** The problems as words for the second ask, within what the request carries. */
function problemWords(problems: readonly ThemeProblem[]): string[] {
  return problems
    .slice(0, MAX_THEME_PROBLEMS)
    .map((p) => p.message.slice(0, MAX_THEME_PROBLEM_CHARS))
    .filter((m) => m !== "");
}

/**
 * Asks for a theme, hands the answer to main, and when main refuses it asks once more with the
 * answer and what failed (rule 15). A second refusal ends it: the person is shown the problems,
 * and nothing is added. Nothing is retried after a turn that failed, and never elsewhere: the
 * backend runs each ask on the kind's own runtime.
 */
export async function makeTheme(deps: ThemeMakingDeps, input: ThemeInput): Promise<ThemeMade> {
  let retry: ThemeInput["retry"];
  for (const tries of [1, 2] as const) {
    let text: string;
    try {
      text = await deps.make({ ...input, ...(retry === undefined ? {} : { retry }) });
    } catch (error) {
      if (deps.stopped()) return { kind: "stopped" };
      return { kind: "failed", message: error instanceof Error ? error.message : FAILED };
    }
    if (deps.stopped()) return { kind: "stopped" };
    const answer = await deps.add(text);
    if (answer === null) return { kind: "failed", message: KEEP_FAILED };
    if (answer.ok) return { kind: "added", answer, tries };
    if (tries === 2) return { kind: "refused", problems: answer.problems };
    retry = { previous: text, problems: problemWords(answer.problems) };
  }
  return { kind: "failed", message: FAILED };
}
