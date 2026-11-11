// What the router needs of a prompt's verdicts for a notice (ADR 0117, rule 6): the fit kept for
// each thread as it stands now, read on the reader connection, no model. Small on purpose: the
// router does not load the agent's code.
import { createHash } from "node:crypto";
import {
  type AgentInsightStorePort,
  type MessageStorePort,
  PROMPT_VERSION,
  parseQuery,
  promptKey,
} from "@matters/core";

/** SHA-256 of the folded prompt (ADR 0116, rule 5). */
export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export interface PromptFitDeps {
  readonly store: Pick<MessageStorePort, "getThread">;
  readonly insights: Pick<AgentInsightStorePort, "getPromptVerdicts">;
}

/**
 * The fit of the current verdict of each of these threads for the prompt of `query`: a thread
 * whose verdict is for an older last message, or that has none, is absent. A query with no
 * prompt: none.
 */
export async function promptFits(
  deps: PromptFitDeps,
  query: string,
  threadIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const prompt = parseQuery(query).prompt;
  if (prompt === undefined || threadIds.length === 0) return new Map();
  const threads: { threadId: string; lastMessageKey: number }[] = [];
  for (const threadId of threadIds) {
    const view = await deps.store.getThread(threadId, { visibleOnly: true });
    if (view !== null) threads.push({ threadId, lastMessageKey: view.thread.lastMessageKey });
  }
  const verdicts = await deps.insights.getPromptVerdicts(
    promptKey(prompt.text, sha256Hex),
    PROMPT_VERSION,
    threads,
  );
  return new Map(verdicts.map((v) => [v.threadId, v.fit]));
}
