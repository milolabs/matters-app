import type { DraftContent } from "./draft.ts";
import type { Message, Participant } from "./entities.ts";
import { escapeAddress, escapeMarkdown } from "./markdownEscape.ts";
import { sameAddress } from "./recipients.ts";

export type ReplyMode = "reply" | "replyAll";

/** One `Re:` in front, whatever the chain of `Re:`/`RE:`/`Odp:` looked like. */
export function replySubject(subject: string): string {
  const bare = subject.replace(/^\s*((re|odp|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, "").trim();
  return `Re: ${bare}`;
}

/** `> ` in front of every line, so plain-text readers and Markdown both see a quote. */
export function quoteLines(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

// ` [https://…]` after a word: how the text version of an HTML message shows where a link goes.
const LINK_NOTE = /[ \t]*\[\s*(?:https?:|mailto:|www\.)[^\]\n]*\]/gi;

/**
 * The text a reply quotes (ADR 0096): without the link addresses the text version of an HTML
 * message carries after each link, and with no more than one empty line in a row. The words stay
 * as they were. A forward quotes the text whole: there the addresses may be what is passed on.
 */
export function replyQuoteText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(LINK_NOTE, "").replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const attributionDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** "3 Nov 2026, 10:29": the date a reply's line and a forward's header both use. */
export function formatMessageDate(dateMs: number): string {
  return attributionDate.format(new Date(dateMs));
}

/**
 * "On 3 Nov 2026, 10:29, Anna wrote:". The name is written by the sender, and the line is Markdown
 * in a message the user sends, so it is escaped like the header of a forward (ADR 0045, rule 5):
 * a sender named `[Click here](https://...)` is not a link. A name that is the address, or no
 * name, is written as an address, which keeps its `@` and so reads without a backslash.
 */
export function attribution(message: Pick<Message, "from" | "dateMs">): string {
  const { name, address } = message.from;
  const who =
    name === undefined || name.trim() === "" || name.trim() === address
      ? escapeAddress(address)
      : escapeMarkdown(name.trim());
  return `On ${formatMessageDate(message.dateMs)}, ${who} wrote:`;
}

export interface ReplyInput {
  readonly mode: ReplyMode;
  readonly account: { readonly id: string; readonly address: string; readonly displayName: string };
  /** Every address of the user, to keep out of the recipients. */
  readonly ownAddresses: readonly string[];
  /** The message answered. */
  readonly message: Message;
  readonly bodyText: string;
  /** Messages of the thread up to and including `message`, oldest first. */
  readonly earlier: readonly Message[];
}

const MAX_REFERENCES = 10;

function dedupe(list: readonly Participant[], skip: readonly string[]): Participant[] {
  const out: Participant[] = [];
  for (const p of list) {
    if (skip.some((a) => sameAddress(a, p.address))) continue;
    if (out.some((o) => sameAddress(o.address, p.address))) continue;
    out.push(p);
  }
  return out;
}

/**
 * What `Reply-To` is kept as (ADR 0042, rule 1). A list that only names `From` says nothing
 * `From` does not, and ENVELOPE hands us exactly that when the header is absent, so both ways of
 * learning it end up with the same answer: empty.
 */
export function normalizeReplyTo(
  replyTo: readonly Participant[],
  from: Participant | undefined,
): Participant[] {
  const listed = replyTo.filter((p) => p.address.trim() !== "");
  if (from && listed.every((p) => sameAddress(p.address, from.address))) return [];
  return listed;
}

/** Whom a reply is addressed to, and whether that is where the sender asked for it. */
export interface ReplyDestination {
  readonly to: Participant[];
  /** `to` comes from `Reply-To`, not from `From`. */
  readonly redirected: boolean;
}

/**
 * Rules 2 and 4 of ADR 0042. A reply goes to `Reply-To` when anyone is left in it once the
 * user's own addresses are removed, else to `From`. A reply to the user's own message goes to
 * that message's `To`: `Reply-To` says where answers to the user go, not where the user writes.
 */
export function replyDestination(message: Message, own: readonly string[]): ReplyDestination {
  if (own.some((a) => sameAddress(a, message.from.address))) {
    return { to: dedupe(message.to, own), redirected: false };
  }
  const asked = dedupe(message.replyTo ?? [], own);
  const redirected =
    asked.length > 0 && !asked.every((p) => sameAddress(p.address, message.from.address));
  return { to: redirected ? asked : dedupe([message.from], own), redirected };
}

/** What the composer tells the person when a reply does not go to who sent the message. */
export interface ReplyRedirect {
  /** Where the reply goes. */
  readonly to: readonly Participant[];
  /** Who sent the message. */
  readonly from: Participant;
  /** The receiving server could not authenticate the sender (ADR 0037). */
  readonly unverified: boolean;
}

/** Rule 5 of ADR 0042: null when the reply goes where it always did. */
export function replyRedirect(message: Message, own: readonly string[]): ReplyRedirect | null {
  const { to, redirected } = replyDestination(message, own);
  return redirected ? { to, from: message.from, unverified: message.senderAuth === "fail" } : null;
}

/**
 * The message a reply to a thread answers: the newest that is not the user's own, else the
 * newest. `messages` is ascending.
 */
export function messageToAnswer(
  messages: readonly Message[],
  own: readonly string[],
): Message | undefined {
  const isOwn = (m: Message) => own.some((a) => sameAddress(a, m.from.address));
  return [...messages].reverse().find((m) => !isOwn(m)) ?? messages.at(-1);
}

/**
 * Who the reader's "Reply to ..." button names (ADR 0042, rule 6): where the reply would go,
 * which is not always who sent the message. Names only the first person; the composer shows
 * the rest.
 */
export function replyPromptTarget(
  messages: readonly Message[],
  own: readonly string[],
): Participant | undefined {
  const message = messageToAnswer(messages, own);
  return message && (replyDestination(message, own).to[0] ?? message.from);
}

/** The draft a reply or reply-all starts from (ADR 0020, rule 13; ADR 0042). */
export function buildReply(input: ReplyInput): DraftContent {
  const { message, account } = input;
  const own = [account.address, ...input.ownAddresses];
  const answeringMyself = own.some((a) => sameAddress(a, message.from.address));
  const { to } = replyDestination(message, own);
  // `From` is not added when `Reply-To` replaced it: the sender asked not to be answered there.
  const cc =
    input.mode === "replyAll"
      ? dedupe(
          [...(answeringMyself ? [] : message.to), ...message.cc],
          [...own, ...to.map((p) => p.address)],
        )
      : [];

  const ids = [...input.earlier, message]
    .map((m) => m.messageIdHeader)
    .filter((id, i, all) => id !== "" && all.indexOf(id) === i);
  const references =
    ids.length > MAX_REFERENCES ? [ids[0] as string, ...ids.slice(-(MAX_REFERENCES - 1))] : ids;

  const quoted = replyQuoteText(input.bodyText);
  const quote = quoted === "" ? "" : `${attribution(message)}\n${quoteLines(quoted)}\n`;
  return {
    accountId: account.id,
    from: { name: account.displayName, address: account.address },
    to,
    cc,
    bcc: [],
    subject: replySubject(message.subject),
    bodyMarkdown: quote === "" ? "" : `\n\n${quote}`,
    inReplyTo: message.messageIdHeader,
    references,
    threadId: message.threadId,
  };
}

export function emptyDraftContent(account: {
  id: string;
  address: string;
  displayName: string;
}): DraftContent {
  return {
    accountId: account.id,
    from: { name: account.displayName, address: account.address },
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    bodyMarkdown: "",
    inReplyTo: "",
    references: [],
  };
}
