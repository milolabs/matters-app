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
  /** What a new draft starts from. */
  readonly content: DraftContent;
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

/** A new message from this account (default: the first one). */
export async function prepareNewMessage(
  deps: Pick<PrepareDeps, "accounts">,
  accountId?: string,
): Promise<DraftContent> {
  const accounts = await deps.accounts.list();
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];
  if (!account) throw new NoAccountError();
  return emptyDraftContent(account);
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
  return {
    content,
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
  return {
    content: buildForward({ account, message: target, bodyText: body }),
    existing: null,
    redirect: null,
    messageKey: target.key,
  };
}
