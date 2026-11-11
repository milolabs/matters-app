import type { Message } from "@matters/core";
import { replyPromptTarget } from "@matters/core";
import { displayName } from "./format.ts";

/**
 * What "Reply to ..." names (ADR 0042, rule 6): the person a reply would go to, which is not
 * always who sent the message. A thread with nobody else in it is "this thread".
 */
export function replyPromptName(messages: readonly Message[], own: ReadonlySet<string>): string {
  const target = replyPromptTarget(messages, [...own]);
  if (!target || own.has(target.address.toLowerCase())) return "this thread";
  return displayName(target);
}
