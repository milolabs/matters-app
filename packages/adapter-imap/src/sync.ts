import type {
  Account,
  AttachmentAnswer,
  AutomatedAnswer,
  FlagUpdate,
  FolderSyncContext,
  KnownLocation,
  Label,
  MessageDocument,
  MessageFlags,
  MessageLocation,
  MimeParserPort,
  ParseContext,
  Participant,
  ReplyToAnswer,
  SyncBatch,
  SyncCursor,
  SyncedDocument,
} from "@matters/core";
import {
  AUTOMATED_HEADER_NAMES,
  isAutomatedByHeaders,
  isTrustedAuthServ,
  localThreadRoot,
  messageKey,
  normalizeReplyTo,
  threadParents,
} from "@matters/core";
import type { FetchMessageObject, ImapFlow, MailboxObject } from "imapflow";
import { gmailLabelId } from "./folders.ts";
import { providerIdOf } from "./providerId.ts";
import { attachmentsOf } from "./structure.ts";

export interface SyncEnv {
  readonly client: ImapFlow;
  readonly parser: MimeParserPort;
  /**
   * With the host of the IMAP server, decides which authserv-ids the account trusts (ADR 0048).
   * Absent: none, and every verdict is "unknown".
   */
  readonly authServ?: {
    readonly imapHost: string;
    readonly registrableDomain: (host: string) => string | undefined;
  };
  readonly gmail: boolean;
  readonly objectId: boolean;
  readonly batchSize: number;
  readonly stats: SyncStats;
}

export interface SyncStats {
  /** Messages whose full source was downloaded. Moves and copies must not raise it. */
  sourcesDownloaded: number;
  /** Times a whole folder's UID list was asked for (`UID SEARCH ALL`): the expensive fallback. */
  fullUidSearches: number;
  /** Times ENVELOPE was asked for the `Reply-To` of stored mail (ADR 0042). Zero when nothing was unknown. */
  replyToFetches: number;
  /** Times the headers were asked for stored mail that did not know if it is automated (ADR 0066). Zero when nothing was unknown. */
  automatedFetches: number;
  /** Times BODYSTRUCTURE was asked for the files of stored mail (ADR 0043). Zero when nothing was unknown. */
  attachmentFetches: number;
}

/** Cursor of one folder; every value is a string, `complete` is "1" or "0". */
interface FolderCursor {
  readonly uidValidity: string;
  /** Highest UID of the synced region (0: nothing yet). */
  readonly lastUid: number;
  /** Lowest UID of the synced region; UIDs below it are still to fetch. */
  readonly lowUid: number;
  /** Every UID the server had is synced (no backfill pending). */
  readonly complete: boolean;
  readonly highestModseq: string | null;
}

function readCursor(raw: SyncCursor | null): FolderCursor | null {
  if (!raw || typeof raw.uidValidity !== "string") return null;
  return {
    uidValidity: raw.uidValidity,
    lastUid: Number(raw.lastUid ?? 0),
    lowUid: Number(raw.lowUid ?? 0),
    complete: raw.complete === "1",
    highestModseq: typeof raw.highestModseq === "string" ? raw.highestModseq : null,
  };
}

function writeCursor(c: FolderCursor): SyncCursor {
  return {
    uidValidity: c.uidValidity,
    lastUid: String(c.lastUid),
    lowUid: String(c.lowUid),
    complete: c.complete ? "1" : "0",
    highestModseq: c.highestModseq,
  };
}

const flagsOf = (flags: ReadonlySet<string> | undefined): MessageFlags => ({
  seen: flags?.has("\\Seen") ?? false,
  flagged: flags?.has("\\Flagged") ?? false,
  answered: flags?.has("\\Answered") ?? false,
  draft: flags?.has("\\Draft") ?? false,
});

const descending = (a: number, b: number) => b - a;

const emailIdKind = (env: SyncEnv) => (env.gmail ? "gmail" : env.objectId ? "objectId" : "none");

function dateMsOf(value: Date | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function addressOf(a: { name?: string | undefined; address?: string | undefined }): Participant[] {
  if (!a.address) return [];
  return [a.name ? { name: a.name, address: a.address } : { address: a.address }];
}

/** The UIDs of the whole folder, ascending. */
async function serverUids(client: ImapFlow): Promise<number[]> {
  const found = await client.search({ all: true }, { uid: true });
  return Array.isArray(found) ? [...found].sort((a, b) => a - b) : [];
}

/** UIDs from `fromUid` up; the server also returns its last message when none is that high. */
async function uidsFrom(client: ImapFlow, fromUid: number): Promise<number[]> {
  const uids: number[] = [];
  for await (const m of client.fetch(`${fromUid}:*`, { uid: true }, { uid: true })) {
    if (m.uid >= fromUid) uids.push(m.uid);
  }
  return uids.sort((a, b) => a - b);
}

async function changedFlags(
  env: SyncEnv,
  since: string,
  known: ReadonlySet<number>,
  at: (uid: number) => MessageLocation,
): Promise<FlagUpdate[]> {
  const updates: FlagUpdate[] = [];
  const query = { uid: true, flags: true, ...(env.gmail ? { labels: true } : {}) };
  for await (const m of env.client.fetch("1:*", query, {
    uid: true,
    changedSince: BigInt(since),
  })) {
    if (!known.has(m.uid)) continue;
    updates.push({
      location: at(m.uid),
      flags: flagsOf(m.flags),
      ...(env.gmail && m.labels ? { labelIds: [...m.labels].map(gmailLabelId) } : {}),
    });
  }
  return updates;
}

interface FolderState {
  readonly account: Account;
  readonly folder: Label;
  readonly uidValidity: string;
  readonly at: (uid: number) => MessageLocation;
}

/**
 * One chunk of UIDs: metadata for all, sources only for messages the store does not know
 * (a move or a copy costs a location, not a download).
 */
async function chunkBatch(
  env: SyncEnv,
  state: FolderState,
  uids: readonly number[],
  context: FolderSyncContext,
): Promise<Pick<SyncBatch, "documents" | "knownLocations" | "attachmentAnswers">> {
  const { client } = env;
  const query = {
    uid: true,
    flags: true,
    envelope: true,
    size: true,
    internalDate: true,
    // The files of every message, a few hundred bytes each and no source (ADR 0043, rule 2).
    bodyStructure: true,
    emailId: true,
    ...(env.gmail || env.objectId ? { threadId: true } : {}),
    ...(env.gmail ? { labels: true } : {}),
  };
  const metas = await client.fetchAll(uids.join(","), query, { uid: true });
  metas.sort((a, b) => b.uid - a.uid);

  const withIds = metas.map((m) => ({
    m,
    providerId: providerIdOf({
      folderId: state.folder.id,
      uidValidity: state.uidValidity,
      uid: m.uid,
      emailId: m.emailId,
      emailIdKind: emailIdKind(env),
      messageId: m.envelope?.messageId,
      dateMs: dateMsOf(m.envelope?.date),
      size: m.size,
    }),
  }));
  const known = await context.knownProviderIds(withIds.map((x) => x.providerId));

  const knownLocations: KnownLocation[] = [];
  const toDownload = new Map<string, typeof withIds>();
  for (const x of withIds) {
    const labelIds = env.gmail && x.m.labels ? [...x.m.labels].map(gmailLabelId) : undefined;
    if (known.has(x.providerId)) {
      knownLocations.push({
        providerId: x.providerId,
        location: state.at(x.m.uid),
        flags: flagsOf(x.m.flags),
        ...(labelIds ? { labelIds } : {}),
      });
    } else {
      // Copies inside this chunk share one download.
      const group = toDownload.get(x.providerId);
      if (group) group.push(x);
      else toDownload.set(x.providerId, [x]);
    }
  }

  const documents: SyncedDocument[] = [];
  const attachmentAnswers: AttachmentAnswer[] = [];
  const firstUids = [...toDownload.values()].map((g) => (g[0] as (typeof withIds)[number]).m.uid);
  const byUid = new Map(withIds.map((x) => [x.m.uid, x]));
  if (firstUids.length > 0) {
    const sources = client.fetch(firstUids.join(","), { uid: true, source: true }, { uid: true });
    for await (const s of sources) {
      const x = byUid.get(s.uid);
      if (!x || !s.source) continue;
      env.stats.sourcesDownloaded++;
      const document = await buildDocument(env, state, x.m, x.providerId, s.source);
      const group = toDownload.get(x.providerId) ?? [];
      for (const [i, member] of group.entries()) {
        if (i === 0) {
          documents.push({ document, location: state.at(member.m.uid) });
          if (member.m.bodyStructure) {
            attachmentAnswers.push({
              location: state.at(member.m.uid),
              attachments: attachmentsOf(member.m.bodyStructure),
            });
          }
        } else {
          knownLocations.push({
            providerId: member.providerId,
            location: state.at(member.m.uid),
            flags: flagsOf(member.m.flags),
          });
        }
      }
    }
  }
  documents.sort((a, b) => b.location.uid - a.location.uid);
  return {
    documents,
    knownLocations,
    ...(attachmentAnswers.length > 0 ? { attachmentAnswers } : {}),
  };
}

function parseContext(env: SyncEnv, address: string): ParseContext {
  const authServ = env.authServ;
  if (!authServ) return {};
  return {
    isTrustedAuthServ: (id) =>
      isTrustedAuthServ({
        id,
        imapHost: authServ.imapHost,
        address,
        registrableDomain: authServ.registrableDomain,
      }),
  };
}

async function buildDocument(
  env: SyncEnv,
  state: FolderState,
  m: FetchMessageObject,
  providerId: string,
  source: Uint8Array,
): Promise<MessageDocument> {
  const parsed = await env.parser.parse(source, parseContext(env, state.account.address));
  const envelope = m.envelope;
  const dateMs =
    dateMsOf(envelope?.date) ?? parsed.dateMs ?? dateMsOf(m.internalDate) ?? Date.now();
  const messageId = envelope?.messageId?.trim() || parsed.messageId;
  const from = parsed.from ?? addressOf(envelope?.from?.[0] ?? {})[0] ?? { address: "" };
  const own = `${state.folder.id}:${state.uidValidity}:${m.uid}`;
  const accountId = state.account.id;
  const threadId = m.threadId
    ? `pt:${accountId}:${m.threadId}`
    : `lt:${accountId}:${
        localThreadRoot({
          messageId,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references,
        }) || own
      }`;
  return {
    message: {
      key: messageKey(dateMs, 0),
      accountId,
      providerId,
      threadId,
      messageIdHeader: messageId,
      // A provider thread is the provider's word; a local one is joined by these (ADR 0091).
      ...(m.threadId
        ? {}
        : {
            parentIds: threadParents({
              messageId,
              inReplyTo: parsed.inReplyTo,
              references: parsed.references,
            }),
          }),
      dateMs,
      from,
      to: parsed.to.length > 0 ? parsed.to : (envelope?.to ?? []).flatMap(addressOf),
      cc: parsed.cc.length > 0 ? parsed.cc : (envelope?.cc ?? []).flatMap(addressOf),
      subject: parsed.subject || envelope?.subject || "",
      snippet: parsed.text.replace(/\s+/g, " ").trim().slice(0, 140),
      flags: flagsOf(m.flags),
      labelIds: env.gmail && m.labels ? [...m.labels].map(gmailLabelId) : [state.folder.id],
      hasAttachments: parsed.attachments.some((a) => !a.inline),
      senderAuth: parsed.senderAuth,
      replyTo: parsed.replyTo,
      // Headers decided it (ADR 0052, rule 4), or the foot of its text (ADR 0111); a message the
      // parser could not read leaves it unknown.
      ...(parsed.automated === undefined ? {} : { automated: parsed.automated }),
    },
    bodyText: parsed.text,
    ...(parsed.html === undefined ? {} : { bodyHtml: parsed.html }),
    ...(parsed.htmlKind === undefined ? {} : { htmlKind: parsed.htmlKind }),
  };
}

/**
 * Asks ENVELOPE for the `Reply-To` of up to one batch of stored messages that do not know it
 * yet (ADR 0042, rule 7): no source is downloaded. The server fills the field with `From` when
 * the header is absent, which `normalizeReplyTo` turns into "none". A UID it does not return
 * stays unknown, and nothing is asked when nothing is unknown.
 */
async function learnReplyTos(
  env: SyncEnv,
  state: FolderState,
  context: FolderSyncContext,
  skip: ReadonlySet<number>,
): Promise<ReplyToAnswer[]> {
  const uids = (await context.unknownReplyToUids(state.uidValidity, env.batchSize)).filter(
    (u) => !skip.has(u),
  );
  if (uids.length === 0) return [];
  env.stats.replyToFetches++;
  const answers: ReplyToAnswer[] = [];
  for (const m of await env.client.fetchAll(
    uids.join(","),
    { uid: true, envelope: true },
    { uid: true },
  )) {
    if (!m.envelope) continue;
    const from = (m.envelope.from ?? []).flatMap(addressOf)[0];
    const replyTo = normalizeReplyTo((m.envelope.replyTo ?? []).flatMap(addressOf), from);
    answers.push({ location: state.at(m.uid), replyTo });
  }
  return answers;
}

/** The `Name: value` lines of a raw header block, with folded lines joined. */
function headerLines(raw: Uint8Array): { key: string; value: string }[] {
  const text = new TextDecoder().decode(raw).replace(/\r?\n[ \t]+/g, " ");
  const out: { key: string; value: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0)
      out.push({ key: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return out;
}

/**
 * Asks for four headers of up to one batch of stored messages that do not know if they are
 * automated yet (ADR 0066, rule 6): no source is downloaded. The decision is the one the parser
 * makes for new mail (`isAutomatedByHeaders`). A UID the server does not return, or returns no
 * header block for, stays unknown, and nothing is asked when nothing is unknown. One batch per
 * folder per run, newest first, so a message that cannot be read costs one batch and never loops.
 */
async function learnAutomated(
  env: SyncEnv,
  state: FolderState,
  context: FolderSyncContext,
  skip: ReadonlySet<number>,
): Promise<AutomatedAnswer[]> {
  const uids = (await context.unknownAutomatedUids(state.uidValidity, env.batchSize)).filter(
    (u) => !skip.has(u),
  );
  if (uids.length === 0) return [];
  env.stats.automatedFetches++;
  const answers: AutomatedAnswer[] = [];
  for (const m of await env.client.fetchAll(
    uids.join(","),
    { uid: true, headers: [...AUTOMATED_HEADER_NAMES] },
    { uid: true },
  )) {
    if (!m.headers) continue;
    answers.push({
      location: state.at(m.uid),
      automated: isAutomatedByHeaders(headerLines(m.headers)),
    });
  }
  return answers;
}

/**
 * Asks BODYSTRUCTURE for the files of up to one batch of stored messages that claim attachments
 * but have not had their structure read (ADR 0043, rule 2): no source is downloaded. A UID the
 * server does not return stays unknown, and nothing is asked when nothing is unknown.
 */
async function learnAttachments(
  env: SyncEnv,
  state: FolderState,
  context: FolderSyncContext,
  skip: ReadonlySet<number>,
): Promise<AttachmentAnswer[]> {
  const uids = (await context.unknownAttachmentUids(state.uidValidity, env.batchSize)).filter(
    (u) => !skip.has(u),
  );
  if (uids.length === 0) return [];
  env.stats.attachmentFetches++;
  const answers: AttachmentAnswer[] = [];
  for (const m of await env.client.fetchAll(
    uids.join(","),
    { uid: true, bodyStructure: true },
    { uid: true },
  )) {
    if (m.bodyStructure) {
      answers.push({ location: state.at(m.uid), attachments: attachmentsOf(m.bodyStructure) });
    }
  }
  return answers;
}

/**
 * Syncs one folder (ADR 0008, 0016). The folder is opened read-only and every fetch peeks, so no
 * message is marked as read.
 *
 * Work plan per run: new UIDs newest first, then older UIDs a previous run did not reach (initial
 * sync, interrupted syncs), then one last batch with flag changes (CONDSTORE `CHANGEDSINCE`),
 * removed locations, the `Reply-To` and the files of old messages (ADR 0042, 0043) and the final
 * cursor. Removals come
 * from QRESYNC `VANISHED` when the counts agree, otherwise from comparing `UID SEARCH ALL` with
 * the locations the store holds.
 */
export async function* syncFolder(
  env: SyncEnv,
  account: Account,
  folder: Label,
  rawCursor: SyncCursor | null,
  context: FolderSyncContext,
): AsyncGenerator<SyncBatch> {
  const { client } = env;
  const cursor = readCursor(rawCursor);

  const vanished = new Set<number>();
  const onExpunge = (e: { path: string; uid?: number; vanished: boolean }) => {
    if (e.path === folder.id && e.vanished && e.uid !== undefined) vanished.add(e.uid);
  };
  client.on("expunge", onExpunge);
  let mailbox: MailboxObject;
  try {
    mailbox = await client.mailboxOpen(folder.id, {
      readOnly: true,
      ...(env.client.enabled.has("QRESYNC") && cursor?.highestModseq
        ? { changedSince: BigInt(cursor.highestModseq), uidValidity: BigInt(cursor.uidValidity) }
        : {}),
    });
  } finally {
    client.off("expunge", onExpunge);
  }

  const uidValidity = String(mailbox.uidValidity);
  const exists = mailbox.exists;
  const modseqNow =
    mailbox.highestModseq !== undefined && !mailbox.noModseq ? String(mailbox.highestModseq) : null;
  const resetting = cursor !== null && cursor.uidValidity !== uidValidity;
  const base: FolderCursor | null = cursor && !resetting ? cursor : null;
  const state: FolderState = {
    account,
    folder,
    uidValidity,
    at: (uid) => ({ accountId: account.id, folderId: folder.id, uidValidity, uid }),
  };

  const stored = resetting ? [] : await context.storedUids(uidValidity);
  const storedSet = new Set(stored);
  let all: number[] | null = null;
  const serverAll = async () => {
    if (all === null) {
      env.stats.fullUidSearches++;
      all = await serverUids(client);
    }
    return all;
  };

  let newUids: number[];
  let removed: number[];
  if (base?.complete) {
    newUids =
      exists > 0 && mailbox.uidNext > base.lastUid + 1
        ? await uidsFrom(client, base.lastUid + 1)
        : [];
    // Trust VANISHED (or "nothing vanished") only if the counts add up; otherwise ask the server.
    const candidate = [...vanished].filter((u) => storedSet.has(u));
    const expected = stored.length - candidate.length + newUids.length;
    if (exists === expected) {
      removed = candidate;
    } else {
      const have = new Set(await serverAll());
      removed = stored.filter((u) => !have.has(u));
      newUids = (await serverAll()).filter((u) => u > base.lastUid);
    }
  } else {
    const uids = await serverAll();
    const have = new Set(uids);
    removed = stored.filter((u) => !have.has(u));
    newUids = uids.filter((u) => u > (base?.lastUid ?? 0));
  }
  const backfill =
    base && !base.complete && base.lowUid > 0
      ? (await serverAll()).filter((u) => u < base.lowUid)
      : [];

  const sinceModseq = base?.highestModseq ?? null;
  // The first run of an epoch starts its CONDSTORE baseline at the state it opened.
  const baselineModseq = sinceModseq ?? modseqNow;

  const tail = [...newUids].sort(descending);
  const back = [...backfill].sort(descending);
  // Synced region: every server UID in [low, high] is in the store. Without one, the first chunk
  // of the newest-first run starts it (its top is the folder's highest UID).
  let region = base && base.lastUid > 0 ? { high: base.lastUid, low: base.lowUid } : null;
  const startedEmpty = region === null;
  let resetPending = resetting;

  const chunks = (list: readonly number[]) => {
    const out: number[][] = [];
    for (let i = 0; i < list.length; i += env.batchSize) out.push(list.slice(i, i + env.batchSize));
    return out;
  };

  const emit = (
    part: Partial<SyncBatch>,
    cursorState: FolderCursor,
    pending?: number,
  ): SyncBatch => {
    const batch: SyncBatch = {
      documents: [],
      knownLocations: [],
      flagUpdates: [],
      removedLocations: [],
      ...part,
      ...(pending === undefined ? {} : { pending }),
      ...(resetPending ? { resetFolder: true as const } : {}),
      cursor: writeCursor(cursorState),
    };
    resetPending = false;
    return batch;
  };
  const cursorAt = (r: { high: number; low: number }, complete: boolean): FolderCursor => ({
    uidValidity,
    lastUid: r.high,
    lowUid: r.low,
    complete,
    highestModseq: baselineModseq,
  });

  // New mail. With a region, `high` moves up only after the whole tail is stored (no gaps).
  const tailChunks = chunks(tail);
  for (const [i, chunk] of tailChunks.entries()) {
    const part = await chunkBatch(env, state, chunk, context);
    const last = i === tailChunks.length - 1;
    const top = tail[0] as number;
    const bottom = Math.min(...chunk);
    if (startedEmpty) region = { high: top, low: bottom };
    else if (region && last) region = { high: Math.max(region.high, top), low: region.low };
    const complete = last && back.length === 0 ? true : (base?.complete ?? false);
    const left = Math.max(0, tail.length - (i + 1) * env.batchSize) + back.length;
    yield emit(part, cursorAt(region as { high: number; low: number }, complete), left);
  }

  // Older mail an earlier run did not reach.
  const backChunks = chunks(back);
  for (const [i, chunk] of backChunks.entries()) {
    const part = await chunkBatch(env, state, chunk, context);
    region = { high: region?.high ?? base?.lastUid ?? 0, low: Math.min(...chunk) };
    const left = Math.max(0, back.length - (i + 1) * env.batchSize);
    yield emit(part, cursorAt(region, i === backChunks.length - 1), left);
  }

  let flagUpdates: FlagUpdate[] = [];
  if (base && sinceModseq !== null && modseqNow !== null && exists > 0 && stored.length > 0) {
    if (BigInt(modseqNow) > BigInt(sinceModseq)) {
      flagUpdates = await changedFlags(env, sinceModseq, new Set(stored), state.at);
    }
  }

  const gone = new Set(removed);
  const replyTos = await learnReplyTos(env, state, context, gone);
  const automatedAnswers = await learnAutomated(env, state, context, gone);
  const attachmentAnswers = await learnAttachments(env, state, context, gone);
  yield emit(
    {
      flagUpdates,
      removedLocations: removed.map(state.at),
      ...(replyTos.length > 0 ? { replyTos } : {}),
      ...(automatedAnswers.length > 0 ? { automatedAnswers } : {}),
      ...(attachmentAnswers.length > 0 ? { attachmentAnswers } : {}),
    },
    {
      uidValidity,
      lastUid: region?.high ?? 0,
      lowUid: region?.low ?? 0,
      complete: true,
      highestModseq: modseqNow,
    },
  );
}
