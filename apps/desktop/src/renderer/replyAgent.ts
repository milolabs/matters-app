// What the editor asks of the agent (ADR 0098, 0132). The editor holds the text; this only carries
// it to the backend and back. Nothing here sends or saves: a result is offered, and the writer keeps
// it or undoes it.
import type { GapSuggestion } from "./liveMarkdown.ts";

export type RewriteKind = "shorter" | "formal" | "english";

/** How much of the other side's message the reply answers. */
export interface ReplyCheck {
  readonly asked: number;
  readonly answered: number;
  /** A few words for each question not answered yet. */
  readonly missing: readonly string[];
}

/** The help that reads the thread a message answers. */
export interface ThreadHelp {
  /** The whole text with answers added for the questions it leaves open; unchanged when none are. */
  answer(text: string, missing?: readonly string[]): Promise<string>;
  check(text: string): Promise<ReplyCheck>;
  /** Values found in the thread for the placeholders, with where each was found. */
  fill(text: string): Promise<readonly GapSuggestion[]>;
}

export interface ReplyAgent {
  /** The whole text with the writer's lines rewritten; the quote and the placeholders are kept. */
  rewrite(kind: RewriteKind, text: string): Promise<string>;
  /**
   * The whole text with the writer's lines written or changed as their own words ask; the quote
   * and the placeholders are kept, and what the agent was not told is left as a placeholder.
   */
  write(words: string, text: string): Promise<string>;
  /** Help from the thread the message answers; absent for a new message or a forward. */
  readonly thread?: ThreadHelp;
}
