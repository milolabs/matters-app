import type {
  Account,
  AttachmentAnswer,
  FolderSyncContext,
  KnownLocation,
  Label,
  MailSyncPort,
  MessageDocument,
  MessageFlags,
  MessageLocation,
  MimeParserPort,
  ProviderCapability,
  SyncBatch,
  SyncCursor,
  SyncedDocument,
} from "@matters/core";
import { localThreadRoot, messageKey, threadParents } from "@matters/core";
import type { GraphClient } from "./client.ts";
import { GraphRequestError } from "./errors.ts";
import { type GraphFolders, nextLinkOf } from "./folders.ts";
import { attachmentsOfMime } from "./mimeParts.ts";

/** What delta query is asked for: only what sync needs (ADR 0136, rule 5). */
const DELTA_SELECT = "id,isRead,isDraft,flag,receivedDateTime";

const EMPTY = { documents: [], knownLocations: [], flagUpdates: [], removedLocations: [] } as const;

/** Messages fetched as MIME at once while a page is read. */
const DOWNLOADS_AT_ONCE = 4;

/** Removed ids carried in the cursor across pages; beyond this the round is not checkpointed. */
const MAX_HELD_CHARS = 64 * 1024;

export interface GraphSyncStats {
  /** Messages fetched as MIME (`$value`). A move must not raise it. */
  sourcesDownloaded: number;
  /** Delta rounds that listed a folder from the start because its link had expired. */
  folderResets: number;
}

/** One row of a delta page. */
interface DeltaItem {
  readonly id: string;
  readonly flags: MessageFlags;
  readonly receivedMs?: number;
}

/**
 * Where a folder's sync stands, in the cursor (rule 5). `link` is where to ask next: the delta
 * link once a round is done, a page link while one runs, so a stop resumes. The epoch is the
 * folder's `uidValidity`; `lastUid` the highest number its copies have, for the arrivals of ADR
 * 0106.
 */
interface FolderCursor {
  readonly epoch: string;
  /** The epoch before a full round that lists the folder anew; its copies go at its end. */
  readonly oldEpoch: string | null;
  readonly lastUid: number;
  readonly link: string;
  /** `delta`: the round is done and `link` starts the next; `page`: a round is running. */
  readonly stage: "delta" | "page";
  /** The round lists the whole folder (the first one, or after the link expired). */
  readonly full: boolean;
  /** The first link of the running round: where it starts over when it cannot be checkpointed. */
  readonly start: string;
  /** Ids `@removed` on pages of the running round already committed. */
  readonly held: readonly string[];
  /** One copy announced in a full round, which carries `resetFolder` at its end. */
  readonly anchor: KnownLocation | null;
}

function readCursor(raw: SyncCursor | null): FolderCursor | null {
  if (raw === null) return null;
  const { uidValidity, oldEpoch, lastUid, link, stage, full, start, held, anchor } = raw;
  if (typeof uidValidity !== "string" || typeof link !== "string" || link === "") return null;
  if (stage !== "delta" && stage !== "page") return null;
  let heldIds: string[] = [];
  let anchorLocation: KnownLocation | null = null;
  try {
    if (typeof held === "string" && held !== "") heldIds = JSON.parse(held) as string[];
    if (typeof anchor === "string" && anchor !== "")
      anchorLocation = JSON.parse(anchor) as KnownLocation;
  } catch {
    return null;
  }
  return {
    epoch: uidValidity,
    oldEpoch: typeof oldEpoch === "string" && oldEpoch !== "" ? oldEpoch : null,
    lastUid: typeof lastUid === "string" && /^\d+$/.test(lastUid) ? Number(lastUid) : 0,
    link,
    stage,
    full: full === "1",
    start: typeof start === "string" && start !== "" ? start : link,
    held: Array.isArray(heldIds) ? heldIds.filter((id) => typeof id === "string") : [],
    anchor: anchorLocation,
  };
}

function writeCursor(c: FolderCursor): SyncCursor {
  const held = c.held.length === 0 ? "" : JSON.stringify(c.held);
  return {
    // `uidValidity` and `lastUid` as the IMAP cursor names them: the arrivals read them.
    uidValidity: c.epoch,
    oldEpoch: c.oldEpoch ?? "",
    lastUid: String(c.lastUid),
    link: c.link,
    stage: c.stage,
    full: c.full ? "1" : "0",
    start: c.start,
    held,
    anchor: c.anchor === null ? "" : JSON.stringify(c.anchor),
  };
}

/** A new epoch: larger than the last, so a location of the old one never matches. */
function newEpoch(previous: string | null, now: number): string {
  const before = previous !== null && /^\d+$/.test(previous) ? Number(previous) : 0;
  return String(Math.max(now, before + 1));
}

function itemsOf(body: unknown): { items: DeltaItem[]; removed: string[] } {
  const value = (body as { value?: unknown } | null)?.value;
  const items: DeltaItem[] = [];
  const removed: string[] = [];
  if (!Array.isArray(value)) return { items, removed };
  for (const raw of value) {
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id === "") continue;
    if (row["@removed"] !== undefined) {
      removed.push(row.id);
      continue;
    }
    const flag = (row.flag as { flagStatus?: unknown } | null)?.flagStatus;
    const received =
      typeof row.receivedDateTime === "string" ? Date.parse(row.receivedDateTime) : Number.NaN;
    items.push({
      id: row.id,
      flags: {
        seen: row.isRead === true,
        flagged: flag === "flagged",
        // Graph v1.0 has no plain property for it; the store keeps what Graph says.
        answered: false,
        draft: row.isDraft === true,
      },
      ...(Number.isNaN(received) ? {} : { receivedMs: received }),
    });
  }
  return { items, removed };
}

const deltaLinkOf = (body: unknown): string | undefined => {
  const link = (body as Record<string, unknown> | null)?.["@odata.deltaLink"];
  return typeof link === "string" && link !== "" ? link : undefined;
};

/** Graph says the delta link can no longer be used: the folder is listed anew (rule 5). */
export function isExpiredSync(error: unknown): boolean {
  if (!(error instanceof GraphRequestError)) return false;
  if (error.status === 410) return true;
  return (
    (error.status === 400 || error.status === 404) &&
    /sync ?state|resync|deltatoken|invaliddelta/i.test(error.code ?? "")
  );
}

export interface GraphMailSyncOptions {
  readonly client: GraphClient;
  readonly folders: GraphFolders;
  readonly parser: MimeParserPort;
  readonly now?: () => number;
}

/**
 * `MailSyncPort` over Microsoft Graph (ADR 0136, rules 5 and 6): delta query per folder, newest
 * first; a message the store does not have is fetched as MIME and parsed, one it has is a new
 * location at no cost. A copy's handle is its immutable id, numbered by the store.
 *
 * Batches follow the contract of `MailSyncPort.syncFolder`: each page's additions are a batch of
 * their own, committed with a page link, and the last batch carries the removals and the delta
 * link. A changed read state or flag comes as a known location with its flags (the store adds a
 * location it has as a no-op and writes the flags), so it is right whether or not the copy was
 * stored at this epoch; the last batch's `flagUpdates` stay empty.
 */
export class GraphMailSync implements MailSyncPort {
  readonly capabilities: ReadonlySet<ProviderCapability> = new Set(["savesSent"]);
  readonly stats: GraphSyncStats = { sourcesDownloaded: 0, folderResets: 0 };
  private readonly client: GraphClient;
  private readonly folders: GraphFolders;
  private readonly parser: MimeParserPort;
  private readonly now: () => number;

  constructor(options: GraphMailSyncOptions) {
    this.client = options.client;
    this.folders = options.folders;
    this.parser = options.parser;
    this.now = options.now ?? Date.now;
  }

  listFolders(account: Account): Promise<readonly Label[]> {
    return this.folders.list(account);
  }

  private firstLink(folderId: string): string {
    return `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=${DELTA_SELECT}&$orderby=receivedDateTime+desc`;
  }

  async *syncFolder(
    account: Account,
    folder: Label,
    cursor: SyncCursor | null,
    context: FolderSyncContext,
  ): AsyncIterable<SyncBatch> {
    const kept = readCursor(cursor);
    let state: FolderCursor =
      kept === null
        ? this.fullRound(folder.id, null, 0)
        : kept.stage === "delta"
          ? { ...kept, stage: "page", start: kept.link, full: false, held: [], anchor: null }
          : kept;

    const at = (epoch: string, uid: number, itemId: string): MessageLocation => ({
      accountId: account.id,
      folderId: folder.id,
      uidValidity: epoch,
      uid,
      itemId,
    });

    for (;;) {
      let body: unknown;
      try {
        body = (await this.client.json(state.link, { paged: true })).body;
      } catch (error) {
        if (isExpiredSync(error)) {
          // The link expired or Graph refused it: the folder is listed anew at a new epoch,
          // and the copies still there keep their numbers (rule 5).
          this.stats.folderResets++;
          state = this.fullRound(folder.id, state.epoch, state.lastUid);
          continue;
        }
        if (error instanceof GraphRequestError && error.status === 404) {
          // The folder is gone: none of its copies is there any more.
          yield { ...EMPTY, resetFolder: true, cursor: {} };
          return;
        }
        throw error;
      }
      const { items, removed } = itemsOf(body);
      const next = nextLinkOf(body);
      const delta = next === undefined ? deltaLinkOf(body) : undefined;
      const following = next ?? delta;
      if (following === undefined) {
        throw new GraphRequestError("Microsoft Graph ended a delta page without a link");
      }
      // Guard the link now, before anything of the page is committed with it (rule 12).
      this.client.url(following);

      const present = new Set(items.map((i) => i.id));
      const held = [...new Set([...state.held, ...removed])].filter((id) => !present.has(id));
      const page = await this.additions(account, folder, state.epoch, items, context);
      let anchor = state.anchor;
      if (anchor !== null && held.includes(anchor.providerId)) anchor = null;
      if (state.full && page.anchor !== null) anchor = page.anchor;
      const lastUid = Math.max(state.lastUid, ...page.uids);

      if (next !== undefined) {
        // A page link is kept, so a stop resumes here, with what the round removed so far. A
        // round that removed too much to carry starts over instead: it costs no download.
        const checkpoint = JSON.stringify(held).length <= MAX_HELD_CHARS;
        const running: FolderCursor = { ...state, lastUid, link: next, held, anchor };
        yield {
          ...page.batch,
          cursor: writeCursor(
            checkpoint ? running : { ...running, link: state.start, held: [], anchor: null },
          ),
        };
        state = running;
        continue;
      }

      // The last page: its additions first, with a cursor that asks this page again, then the
      // removals and the delta link (the order of `MailSyncPort.syncFolder`).
      if (page.count > 0) {
        yield { ...page.batch, cursor: writeCursor({ ...state, lastUid, held, anchor }) };
      }
      const gone = await context.knownItemUids(held);
      const removedLocations = [...gone].map(([itemId, uid]) => at(state.epoch, uid, itemId));
      const final: SyncBatch = {
        ...EMPTY,
        removedLocations,
        cursor: writeCursor({
          epoch: state.epoch,
          oldEpoch: null,
          lastUid,
          link: following,
          stage: "delta",
          full: false,
          start: following,
          held: [],
          anchor: null,
        }),
      };
      if (!state.full) {
        yield final;
        return;
      }
      // A full round announced every copy of the folder at its epoch: the copies of the epoch
      // before go, by name, so the batch waits for the other folders' additions (a move must
      // find its message), and `resetFolder` drops whatever else is left (rule 5).
      if (state.oldEpoch !== null) {
        const uids = await context.storedUids(state.oldEpoch);
        const ids = await context.itemIdsOf(uids);
        for (const uid of uids) {
          const itemId = ids.get(uid);
          removedLocations.push(
            itemId === undefined
              ? { accountId: account.id, folderId: folder.id, uidValidity: state.oldEpoch, uid }
              : at(state.oldEpoch, uid, itemId),
          );
        }
      }
      if (anchor !== null) {
        // The anchor names the epoch `resetFolder` keeps.
        yield { ...final, removedLocations, knownLocations: [anchor], resetFolder: true };
      } else if ((await context.storedUids(state.epoch)).length === 0) {
        // The folder is empty on the server: every location of it goes.
        yield { ...final, removedLocations, resetFolder: true };
      } else {
        yield { ...final, removedLocations };
      }
      return;
    }
  }

  private fullRound(folderId: string, previousEpoch: string | null, lastUid: number): FolderCursor {
    const link = this.firstLink(folderId);
    return {
      epoch: newEpoch(previousEpoch, this.now()),
      oldEpoch: previousEpoch,
      lastUid,
      link,
      stage: "page",
      full: true,
      start: link,
      held: [],
      anchor: null,
    };
  }

  /** One page's rows: known messages as locations, the others fetched as MIME and parsed. */
  private async additions(
    account: Account,
    folder: Label,
    epoch: string,
    items: readonly DeltaItem[],
    context: FolderSyncContext,
  ): Promise<{
    batch: Omit<SyncBatch, "cursor">;
    anchor: KnownLocation | null;
    uids: number[];
    count: number;
  }> {
    if (items.length === 0) return { batch: EMPTY, anchor: null, uids: [], count: 0 };
    const ids = items.map((i) => i.id);
    const numbers = await context.itemUids(ids);
    const known = await context.knownProviderIds(ids);
    const at = (item: DeltaItem): MessageLocation => ({
      accountId: account.id,
      folderId: folder.id,
      uidValidity: epoch,
      uid: numbers.get(item.id) as number,
      itemId: item.id,
    });
    const knownLocations: KnownLocation[] = [];
    const toFetch: DeltaItem[] = [];
    for (const item of items) {
      if (!numbers.has(item.id)) continue;
      if (known.has(item.id)) {
        knownLocations.push({ providerId: item.id, location: at(item), flags: item.flags });
      } else toFetch.push(item);
    }
    const documents: SyncedDocument[] = [];
    const attachmentAnswers: AttachmentAnswer[] = [];
    const fetched = await mapLimit(toFetch, DOWNLOADS_AT_ONCE, async (item) => {
      const raw = await this.client.bytes(`/me/messages/${encodeURIComponent(item.id)}/$value`);
      if (raw !== null) this.stats.sourcesDownloaded++;
      return raw;
    });
    for (const [i, item] of toFetch.entries()) {
      const raw = fetched[i];
      // Gone between the page and the download: the next round says `@removed`.
      if (raw === null || raw === undefined) continue;
      const document = await this.documentOf(account, folder, item, raw);
      documents.push({ document, location: at(item) });
      attachmentAnswers.push({ location: at(item), attachments: attachmentsOfMime(raw) });
    }
    const all = [...documents.map((d) => d.location), ...knownLocations.map((k) => k.location)];
    // The oldest copy of the page the store will hold once the batch is applied.
    const stored = new Set(all.map((l) => l.itemId));
    const last = [...items].reverse().find((i) => stored.has(i.id));
    return {
      batch: {
        ...EMPTY,
        documents,
        knownLocations,
        ...(attachmentAnswers.length > 0 ? { attachmentAnswers } : {}),
      },
      anchor:
        last === undefined ? null : { providerId: last.id, location: at(last), flags: last.flags },
      uids: all.map((l) => l.uid),
      count: documents.length + knownLocations.length,
    };
  }

  private async documentOf(
    account: Account,
    folder: Label,
    item: DeltaItem,
    raw: Uint8Array,
  ): Promise<MessageDocument> {
    // No Microsoft receiving server writes an authserv-id the account can trust (ADR 0048).
    const parsed = await this.parser.parse(raw);
    const dateMs = parsed.dateMs ?? item.receivedMs ?? this.now();
    const messageId = parsed.messageId;
    const accountId = account.id;
    const ids = { messageId, inReplyTo: parsed.inReplyTo, references: parsed.references };
    const threadId = `lt:${accountId}:${localThreadRoot(ids) || item.id}`;
    return {
      message: {
        key: messageKey(dateMs, 0),
        accountId,
        providerId: item.id,
        threadId,
        messageIdHeader: messageId,
        parentIds: threadParents(ids),
        dateMs,
        from: parsed.from ?? { address: "" },
        to: parsed.to,
        cc: parsed.cc,
        subject: parsed.subject,
        snippet: parsed.text.replace(/\s+/g, " ").trim().slice(0, 140),
        flags: item.flags,
        labelIds: [folder.id],
        hasAttachments: parsed.attachments.some((a) => !a.inline),
        senderAuth: parsed.senderAuth,
        replyTo: parsed.replyTo,
        ...(parsed.automated === undefined ? {} : { automated: parsed.automated }),
      },
      bodyText: parsed.text,
      ...(parsed.html === undefined ? {} : { bodyHtml: parsed.html }),
      ...(parsed.htmlKind === undefined ? {} : { htmlKind: parsed.htmlKind }),
    };
  }
}

/** `work` over `items` with at most `limit` running; results in input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}
