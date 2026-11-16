import type { StoredAccount } from "../domain/accounts.ts";
import type { Draft, DraftContent } from "../domain/draft.ts";
import { buildForward, messageToForward } from "../domain/forward.ts";
import {
  buildReply,
  emptyDraftContent,
  messageToAnswer,
  type ReplyMode,
  type ReplyRedirect,
  replyRedirect,
} from "../domain/reply.ts";
import {
  InvalidSignatureError,
  normalizeSignature,
  placeSignature,
  signatureProblem,
} from "../domain/signature.ts";
import type {
  AccountStorePort,
  DraftStorePort,
  MessageBodyPort,
  MessageStorePort,
} from "../ports/index.ts";

export interface PrepareDeps {
  readonly accounts: Pick<AccountStorePort, "list">;
  readonly store: Pick<MessageStorePort, "getThread">;
  readonly bodies: Pick<MessageBodyPort, "getBodies">;
  readonly drafts: Pick<DraftStorePort, "findByThread">;
}

export interface PreparedDraft {
  /** What a new draft starts from, the account's signature already in its text (ADR 0142). */
  readonly content: DraftContent;
  /**
   * The account's signature as it was put in, without its delimiter; empty when it has none. The
   * composer keeps it to tell whether the person changed it (ADR 0142, rule 5).
   */
  readonly signature: string;
  /** A draft already answering this thread; the composer opens it instead. */
  readonly existing: Draft | null;
  /**
   * Set when a new reply goes somewhere other than to who sent the message, for the composer to
   * say so (ADR 0042, rule 5). Null for a draft that already exists: it keeps its recipients.
   */
  readonly redirect: ReplyRedirect | null;
}

export class NoAccountError extends Error {
  constructor() {
    super("Add an account first");
    this.name = "NoAccountError";
  }
}

/** The account's signature as kept; empty when it has none. */
export function signatureOf(account: Pick<StoredAccount, "signature">): string {
  return account.signature ?? "";
}

/** What a new message starts from: its content and the signature put in it (ADR 0142). */
export interface PreparedNew {
  readonly content: DraftContent;
  readonly signature: string;
}

/**
 * A new message from this account (default: the first one): an empty line to write on, then the
 * account's signature, when it has one (ADR 0142, rule 3).
 */
export async function prepareNewMessage(
  deps: Pick<PrepareDeps, "accounts">,
  accountId?: string,
): Promise<PreparedNew> {
  const accounts = await deps.accounts.list();
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];
  if (!account) throw new NoAccountError();
  const signature = signatureOf(account);
  const content = emptyDraftContent(account);
  return {
    content: { ...content, bodyMarkdown: placeSignature(content.bodyMarkdown, signature) },
    signature,
  };
}

/**
 * Keeps the account's signature (ADR 0142, rules 1 and 7): normalized, at most
 * `SIGNATURE_MAX_CHARS`, no line that reads as quoted mail. Empty takes it away. Drafts that exist
 * keep the signature they have. Returns the signature as kept, or null when there is no such
 * account.
 */
export async function saveSignature(
  deps: { readonly accounts: Pick<AccountStorePort, "setSignature"> },
  accountId: string,
  text: string,
): Promise<string | null> {
  const signature = normalizeSignature(text);
  const problem = signatureProblem(signature);
  if (problem !== null) throw new InvalidSignatureError(problem);
  return (await deps.accounts.setSignature(accountId, signature)) ? signature : null;
}

/**
 * The draft a reply or reply-all to a thread starts from: it answers the newest message that is
 * not the user's own (else the newest), quotes it, and excludes the user's addresses.
 */
export async function prepareReplyDraft(
  deps: PrepareDeps,
  threadId: string,
  mode: ReplyMode,
): Promise<PreparedDraft | null> {
  const view = await deps.store.getThread(threadId);
  if (!view || view.messages.length === 0) return null;
  const accounts = await deps.accounts.list();
  const account = accounts.find((a) => a.id === view.thread.accountId);
  if (!account) throw new NoAccountError();
  const own = accounts.map((a) => a.address);
  const target = messageToAnswer(view.messages, own);
  if (!target) return null;
  const earlier = view.messages.filter((m) => m.key < target.key);
  const body = (await deps.bodies.getBodies([target.key])).get(target.key) ?? "";
  const content = buildReply({
    mode,
    account,
    ownAddresses: own,
    message: target,
    bodyText: body,
    earlier,
  });
  const existing = await deps.drafts.findByThread(account.id, threadId);
  const signature = signatureOf(account);
  return {
    // Above the quote, the caret above it (ADR 0142, rule 3). A draft that exists keeps its own.
    content: { ...content, bodyMarkdown: placeSignature(content.bodyMarkdown, signature) },
    signature,
    existing,
    redirect: existing ? null : replyRedirect(target, [account.address, ...own]),
  };
}

export interface PreparedForward extends PreparedDraft {
  /** The message the draft quotes, so the page knows whose files to put on it. */
  readonly messageKey: number;
}

/**
 * The draft a forward starts from (ADR 0045, rule 1): the newest message of the thread that is
 * not in Trash or Spam, unless the thread is being looked at from there (`hidden`, as for
 * `moveThread`). A forward is a new conversation, so there is never a draft to open instead.
 */
export async function prepareForwardDraft(
  deps: Pick<PrepareDeps, "accounts" | "store" | "bodies">,
  threadId: string,
  hidden: boolean,
): Promise<PreparedForward | null> {
  const view = await deps.store.getThread(threadId, { visibleOnly: !hidden });
  const target = view && messageToForward(view.messages, hidden);
  if (!view || !target) return null;
  const accounts = await deps.accounts.list();
  const account = accounts.find((a) => a.id === view.thread.accountId);
  if (!account) throw new NoAccountError();
  const body = (await deps.bodies.getBodies([target.key])).get(target.key) ?? "";
  const content = buildForward({ account, message: target, bodyText: body });
  const signature = signatureOf(account);
  return {
    // Above the forwarded part (ADR 0142, rule 3).
    content: { ...content, bodyMarkdown: placeSignature(content.bodyMarkdown, signature) },
    signature,
    existing: null,
    redirect: null,
    messageKey: target.key,
  };
}
