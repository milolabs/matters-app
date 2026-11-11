import type { DraftContent } from "./draft.ts";
import type { HtmlKind, Message, Participant } from "./entities.ts";
import { isHiddenMailbox } from "./mailbox.ts";
import { escapeAddress, escapeMarkdown } from "./markdownEscape.ts";
import { formatMessageDate, quoteLines } from "./reply.ts";

export { escapeMarkdown } from "./markdownEscape.ts";

/**
 * Forwarding (ADR 0045). A forward is a new conversation: it quotes one message, has no recipients
 * yet and carries no threading headers.
 */

/** The line that opens the quote, and so ends what the person wrote above it. */
export const FORWARD_MARK = "> Forwarded message";

/**
 * One `Fwd:` in front, whatever chain of `Fwd:`, `FW:`, `PD:` and `WG:` was there (rule 3). `Re:`
 * stays: `Fwd: Re: Budget` says what it is. An empty subject stays empty after the prefix.
 */
export function forwardSubject(subject: string): string {
  const bare = subject.replace(/^\s*((fwd?|pd|wg)\s*(\[\d+\])?\s*:\s*)+/i, "").trim();
  return bare === "" ? "Fwd:" : `Fwd: ${bare}`;
}

/**
 * `Name (address)`, not `Name <address>`. The text part is the Markdown source, so an angle bracket
 * would have to be escaped, and every recipient reading plain text would see the backslash.
 */
function person(p: Participant): string {
  const name = p.name?.trim() ?? "";
  return name === "" || name === p.address
    ? escapeAddress(p.address)
    : `${escapeMarkdown(name)} (${escapeAddress(p.address)})`;
}

function people(list: readonly Participant[]): string {
  return list.map(person).join(", ");
}

/** The lines of rule 4, without `> ` in front. `Cc` is there only when someone is in it. */
export function forwardHeader(message: Message): string[] {
  const subject = message.subject.trim();
  return [
    "Forwarded message",
    `From: ${person(message.from)}`,
    `Date: ${formatMessageDate(message.dateMs)}`,
    `Subject: ${subject === "" ? "(no subject)" : escapeMarkdown(subject)}`,
    `To: ${people(message.to)}`,
    ...(message.cc.length > 0 ? [`Cc: ${people(message.cc)}`] : []),
  ];
}

export interface ForwardInput {
  readonly account: { readonly id: string; readonly address: string; readonly displayName: string };
  /** The message forwarded. */
  readonly message: Message;
  readonly bodyText: string;
}

/** The draft a forward starts from (ADR 0045, rules 1 to 5): no recipients, no thread. */
export function buildForward(input: ForwardInput): DraftContent {
  const { message, account } = input;
  const header = forwardHeader(message).map((line) => `> ${line}`);
  const text = input.bodyText.trim() === "" ? [] : [">", quoteLines(input.bodyText)];
  return {
    accountId: account.id,
    from: { name: account.displayName, address: account.address },
    to: [],
    cc: [],
    bcc: [],
    subject: forwardSubject(message.subject),
    // Empty for the person's own words, then the quote.
    bodyMarkdown: `\n\n${[...header, ...text].join("\n")}\n`,
    inReplyTo: "",
    references: [],
    forwarded: true,
  };
}

/**
 * The message a forward carries (rule 1): the newest of the thread that is not in Trash or Spam,
 * unless the thread is being looked at from there. `messages` is ascending, as a thread's are.
 */
export function messageToForward(
  messages: readonly Message[],
  hidden: boolean,
): Message | undefined {
  return [...messages].reverse().find((m) => hidden || !isHiddenMailbox(m.mailboxes ?? 0));
}

/**
 * What the person wrote: the body above the quote. Editing inside the quote does not count, and
 * neither does a quote that was deleted down to nothing (rule 13).
 */
export function ownWords(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.indexOf(FORWARD_MARK);
  return (at === -1 ? lines : lines.slice(0, at)).join("\n").trim();
}

/** What the composer needs to know of the forwarded message to say what is not carried. */
export interface ForwardFacts {
  /** The structure of the message's files was read (ADR 0043, rule 2). */
  readonly attachmentsKnown: boolean;
  readonly htmlKind?: HtmlKind | undefined;
  /** The message has parts that sit inside its body, a logo or a picture. */
  readonly hasInline: boolean;
}

export const FORWARD_UNKNOWN_FILES =
  "The attachments of this message aren't known yet, so they weren't added.";
export const FORWARD_AS_TEXT = "Forwarded as text. Its layout and inline images stay behind.";

/** Rules 11 and 12, in one place: the lines the composer says about what is not carried. */
export function forwardNotices(facts: ForwardFacts): string[] {
  const notices: string[] = [];
  if (!facts.attachmentsKnown) notices.push(FORWARD_UNKNOWN_FILES);
  if (facts.htmlKind === "designed" || facts.hasInline) notices.push(FORWARD_AS_TEXT);
  return notices;
}
