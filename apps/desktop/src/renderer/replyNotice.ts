import type { ReplyRedirect } from "@matters/core";

/** The one line above a reply's fields when it goes elsewhere than to who sent the message. */
export interface ReplyNotice {
  /** The addresses the reply goes to, plain text: it is shown in bold, never as markup. */
  readonly to: string;
  /** What follows them. */
  readonly rest: string;
  /** Set when the sender could not be verified; shown in the `late` color. */
  readonly warning: string | null;
  /** The whole line as one sentence, for tests and the tooltip of a truncated address. */
  readonly text: string;
}

export const UNVERIFIED_WARNING =
  "The sender could not be verified. Check this address before replying.";

/**
 * ADR 0042, rule 5. The decision (whether the reply really goes elsewhere) was made in core
 * (`replyRedirect`); this only words it. Null shows no line at all.
 */
export function replyNotice(redirect: ReplyRedirect | null | undefined): ReplyNotice | null {
  if (!redirect || redirect.to.length === 0) return null;
  const to = redirect.to.map((p) => p.address).join(", ");
  const rest = `, as the sender asked. Sent from ${redirect.from.address}.`;
  const warning = redirect.unverified ? UNVERIFIED_WARNING : null;
  const text = `Replies go to ${to}${rest}${warning ? ` ${warning}` : ""}`;
  return { to, rest, warning, text };
}
