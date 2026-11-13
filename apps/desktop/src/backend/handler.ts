import type {
  AccountInfo,
  AttachmentInfo,
  BackendRequest,
  BackendResponse,
  ChangePasswordResponse,
  ErrorCode,
  SendAction,
  ServerInput,
  StorageReport,
} from "@matters/contracts";
import type {
  AccountStorePort,
  AgentEffortSetting,
  AttachmentStorePort,
  ComposeRendererPort,
  DeleteForeverResult,
  DiscoveredServers,
  Draft,
  DraftAttachment,
  DraftContent,
  DraftFor,
  DraftStorePort,
  FetchOutcome,
  FilesPort,
  GeneralImages,
  ImageRule,
  ImageRuleDecision,
  ImageRuleScope,
  ImageRuleStorePort,
  MessageBodyPort,
  MessageStorePort,
  MoveAction,
  MoveTarget,
  MoveThreadInput,
  MoveThreadResult,
  NotificationPrefs,
  OutboxPort,
  Participant,
  PeoplePort,
  SavedView,
  SavedViewStorePort,
  SearchIndexPort,
  SendOperation,
  SetSeenResult,
  SortRanked,
  StoppableSource,
  TalkChoice,
  TransportSecurity,
  UndoMoveResult,
  UndoResult,
} from "@matters/core";
import {
  chooseImages,
  draftFor,
  failureDetailOf,
  isAgentEffortSetting,
  isMessageKey,
  isPartId,
  MAX_IMAGE_RULE_VALUE,
  MAX_IMPORTED_ADDRESSES,
  MAX_WRITE_WORDS_CHARS,
  mailErrorKind,
  prepareForwardDraft,
  prepareNewMessage,
  prepareReplyDraft,
  REWRITE_HOWS,
  type RegistrableDomainFn,
  type RewriteHow,
  readNotificationPrefs,
  searchFiles,
  searchMessages,
  suggestPeople,
} from "@matters/core";
import type { AgentApi } from "./agentApi.ts";
import { toAttachmentInfo } from "./attachmentInfo.ts";

/** What the account requests need; `AccountService` implements it over the real ports. */
export interface AccountsApi {
  discover(domain: string): Promise<DiscoveredServers | null>;
  list(): Promise<readonly AccountInfo[]>;
  add(input: {
    address: string;
    displayName: string;
    password: string;
    imap: ServerInput;
    smtp?: ServerInput;
  }): Promise<{ account: AccountInfo; folderCount: number }>;
  /** False when there is no such account. */
  remove(accountId: string): Promise<boolean>;
  syncNow(accountId: string): Promise<boolean>;
  /** Verifies the password, then replaces the saved one (ADR 0113). Null when there is no such account. */
  changePassword(accountId: string, password: string): Promise<PasswordChanged | null>;
}

/** What a password change answers; never the password. */
export type PasswordChanged = Omit<ChangePasswordResponse, "type" | "requestId" | "ok">;

/** Everything about writing and sending mail that changes data: it runs in the sync worker. */
export interface SendApi {
  saveDraft(input: { id?: string; content: DraftContent }): Promise<Draft>;
  deleteDraft(draftId: string): Promise<boolean>;
  requestSend(draftId: string): Promise<SendOperation>;
  undoSend(operationId: string): Promise<UndoResult>;
  sendAction(operationId: string, action: SendAction): Promise<boolean>;
}

/**
 * What the attachment requests need. The router resolves grants into paths (`RemoteAttachments`);
 * nothing here, in either direction, is a path (ADR 0041, rule 3).
 */
export interface AttachmentsApi {
  /** Throws `UnknownGrantError` unless every grant is known and unused. */
  add(
    draftId: string,
    files: readonly { id: string; grantId: string }[],
  ): Promise<readonly AttachmentInfo[]>;
  /** Parts of a received message, by name; the backend takes their name and size from the message. */
  addForwarded(
    draftId: string,
    files: readonly { id: string; messageKey: number; partId: string }[],
  ): Promise<readonly AttachmentInfo[]>;
  check(draftId: string): Promise<readonly string[]>;
  recapture(draftId: string, id: string): Promise<AttachmentInfo | null>;
}

/**
 * Makes a received file exist in the cache (ADR 0043, rule 6). It downloads, so it runs in the
 * sync worker; `RemoteReceived` forwards to it.
 */
export interface ReceivedApi {
  fetch(messageKey: number, partId: string): Promise<FetchOutcome>;
}

/** Starts the once-a-session ask of an account's message limit (ADR 0040, rule 4). */
export interface LimitsApi {
  ensure(account: { id: string; canSend: boolean; messageLimitBytes?: number }): void;
}

/** The view writes; `ViewService` implements it in the worker, `RemoteViews` forwards to it. */
export interface ViewsApi {
  create(input: { name: string; query: string }): Promise<SavedView>;
  updateQuery(id: string, query: string): Promise<SavedView>;
  rename(id: string, name: string): Promise<SavedView>;
  /** Returns whether the view existed. */
  remove(id: string): Promise<boolean>;
  move(id: string, toIndex: number): Promise<void>;
  noteSearch(viewId: string, query: string): Promise<void>;
  forgetSearch(viewId: string, query: string): Promise<void>;
  clearSearches(viewId: string): Promise<void>;
}

/** Marking read and unread; `SeenService` implements it in the worker, `RemoteSeen` forwards to it. */
export interface SeenApi {
  setSeen(keys: readonly number[], seen: boolean): Promise<SetSeenResult>;
}

/** Moving mail; `MoveService` implements it in the worker, `RemoteMoves` forwards to it. */
export interface MoveApi {
  moveThread(input: MoveThreadInput): Promise<MoveThreadResult>;
  undoMove(operationId: string): Promise<UndoMoveResult>;
  deleteForever(keys: readonly number[]): Promise<DeleteForeverResult>;
}

/**
 * The image rule writes (ADR 0037); `ImageRuleService` implements it in the worker, and
 * `RemoteImageRules` forwards to it and tells every window that the rules changed.
 */
/** The notification settings and the test notice (ADR 0071); the router's `Notifier` answers. */
export interface NotificationsApi {
  get(): NotificationPrefs;
  set(prefs: NotificationPrefs): Promise<NotificationPrefs>;
  test(): void;
  /** Pauses banners until then, or resumes them (null); nothing else changes. */
  pause(untilMs: number | null): Promise<NotificationPrefs>;
  /** The system refused the test banner. */
  bannerFailed(reason: string): void;
}

export interface ImagesApi {
  setRule(input: {
    scope: ImageRuleScope;
    value: string;
    decision: ImageRuleDecision;
  }): Promise<ImageRule>;
  /** Returns whether the rule existed. */
  removeRule(scope: ImageRuleScope, value: string): Promise<boolean>;
  stop(input: { address: string; source: StoppableSource }): Promise<void>;
  setGeneral(general: GeneralImages): Promise<void>;
  /** Returns how many rules were added. */
  importAddresses(addresses: readonly string[]): Promise<number>;
}

/**
 * Badge counts (ADR 0027). They run in the sync worker, on its own connection: one count can
 * take tens of milliseconds, and the router's thread must stay free for the next keystroke.
 */
export interface CountApi {
  count(
    query: string,
    cap: number,
    beforeKey?: number,
  ): Promise<{ count: number; nextBeforeKey?: number }>;
  /** The ranked order of a query without a prompt (ADR 0116, rule 4b), in the sync worker. */
  rank?(query: string): Promise<SortRanked>;
}

export interface BackendDeps {
  readonly store: Pick<
    MessageStorePort,
    "getByKeys" | "getThread" | "listNewest" | "listLabels" | "listFolders"
  >;
  readonly index: Pick<SearchIndexPort, "searchChunk" | "matchesAmong">;
  /** Suggestions come from the reader connection like every read (ADR 0028). */
  readonly people: PeoplePort;
  /** Files found by name, from the reader connection like every read (ADR 0074). */
  readonly fileSearch: FilesPort;
  readonly bodies: Pick<MessageBodyPort, "getBodies" | "getHtmlKinds" | "getHtml">;
  /** The stored accounts, for the starting point of a message. */
  readonly accountStore: Pick<AccountStorePort, "list">;
  readonly drafts: Pick<DraftStorePort, "get" | "findByThread">;
  readonly outbox: Pick<OutboxPort, "listVisible">;
  readonly renderer: ComposeRendererPort;
  readonly accounts: AccountsApi;
  readonly send: SendApi;
  /** The files of drafts: the writes go to the sync worker, the list is read here. */
  readonly attachmentWrites: AttachmentsApi;
  readonly attachmentRows: Pick<AttachmentStorePort, "forDraft">;
  readonly limits: LimitsApi;
  /**
   * Received files: the bytes come on demand, over a connection of the worker's own. Without it
   * (a test that does not care) every ask ends `failed`.
   */
  readonly received?: ReceivedApi;
  /** Saved views, read on the reader connection. */
  readonly savedViews: Pick<SavedViewStorePort, "list" | "recentSearches">;
  /** Saved view writes: the router never writes (ADR 0019). */
  readonly viewWrites: ViewsApi;
  /** Image rules, read on the reader connection by their unique key (ADR 0037). */
  readonly imageRules: Pick<ImageRuleStorePort, "get" | "list" | "getGeneral">;
  /** Image rule writes: the router never writes. */
  readonly images: ImagesApi;
  /** Read and unread: the local flag is written by the worker, the server is told later. */
  readonly seen: SeenApi;
  /** Moving mail: the labels change in the worker at once, the server is told later (ADR 0044). */
  readonly moves: MoveApi;
  /** Public Suffix List lookup; core stays free of it. */
  readonly registrableDomain: RegistrableDomainFn;
  /** Not the router's index: see `CountApi`. */
  readonly counts: CountApi;
  /**
   * Agents (ADR 0051, 0052): the reads are answered on the reader connection, the rest goes to
   * the sync worker. Without it (a test that does not care) every agent request fails.
   */
  readonly agent?: AgentApi;
  /** Without it (a test that does not care) the settings are the defaults and nothing is kept. */
  readonly notifications?: NotificationsApi;
  /** Settings › Storage (ADR 0089). Without it every storage request fails. */
  readonly storage?: StorageApi;
  readonly now?: () => number;
}

/** What the database holds, read on the read thread, kept and compacted by the worker. */
export interface StorageApi {
  get(): Promise<StorageReport>;
  measure(): Promise<StorageReport>;
  compact(): Promise<{ readonly freedBytes: number; readonly ms: number }>;
  /** Empties the text read from attached files (ADR 0087); returns how many files it held. */
  clearFileText(): Promise<number>;
}

/** Finished sends stay in the list this long, so the UI can say "Sent". */
export const FINISHED_VISIBLE_MS = 60_000;

const MAX_LIMIT = 500;
const MAX_KEYS = 1000;
/** A person's prefix is what one person types into a field; far more is junk. */
const MAX_PREFIX = 200;
const MAX_DRAFT_TEXT = 2_000_000;
/** Far above any view the use case accepts; keeps junk from travelling to the worker. */
const MAX_VIEW_TEXT = 10_000;
const MAX_RECIPIENTS = 500;
const SECURITIES: readonly string[] = ["tls", "starttls", "none"] satisfies TransportSecurity[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function optionalNumber(v: unknown): number | undefined | "bad" {
  if (v === undefined) return undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : "bad";
}

function participants(v: unknown): Participant[] | null {
  if (!Array.isArray(v) || v.length > MAX_RECIPIENTS) return null;
  const out: Participant[] = [];
  for (const p of v) {
    if (!isRecord(p) || typeof p.address !== "string" || p.address.length > 320) return null;
    if (p.name !== undefined && typeof p.name !== "string") return null;
    out.push(
      typeof p.name === "string" && p.name !== ""
        ? { name: p.name, address: p.address }
        : { address: p.address },
    );
  }
  return out;
}

/** The content of a draft as the renderer sent it, checked field by field. */
function parseContent(v: unknown): DraftContent | null {
  if (!isRecord(v)) return null;
  const [from] = participants([v.from]) ?? [];
  const to = participants(v.to);
  const cc = participants(v.cc);
  const bcc = participants(v.bcc);
  if (
    typeof v.accountId !== "string" ||
    !from ||
    !to ||
    !cc ||
    !bcc ||
    typeof v.subject !== "string" ||
    typeof v.bodyMarkdown !== "string" ||
    v.subject.length > 1000 ||
    v.bodyMarkdown.length > MAX_DRAFT_TEXT ||
    typeof v.inReplyTo !== "string" ||
    !Array.isArray(v.references) ||
    v.references.length > 100 ||
    !v.references.every((r) => typeof r === "string" && r.length < 1000) ||
    (v.threadId !== undefined && typeof v.threadId !== "string")
  ) {
    return null;
  }
  const attachments = v.attachments === undefined ? [] : draftAttachments(v.attachments);
  if (!attachments) return null;
  return {
    accountId: v.accountId,
    from,
    to,
    cc,
    bcc,
    subject: v.subject,
    bodyMarkdown: v.bodyMarkdown,
    inReplyTo: v.inReplyTo,
    references: v.references as string[],
    ...(v.threadId === undefined ? {} : { threadId: v.threadId }),
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(v.forwarded === true ? { forwarded: true } : {}),
  };
}

/** Ids name files in the data directory, so they may not name anything else. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_ATTACHMENTS = 100;

/** The files a draft lists, checked field by field; no path can be among them. */
function draftAttachments(v: unknown): DraftAttachment[] | null {
  if (!Array.isArray(v) || v.length > MAX_ATTACHMENTS) return null;
  const out: DraftAttachment[] = [];
  for (const a of v) {
    if (
      !isRecord(a) ||
      typeof a.id !== "string" ||
      !SAFE_ID.test(a.id) ||
      typeof a.name !== "string" ||
      a.name.length === 0 ||
      a.name.length > 1000 ||
      typeof a.size !== "number" ||
      !Number.isFinite(a.size) ||
      a.size < 0 ||
      !isRecord(a.delivery)
    ) {
      return null;
    }
    const d = a.delivery;
    if (d.kind === "inline") {
      out.push({ id: a.id, name: a.name, size: a.size, delivery: { kind: "inline" } });
    } else if (d.kind === "link" && typeof d.carrierId === "string" && d.carrierId.length < 100) {
      out.push({
        id: a.id,
        name: a.name,
        size: a.size,
        delivery: { kind: "link", carrierId: d.carrierId },
      });
    } else {
      return null;
    }
  }
  return out;
}

function parseServer(v: unknown): ServerInput | null {
  if (
    !isRecord(v) ||
    typeof v.host !== "string" ||
    typeof v.port !== "number" ||
    typeof v.username !== "string" ||
    typeof v.security !== "string" ||
    !SECURITIES.includes(v.security)
  ) {
    return null;
  }
  return {
    host: v.host,
    port: v.port,
    security: v.security as TransportSecurity,
    username: v.username,
  };
}

const RULE_SCOPES: readonly string[] = ["address", "domain"] satisfies ImageRuleScope[];
const RULE_DECISIONS: readonly string[] = ["allow", "deny"] satisfies ImageRuleDecision[];
const STOP_SOURCES: readonly string[] = [
  "address-allow",
  "domain-allow",
  "always",
] satisfies StoppableSource[];
const GENERAL_IMAGES: readonly string[] = ["ask", "always"] satisfies GeneralImages[];

/** Rule values are compared in lower case; the renderer's text is folded here, once. */
function ruleValue(v: unknown): string | null {
  return typeof v === "string" && v.length <= MAX_IMAGE_RULE_VALUE ? v.trim().toLowerCase() : null;
}

const SEND_ACTIONS: readonly string[] = [
  "sendNow",
  "retry",
  "discard",
  "sendAgain",
  "markSent",
  "stop",
] satisfies SendAction[];

const MAX_AGENT_ACCOUNTS = 100;
/** The person's direction or words for a draft: a few paragraphs at most. */
const MAX_GUIDANCE_TEXT = 2000;
/** The subject that goes with a request to write; the request cuts it shorter. */
const MAX_SUBJECT_TEXT = 2000;
const MAX_AGENT_REPLY = 20_000;
/** A name the person types for a talk; the store cuts it to 60 characters (ADR 0086). */
const MAX_TALK_TITLE_TEXT = 500;

/** The runtime and model chosen in a talk (ADR 0121, rule 8): undefined when none, null when bad. */
function talkChoiceOf(v: unknown): TalkChoice | undefined | null {
  if (v === undefined) return undefined;
  if (!isRecord(v) || !shortString(v.runtimeId, 100) || !shortString(v.model, 128)) return null;
  return { runtimeId: v.runtimeId, model: v.model };
}

function isTalkId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

const MODEL_KEYS = ["understand", "write", "answer", "titles"] as const;

function shortString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

/**
 * The thread or the account a request for help with a message names (ADR 0132): exactly one, a
 * short string that is not empty; `null` for both or neither.
 */
function draftForOf(raw: Record<string, unknown>): DraftFor | null {
  const thread = raw.threadId !== undefined;
  if (thread === (raw.accountId !== undefined)) return null;
  if (thread) return shortString(raw.threadId, 1000) ? { threadId: raw.threadId } : null;
  return shortString(raw.accountId, 200) ? { accountId: raw.accountId } : null;
}

/** The agent requests, checked field by field; the service checks the values that mean something. */
function parseAgentRequest(
  raw: Record<string, unknown>,
  requestId: string,
): BackendRequest | string {
  const type = raw.type;
  switch (type) {
    case "agentStatus":
    case "agentDisable":
    case "agentInspect":
    case "agentPauseReading":
    case "agentResumeReading":
    case "agentTalkAllStop":
    case "agentTalks":
    case "agentTalkDeleteAll":
      return { type, requestId };
    case "agentTalkAllEntries": {
      const { talkId, beforeId } = raw;
      if (talkId !== undefined && !isTalkId(talkId)) return "talkId must be a positive integer";
      if (beforeId !== undefined && !isTalkId(beforeId))
        return "beforeId must be a positive integer";
      return {
        type,
        requestId,
        ...(talkId === undefined ? {} : { talkId }),
        ...(beforeId === undefined ? {} : { beforeId }),
      };
    }
    case "agentTalkRename":
      return isTalkId(raw.talkId) &&
        typeof raw.title === "string" &&
        raw.title.length <= MAX_TALK_TITLE_TEXT
        ? { type, requestId, talkId: raw.talkId, title: raw.title }
        : "talkId and a short title are required";
    case "agentTalkDelete":
      return isTalkId(raw.talkId)
        ? { type, requestId, talkId: raw.talkId }
        : "talkId must be a positive integer";
    case "agentThread":
      return shortString(raw.threadId, 1000)
        ? { type, requestId, threadId: raw.threadId }
        : "threadId must be a string";
    case "agentJournal":
      if (raw.limit === undefined) return { type, requestId };
      return typeof raw.limit === "number" &&
        Number.isInteger(raw.limit) &&
        raw.limit >= 1 &&
        raw.limit <= 200
        ? { type, requestId, limit: raw.limit }
        : "limit must be an integer from 1 to 200";
    case "agentRules":
    case "agentInstructions":
      return { type, requestId };
    case "agentRemember":
      return shortString(raw.threadId, 1000) &&
        typeof raw.words === "string" &&
        raw.words.length <= MAX_GUIDANCE_TEXT
        ? { type, requestId, threadId: raw.threadId, words: raw.words }
        : "threadId and short words are required";
    case "agentAddInstruction": {
      const scope = raw.scope;
      if (scope !== "general" && scope !== "understand" && scope !== "write") {
        return "scope must be general, understand or write";
      }
      // The service words what is wrong with a blank or long text; only absurd sizes stop here.
      return typeof raw.text === "string" && raw.text.length <= 5000
        ? { type, requestId, scope, text: raw.text }
        : "text must be a string";
    }
    case "agentRemoveInstruction":
      return typeof raw.instructionId === "number" &&
        Number.isInteger(raw.instructionId) &&
        raw.instructionId >= 1
        ? { type, requestId, instructionId: raw.instructionId }
        : "instructionId must be a positive integer";
    case "agentRuleOffer":
      return shortString(raw.threadId, 1000)
        ? { type, requestId, threadId: raw.threadId }
        : "threadId must be a string";
    case "agentAddRule": {
      const scope = raw.scope;
      if (scope !== "sender" && scope !== "domain" && scope !== "type" && scope !== "category") {
        return "scope must be sender, domain, type or category";
      }
      if (raw.threadId !== undefined) {
        // The sender of a thread: the address comes from the store, so a subject is not accepted.
        return scope === "sender" && shortString(raw.threadId, 1000) && raw.subject === undefined
          ? { type, requestId, threadId: raw.threadId, scope }
          : "a thread rule is for its sender and takes no subject";
      }
      return typeof raw.subject === "string" && raw.subject.length <= 400
        ? { type, requestId, scope, subject: raw.subject }
        : "subject must be a short string";
    }
    case "agentRemoveRule":
      return typeof raw.ruleId === "number" && Number.isInteger(raw.ruleId) && raw.ruleId >= 1
        ? { type, requestId, ruleId: raw.ruleId }
        : "ruleId must be a positive integer";
    case "agentSetEnabled": {
      const ids = raw.accountIds;
      if (
        !Array.isArray(ids) ||
        ids.length > MAX_AGENT_ACCOUNTS ||
        !ids.every((id) => shortString(id, 200))
      ) {
        return "accountIds must be a list of account ids";
      }
      return shortString(raw.runtimeId, 100)
        ? { type, requestId, accountIds: ids as string[], runtimeId: raw.runtimeId }
        : "runtimeId must be a string";
    }
    case "agentSetModels": {
      if (!isRecord(raw.models)) return "models must be an object";
      const models: Partial<Record<(typeof MODEL_KEYS)[number], string>> = {};
      for (const [key, value] of Object.entries(raw.models)) {
        if (!(MODEL_KEYS as readonly string[]).includes(key) || !shortString(value, 64)) {
          return "models holds understand, write, answer and titles, as short strings";
        }
        models[key as (typeof MODEL_KEYS)[number]] = value;
      }
      if (raw.efforts === undefined) return { type, requestId, models };
      if (!isRecord(raw.efforts)) return "efforts must be an object";
      const efforts: Partial<Record<(typeof MODEL_KEYS)[number], AgentEffortSetting>> = {};
      for (const [key, value] of Object.entries(raw.efforts)) {
        if (!(MODEL_KEYS as readonly string[]).includes(key) || !isAgentEffortSetting(value)) {
          return "efforts holds understand, write, answer and titles, as levels of effort";
        }
        efforts[key as (typeof MODEL_KEYS)[number]] = value;
      }
      return { type, requestId, models, efforts };
    }
    case "agentTestRuntime":
      if (raw.runtimeId === undefined) return { type, requestId };
      return shortString(raw.runtimeId, 100)
        ? { type, requestId, runtimeId: raw.runtimeId }
        : "runtimeId must be a string";
    case "agentSetKindRuntime": {
      const kinds = raw.kinds;
      if (
        !Array.isArray(kinds) ||
        kinds.length === 0 ||
        kinds.length > MODEL_KEYS.length ||
        !kinds.every((k) => (MODEL_KEYS as readonly unknown[]).includes(k))
      ) {
        return "kinds holds understand, write, answer or titles";
      }
      return shortString(raw.runtimeId, 100)
        ? {
            type,
            requestId,
            kinds: kinds as (typeof MODEL_KEYS)[number][],
            runtimeId: raw.runtimeId,
          }
        : "runtimeId must be a string";
    }
    case "agentSetWeekShare":
      return typeof raw.percent === "number" && Number.isFinite(raw.percent)
        ? { type, requestId, percent: raw.percent }
        : "percent must be a number";
    case "agentSetTalkLoop":
      return typeof raw.on === "boolean"
        ? { type, requestId, on: raw.on }
        : "on must be true or false";
    case "agentPrepare": {
      if (!shortString(raw.threadId, 1000)) return "threadId must be a string";
      for (const text of [raw.direction, raw.answer]) {
        if (text !== undefined && (typeof text !== "string" || text.length > MAX_GUIDANCE_TEXT)) {
          return "direction and answer must be short strings";
        }
      }
      return {
        type,
        requestId,
        threadId: raw.threadId,
        ...(typeof raw.direction === "string" ? { direction: raw.direction } : {}),
        ...(typeof raw.answer === "string" ? { answer: raw.answer } : {}),
      };
    }
    case "agentTalk": {
      const choice = talkChoiceOf(raw.choice);
      if (choice === null) return "choice holds a runtimeId and a model, as short strings";
      return shortString(raw.threadId, 1000) &&
        typeof raw.words === "string" &&
        raw.words.length <= MAX_GUIDANCE_TEXT
        ? {
            type,
            requestId,
            threadId: raw.threadId,
            words: raw.words,
            ...(choice === undefined ? {} : { choice }),
          }
        : "threadId and short words are required";
    }
    case "agentWriteDraft": {
      const about = draftForOf(raw);
      if (about === null) return "exactly one of threadId and accountId is required";
      if (typeof raw.text !== "string" || raw.text.length > MAX_DRAFT_TEXT) {
        return "text must be the draft's text";
      }
      if (typeof raw.subject !== "string" || raw.subject.length > MAX_SUBJECT_TEXT) {
        return "subject must be a short string";
      }
      return typeof raw.words === "string" &&
        raw.words.trim() !== "" &&
        raw.words.length <= MAX_WRITE_WORDS_CHARS
        ? { type, requestId, ...about, subject: raw.subject, text: raw.text, words: raw.words }
        : "words must say, briefly, what to write";
    }
    case "agentRewriteDraft": {
      const about = draftForOf(raw);
      if (about === null) return "exactly one of threadId and accountId is required";
      if (typeof raw.text !== "string" || raw.text.length > MAX_DRAFT_TEXT) {
        return "text must be the draft's text";
      }
      return REWRITE_HOWS.includes(raw.how as RewriteHow)
        ? { type, requestId, ...about, text: raw.text, how: raw.how as RewriteHow }
        : "how must be shorter, formal or english";
    }
    case "agentAnswerQuestions":
    case "agentCheckReply":
    case "agentFillGaps": {
      if (!shortString(raw.threadId, 1000)) return "threadId must be a string";
      if (typeof raw.text !== "string" || raw.text.length > MAX_DRAFT_TEXT) {
        return "text must be the draft's text";
      }
      if (type === "agentAnswerQuestions" && raw.missing !== undefined) {
        const missing = raw.missing;
        if (
          !Array.isArray(missing) ||
          missing.length > 10 ||
          !missing.every((m) => typeof m === "string" && m.length <= 200)
        ) {
          return "missing must be a short list of short phrases";
        }
        return { type, requestId, threadId: raw.threadId, text: raw.text, missing };
      }
      return { type, requestId, threadId: raw.threadId, text: raw.text };
    }
    case "agentTalkAll": {
      if (raw.talkId !== undefined && !isTalkId(raw.talkId)) {
        return "talkId must be a positive integer";
      }
      const choice = talkChoiceOf(raw.choice);
      if (choice === null) return "choice holds a runtimeId and a model, as short strings";
      return typeof raw.words === "string" && raw.words.length <= MAX_GUIDANCE_TEXT
        ? {
            type,
            requestId,
            words: raw.words,
            ...(raw.talkId === undefined ? {} : { talkId: raw.talkId }),
            ...(choice === undefined ? {} : { choice }),
          }
        : "short words are required";
    }
    case "agentTalkStop":
    case "agentTalkEntries":
      return shortString(raw.threadId, 1000)
        ? { type, requestId, threadId: raw.threadId }
        : "threadId must be a string";
    case "agentUndoFeedback":
      return shortString(raw.threadId, 1000) &&
        (raw.kind === "notImportant" || raw.kind === "later" || raw.kind === "closed")
        ? { type, requestId, threadId: raw.threadId, kind: raw.kind }
        : "threadId and a kind (notImportant, later or closed) are required";
    case "agentRevokeConsent":
      if (raw.runtimeId !== undefined && !shortString(raw.runtimeId, 100)) {
        return "runtimeId must be a string";
      }
      return shortString(raw.accountId, 200)
        ? {
            type,
            requestId,
            accountId: raw.accountId,
            ...(typeof raw.runtimeId === "string" ? { runtimeId: raw.runtimeId } : {}),
          }
        : "accountId must be a string";
    case "agentDraftFromPrepared":
      return shortString(raw.threadId, 1000) && shortString(raw.body, MAX_AGENT_REPLY)
        ? { type, requestId, threadId: raw.threadId, body: raw.body }
        : "threadId and a body are required";
    case "agentMatchAct":
    case "agentPromptCount":
    case "agentPromptVerdicts":
    case "agentPromptBadge":
      return typeof raw.query === "string" && raw.query.length <= MAX_VIEW_TEXT
        ? { type, requestId, query: raw.query }
        : "query must be a short string";
    case "agentPromptRun":
      if (typeof raw.query !== "string" || raw.query.length > MAX_VIEW_TEXT) {
        return "query must be a short string";
      }
      if (raw.again !== undefined && typeof raw.again !== "boolean") {
        return "again must be a boolean";
      }
      if (raw.readAll !== undefined && typeof raw.readAll !== "boolean") {
        return "readAll must be a boolean";
      }
      return {
        type,
        requestId,
        query: raw.query,
        ...(raw.again === true ? { again: true } : {}),
        ...(raw.readAll === true ? { readAll: true } : {}),
      };
    case "agentPromptStop":
      return { type, requestId };
    case "agentReadingStatus":
      return { type, requestId, ...(raw.fresh === true ? { fresh: true } : {}) };
    default:
      return "unknown request type";
  }
}

const MOVE_ACTIONS: readonly string[] = [
  "archive",
  "delete",
  "spam",
  "move",
] satisfies MoveAction[];
const MOVE_ROLES: readonly string[] = ["inbox", "archive", "trash", "spam"];

/** A place to move to: one of four roles, or a folder id of a sensible length. */
function moveTarget(v: unknown): MoveTarget | null {
  if (!isRecord(v)) return null;
  if (typeof v.role === "string" && MOVE_ROLES.includes(v.role)) {
    return { role: v.role as "inbox" | "archive" | "trash" | "spam" };
  }
  return typeof v.folderId === "string" && v.folderId.length > 0 && v.folderId.length <= 1000
    ? { folderId: v.folderId }
    : null;
}

function parseRequest(raw: unknown): BackendRequest | string {
  if (!isRecord(raw)) return "request must be an object";
  const { type, requestId } = raw;
  if (typeof requestId !== "string") return "requestId must be a string";
  const beforeKey = optionalNumber(raw.beforeKey);
  if (beforeKey === "bad") return "beforeKey must be a number";
  const afterKey = optionalNumber(raw.afterKey);
  if (afterKey === "bad") return "afterKey must be a number";
  const limit = raw.limit;
  const hasLimit = typeof limit === "number" && Number.isInteger(limit);
  const pageLimit = hasLimit ? Math.min(Math.max(limit, 1), MAX_LIMIT) : 0;

  switch (type) {
    case "listNewest": {
      if (!hasLimit) return "limit must be an integer";
      const labelId = raw.labelId;
      if (labelId !== undefined && typeof labelId !== "string") return "labelId must be a string";
      return {
        type,
        requestId,
        limit: pageLimit,
        ...(labelId === undefined ? {} : { labelId }),
        ...(beforeKey === undefined ? {} : { beforeKey }),
      };
    }
    case "openThread":
      if (typeof raw.threadId !== "string") return "threadId must be a string";
      if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") {
        return "hidden must be true or false";
      }
      return {
        type,
        requestId,
        threadId: raw.threadId,
        ...(raw.hidden === undefined ? {} : { hidden: raw.hidden }),
      };
    case "search":
      if (!hasLimit || typeof raw.query !== "string") return "query and limit are required";
      return {
        type,
        requestId,
        query: raw.query,
        limit: pageLimit,
        ...(beforeKey === undefined ? {} : { beforeKey }),
        ...(afterKey === undefined ? {} : { afterKey }),
      };
    case "getMessages": {
      const keys = raw.keys;
      if (!Array.isArray(keys) || keys.length > MAX_KEYS || !keys.every(Number.isFinite)) {
        return `keys must be at most ${MAX_KEYS} numbers`;
      }
      return { type, requestId, keys: keys as number[] };
    }
    case "getMessageHtml":
      return Number.isFinite(raw.key)
        ? { type, requestId, key: raw.key as number }
        : "key must be a number";
    case "setSeen": {
      const keys = raw.keys;
      if (!Array.isArray(keys) || keys.length > MAX_KEYS || !keys.every(Number.isFinite)) {
        return `keys must be at most ${MAX_KEYS} numbers`;
      }
      if (typeof raw.seen !== "boolean") return "seen must be true or false";
      return { type, requestId, keys: keys as number[], seen: raw.seen };
    }
    case "moveThread": {
      if (typeof raw.threadId !== "string") return "threadId must be a string";
      const others = raw.others;
      if (
        others !== undefined &&
        (!Array.isArray(others) ||
          others.length > MAX_KEYS ||
          !others.every((id) => typeof id === "string"))
      ) {
        return `others must be at most ${MAX_KEYS} thread ids`;
      }
      if (typeof raw.action !== "string" || !MOVE_ACTIONS.includes(raw.action)) {
        return "action must be archive, delete, spam or move";
      }
      if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") {
        return "hidden must be true or false";
      }
      const target = raw.target === undefined ? undefined : moveTarget(raw.target);
      if (target === null) return "target must be a role or a folder";
      if (raw.action === "move" && target === undefined) return "move needs a target";
      return {
        type,
        requestId,
        threadId: raw.threadId,
        ...(others === undefined ? {} : { others: others as string[] }),
        action: raw.action as MoveAction,
        ...(target === undefined ? {} : { target }),
        ...(raw.hidden === undefined ? {} : { hidden: raw.hidden }),
      };
    }
    case "undoMove":
      return typeof raw.operationId === "string" && raw.operationId.length <= 100
        ? { type, requestId, operationId: raw.operationId }
        : "operationId must be a string";
    case "deleteForever": {
      const keys = raw.keys;
      if (!Array.isArray(keys) || keys.length > MAX_KEYS || !keys.every(isMessageKey)) {
        return `keys must be at most ${MAX_KEYS} message keys`;
      }
      return { type, requestId, keys: keys as number[] };
    }
    case "listFolders":
    case "getNotificationPrefs":
    case "testNotification":
      return { type, requestId };
    case "setNotificationPrefs":
      return isRecord(raw.prefs)
        ? { type, requestId, prefs: readNotificationPrefs(raw.prefs) }
        : "prefs must be an object";
    case "pauseNotifications":
      return raw.untilMs === null ||
        (typeof raw.untilMs === "number" && Number.isFinite(raw.untilMs) && raw.untilMs > 0)
        ? { type, requestId, untilMs: raw.untilMs }
        : "untilMs must be a time or null";
    case "bannerFailed":
      return typeof raw.reason === "string"
        ? { type, requestId, reason: raw.reason.slice(0, 200) }
        : "reason must be a string";
    case "getImageChoice":
      return Number.isFinite(raw.key)
        ? { type, requestId, key: raw.key as number }
        : "key must be a number";
    case "listImageRules":
    case "getStorage":
    case "measureStorage":
    case "compactStorage":
    case "clearFileText":
      return { type, requestId };
    case "setImageRule": {
      const value = ruleValue(raw.value);
      if (
        typeof raw.scope !== "string" ||
        !RULE_SCOPES.includes(raw.scope) ||
        typeof raw.decision !== "string" ||
        !RULE_DECISIONS.includes(raw.decision) ||
        value === null
      ) {
        return "a rule needs a scope (address or domain), a value and a decision (allow or deny)";
      }
      return {
        type,
        requestId,
        scope: raw.scope as ImageRuleScope,
        value,
        decision: raw.decision as ImageRuleDecision,
      };
    }
    case "removeImageRule": {
      const value = ruleValue(raw.value);
      if (typeof raw.scope !== "string" || !RULE_SCOPES.includes(raw.scope) || value === null) {
        return "a rule needs a scope (address or domain) and a value";
      }
      return { type, requestId, scope: raw.scope as ImageRuleScope, value };
    }
    case "stopImages": {
      const address = ruleValue(raw.address);
      if (
        address === null ||
        typeof raw.source !== "string" ||
        !STOP_SOURCES.includes(raw.source)
      ) {
        return "an address and a source (address-allow, domain-allow or always) are required";
      }
      return { type, requestId, address, source: raw.source as StoppableSource };
    }
    case "setGeneralImages":
      return typeof raw.general === "string" && GENERAL_IMAGES.includes(raw.general)
        ? { type, requestId, general: raw.general as GeneralImages }
        : "general must be ask or always";
    case "importImageAddresses": {
      const list = raw.addresses;
      if (!Array.isArray(list) || list.length > MAX_IMPORTED_ADDRESSES) {
        return `addresses must be at most ${MAX_IMPORTED_ADDRESSES} strings`;
      }
      const addresses: string[] = [];
      for (const a of list) {
        const value = ruleValue(a);
        if (value === null) return "addresses must be strings of at most 320 characters";
        addresses.push(value);
      }
      return { type, requestId, addresses };
    }
    case "listLabels":
      return { type, requestId };
    case "suggestPeople":
      if (typeof raw.prefix !== "string" || !hasLimit)
        return "prefix and an integer limit are required";
      if (raw.prefix.length > MAX_PREFIX) return "prefix is too long";
      return { type, requestId, prefix: raw.prefix, limit: pageLimit };
    case "searchFiles": {
      if (typeof raw.text !== "string") return "text is required";
      if (raw.text.length > MAX_PREFIX) return "text is too long";
      if (raw.accountId !== undefined && typeof raw.accountId !== "string")
        return "accountId must be a string";
      return {
        type,
        requestId,
        text: raw.text,
        ...(hasLimit ? { limit: pageLimit } : {}),
        ...(raw.accountId === undefined ? {} : { accountId: raw.accountId }),
      };
    }
    case "discoverServers":
      return typeof raw.domain === "string" && raw.domain.length <= 255
        ? { type, requestId, domain: raw.domain }
        : "domain must be a string";
    case "listAccounts":
      return { type, requestId };
    case "addAccount": {
      const imap = parseServer(raw.imap);
      const smtp = raw.smtp === undefined ? undefined : parseServer(raw.smtp);
      if (
        typeof raw.address !== "string" ||
        typeof raw.password !== "string" ||
        (raw.displayName !== undefined && typeof raw.displayName !== "string") ||
        !imap ||
        smtp === null
      ) {
        return "address, password and imap {host, port, security, username} are required";
      }
      return {
        type,
        requestId,
        address: raw.address,
        password: raw.password,
        ...(raw.displayName === undefined ? {} : { displayName: raw.displayName }),
        imap,
        ...(smtp === undefined ? {} : { smtp }),
      };
    }
    case "prepareNew":
      if (raw.accountId !== undefined && typeof raw.accountId !== "string") {
        return "accountId must be a string";
      }
      return {
        type,
        requestId,
        ...(raw.accountId === undefined ? {} : { accountId: raw.accountId }),
      };
    case "prepareReply":
      return typeof raw.threadId === "string" && (raw.mode === "reply" || raw.mode === "replyAll")
        ? { type, requestId, threadId: raw.threadId, mode: raw.mode }
        : "threadId and mode (reply or replyAll) are required";
    case "prepareForward":
      if (typeof raw.threadId !== "string") return "threadId must be a string";
      if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") {
        return "hidden must be true or false";
      }
      return {
        type,
        requestId,
        threadId: raw.threadId,
        ...(raw.hidden === undefined ? {} : { hidden: raw.hidden }),
      };
    case "getDraft":
    case "deleteDraft":
    case "requestSend":
      return typeof raw.draftId === "string"
        ? { type, requestId, draftId: raw.draftId }
        : "draftId must be a string";
    case "saveDraft": {
      const content = parseContent(raw.content);
      if (!content) return "content is not a draft";
      if (raw.id !== undefined && typeof raw.id !== "string") return "id must be a string";
      return { type, requestId, content, ...(raw.id === undefined ? {} : { id: raw.id }) };
    }
    case "listViews":
      return { type, requestId };
    case "saveView": {
      const { id, name, query } = raw;
      if (id !== undefined && typeof id !== "string") return "id must be a string";
      for (const text of [name, query]) {
        if (text !== undefined && (typeof text !== "string" || text.length > MAX_VIEW_TEXT)) {
          return "name and query must be strings";
        }
      }
      if (id === undefined && (name === undefined || query === undefined)) {
        return "a new view needs a name and a query";
      }
      if (id !== undefined && (name === undefined) === (query === undefined)) {
        return "send either a name or a query for a view";
      }
      return {
        type,
        requestId,
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name: name as string }),
        ...(query === undefined ? {} : { query: query as string }),
      };
    }
    case "deleteView":
      return typeof raw.id === "string" ? { type, requestId, id: raw.id } : "id must be a string";
    case "listSearches":
    case "clearSearches":
      return typeof raw.viewId === "string"
        ? { type, requestId, viewId: raw.viewId }
        : "viewId must be a string";
    case "noteSearch":
    case "forgetSearch":
      if (typeof raw.viewId !== "string" || typeof raw.query !== "string")
        return "viewId and query must be strings";
      if (raw.query.length > MAX_VIEW_TEXT) return "query is too long";
      return { type, requestId, viewId: raw.viewId, query: raw.query };
    case "moveView":
      return typeof raw.id === "string" &&
        typeof raw.toIndex === "number" &&
        Number.isInteger(raw.toIndex)
        ? { type, requestId, id: raw.id, toIndex: raw.toIndex }
        : "id and an integer toIndex are required";
    case "sortRanked":
      return typeof raw.query === "string" && raw.query.length <= MAX_VIEW_TEXT
        ? { type, requestId, query: raw.query }
        : "query must be a short string";
    case "countMatches":
      if (!Number.isInteger(raw.cap) || typeof raw.query !== "string") {
        return "query and an integer cap are required";
      }
      if (raw.query.length > MAX_VIEW_TEXT) return "query is too long";
      return {
        type,
        requestId,
        query: raw.query,
        cap: Math.min(Math.max(raw.cap as number, 1), MAX_LIMIT),
        ...(beforeKey === undefined ? {} : { beforeKey }),
      };
    case "renderPreview":
      return typeof raw.markdown === "string" && raw.markdown.length <= MAX_DRAFT_TEXT
        ? { type, requestId, markdown: raw.markdown }
        : "markdown must be a string";
    case "undoSend":
      return typeof raw.operationId === "string"
        ? { type, requestId, operationId: raw.operationId }
        : "operationId must be a string";
    case "sendAction":
      return typeof raw.operationId === "string" &&
        typeof raw.action === "string" &&
        SEND_ACTIONS.includes(raw.action)
        ? { type, requestId, operationId: raw.operationId, action: raw.action as SendAction }
        : "operationId and a known action are required";
    case "listOutbox":
      return { type, requestId };
    case "addAttachments": {
      const files = raw.files;
      if (typeof raw.draftId !== "string") return "draftId must be a string";
      if (!Array.isArray(files) || files.length === 0 || files.length > MAX_ATTACHMENTS) {
        return `files must be 1 to ${MAX_ATTACHMENTS} entries`;
      }
      const checked: { id: string; grantId: string }[] = [];
      for (const f of files) {
        if (
          !isRecord(f) ||
          typeof f.id !== "string" ||
          !SAFE_ID.test(f.id) ||
          typeof f.grantId !== "string" ||
          f.grantId.length === 0 ||
          f.grantId.length > 100
        ) {
          return "every file needs an id and a grantId";
        }
        // Only these two keys travel on: a path sent along is dropped here, not ignored later.
        checked.push({ id: f.id, grantId: f.grantId });
      }
      return { type, requestId, draftId: raw.draftId, files: checked };
    }
    case "addForwardedAttachments": {
      const files = raw.files;
      if (typeof raw.draftId !== "string") return "draftId must be a string";
      if (!Array.isArray(files) || files.length === 0 || files.length > MAX_ATTACHMENTS) {
        return `files must be 1 to ${MAX_ATTACHMENTS} entries`;
      }
      const checked: { id: string; messageKey: number; partId: string }[] = [];
      for (const f of files) {
        if (
          !isRecord(f) ||
          typeof f.id !== "string" ||
          !SAFE_ID.test(f.id) ||
          !isMessageKey(f.messageKey) ||
          !isPartId(f.partId)
        ) {
          return "every file needs an id, a messageKey and a partId";
        }
        checked.push({ id: f.id, messageKey: f.messageKey, partId: f.partId });
      }
      return { type, requestId, draftId: raw.draftId, files: checked };
    }
    case "checkAttachmentSources":
    case "listAttachments":
      return typeof raw.draftId === "string"
        ? { type, requestId, draftId: raw.draftId }
        : "draftId must be a string";
    case "fetchReceived":
      // Both name a directory of the cache, so both are checked here and again by main.
      return isMessageKey(raw.messageKey) && isPartId(raw.partId)
        ? { type, requestId, messageKey: raw.messageKey, partId: raw.partId }
        : "messageKey and partId are required";
    case "recaptureAttachment":
      return typeof raw.draftId === "string" && typeof raw.id === "string" && SAFE_ID.test(raw.id)
        ? { type, requestId, draftId: raw.draftId, id: raw.id }
        : "draftId and id are required";
    case "removeAccount":
    case "syncNow":
      return typeof raw.accountId === "string"
        ? { type, requestId, accountId: raw.accountId }
        : "accountId must be a string";
    case "changePassword":
      // Its length is checked in the core, which says so in words the form can show.
      return typeof raw.accountId === "string" &&
        raw.accountId !== "" &&
        raw.accountId.length <= 200 &&
        typeof raw.password === "string"
        ? { type, requestId, accountId: raw.accountId, password: raw.password }
        : "accountId and password are required";
    default:
      return typeof type === "string" && type.startsWith("agent")
        ? parseAgentRequest(raw, requestId)
        : "unknown request type";
  }
}

const CODE_OF_KIND: Readonly<Record<string, ErrorCode>> = {
  auth: "authFailed",
  tls: "tlsFailed",
  unreachable: "unreachable",
  insecure: "insecureTransport",
  credentials: "credentialsUnavailable",
};

/**
 * What went wrong, for the person at the keyboard. Messages of these errors never contain the
 * password (adapters scrub them); nothing else of the request is echoed.
 */
function errorCodeOf(error: unknown): ErrorCode {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AccountExistsError") return "accountExists";
  if (name === "InvalidAccountError") return "invalidAccount";
  if (name === "OutgoingServerError") {
    return (error as { kind?: unknown }).kind === "auth" ? "outgoingAuthFailed" : "outgoingFailed";
  }
  if (name === "SendBlockedError") return "sendBlocked";
  // A grant that is unknown, spent or expired: asking again with it can never work.
  if (name === "UnknownGrantError") return "invalidRequest";
  if (name === "InvalidViewError") return "invalidView";
  if (name === "InvalidImageRuleError") return "invalidRequest";
  if (name === "ViewNotFoundError") return "notFound";
  if (name === "DraftNotFoundError" || name === "NoAccountError") return "notFound";
  if (name === "AccountNotFoundError") return "notFound";
  if (name === "ThingNotFoundError") return "notFound";
  if (name === "InvalidAgentSettingError") return "invalidRequest";
  if (name === "AgentUnavailableError") return "agentUnavailable";
  return CODE_OF_KIND[mailErrorKind(error)] ?? "internal";
}

/** The account's known limit; an unknown one starts the once-a-session ask in the background. */
async function messageLimit(deps: BackendDeps, accountId: string): Promise<number | null> {
  const account = (await deps.accountStore.list()).find((a) => a.id === accountId);
  if (!account) return null;
  deps.limits.ensure({
    id: account.id,
    canSend: account.smtp !== undefined,
    ...(account.messageLimitBytes === undefined
      ? {}
      : { messageLimitBytes: account.messageLimitBytes }),
  });
  return account.messageLimitBytes ?? null;
}

/** The images of one message: two keyed rule lookups, the setting, and what the verdict allows. */
async function imageChoice(deps: BackendDeps, key: number) {
  const [message] = await deps.store.getByKeys([key]);
  return message
    ? chooseImages(
        { rules: deps.imageRules, registrableDomain: deps.registrableDomain },
        message.from.address,
        message.senderAuth,
      )
    : null;
}

function needStorage(deps: BackendDeps): StorageApi {
  if (deps.storage === undefined) throw new Error("Storage is not available");
  return deps.storage;
}

function needAgent(deps: BackendDeps): AgentApi {
  if (deps.agent === undefined) throw new Error("Agents are not available");
  return deps.agent;
}

/** Serves one request. Total: failures become `ErrorResponse`, never a throw. */
export async function handle(deps: BackendDeps, raw: unknown): Promise<BackendResponse> {
  const requestId = isRecord(raw) && typeof raw.requestId === "string" ? raw.requestId : "";
  const request = parseRequest(raw);
  if (typeof request === "string") {
    return { type: "error", requestId, ok: false, code: "invalidRequest", message: request };
  }
  try {
    switch (request.type) {
      case "listNewest": {
        const messages = await deps.store.listNewest({
          limit: request.limit,
          ...(request.labelId === undefined ? {} : { labelId: request.labelId }),
          ...(request.beforeKey === undefined ? {} : { beforeKey: request.beforeKey }),
        });
        return { type: "listNewest", requestId, ok: true, messages };
      }
      case "openThread": {
        // Deleted mail stays out of a thread unless it is looked at from Trash or Spam (ADR 0044).
        const view = await deps.store.getThread(request.threadId, {
          visibleOnly: request.hidden !== true,
        });
        if (!view) {
          return {
            type: "error",
            requestId,
            ok: false,
            code: "notFound",
            message: "no such thread",
          };
        }
        const keys = view.messages.map((m) => m.key);
        const texts = await deps.bodies.getBodies(keys);
        const kinds = await deps.bodies.getHtmlKinds(keys);
        return {
          type: "openThread",
          requestId,
          ok: true,
          thread: view.thread,
          messages: view.messages.map((m) => {
            const htmlKind = kinds.get(m.key);
            const files = view.attachments.get(m.key);
            return {
              ...m,
              bodyText: texts.get(m.key) ?? "",
              ...(htmlKind === undefined ? {} : { htmlKind }),
              attachments: files?.items ?? [],
              // A message the store has no word on has nothing to wait for.
              attachmentsKnown: files?.known ?? true,
              hasInline: files?.hasInline ?? false,
            };
          }),
        };
      }
      case "getMessages":
        return {
          type: "getMessages",
          requestId,
          ok: true,
          messages: await deps.store.getByKeys(request.keys),
        };
      case "getMessageHtml": {
        const [html, images] = await Promise.all([
          deps.bodies.getHtml(request.key),
          imageChoice(deps, request.key),
        ]);
        return { type: "getMessageHtml", requestId, ok: true, html: html ?? null, images };
      }
      case "setSeen": {
        const done = await deps.seen.setSeen(request.keys, request.seen);
        return { type: "setSeen", requestId, ok: true, ...done };
      }
      case "moveThread": {
        const done = await deps.moves.moveThread({
          threadId: request.threadId,
          ...(request.others === undefined ? {} : { others: request.others }),
          action: request.action,
          ...(request.target === undefined ? {} : { target: request.target }),
          ...(request.hidden === undefined ? {} : { hidden: request.hidden }),
        });
        return { type: "moveThread", requestId, ok: true, ...done };
      }
      case "undoMove":
        return {
          type: "undoMove",
          requestId,
          ok: true,
          result: await deps.moves.undoMove(request.operationId),
        };
      case "deleteForever": {
        const done = await deps.moves.deleteForever(request.keys);
        return { type: "deleteForever", requestId, ok: true, ...done };
      }
      case "getNotificationPrefs":
        return {
          type: "getNotificationPrefs",
          requestId,
          ok: true,
          prefs: deps.notifications?.get() ?? readNotificationPrefs(undefined),
        };
      case "setNotificationPrefs":
        return {
          type: "setNotificationPrefs",
          requestId,
          ok: true,
          prefs: deps.notifications ? await deps.notifications.set(request.prefs) : request.prefs,
        };
      case "testNotification":
        deps.notifications?.test();
        return { type: "testNotification", requestId, ok: true };
      case "pauseNotifications":
        return {
          type: "pauseNotifications",
          requestId,
          ok: true,
          prefs: deps.notifications
            ? await deps.notifications.pause(request.untilMs)
            : readNotificationPrefs(undefined),
        };
      case "bannerFailed":
        deps.notifications?.bannerFailed(request.reason);
        return { type: "bannerFailed", requestId, ok: true };
      case "listFolders":
        return {
          type: "listFolders",
          requestId,
          ok: true,
          folders: await deps.store.listFolders(),
        };
      case "getImageChoice":
        return {
          type: "getImageChoice",
          requestId,
          ok: true,
          images: await imageChoice(deps, request.key),
        };
      case "getStorage":
        return { type: "getStorage", requestId, ok: true, storage: await needStorage(deps).get() };
      case "measureStorage":
        return {
          type: "measureStorage",
          requestId,
          ok: true,
          storage: await needStorage(deps).measure(),
        };
      case "compactStorage":
        return {
          type: "compactStorage",
          requestId,
          ok: true,
          ...(await needStorage(deps).compact()),
        };
      case "clearFileText":
        return {
          type: "clearFileText",
          requestId,
          ok: true,
          cleared: await needStorage(deps).clearFileText(),
        };
      case "listImageRules": {
        const [rules, general] = await Promise.all([
          deps.imageRules.list(),
          deps.imageRules.getGeneral(),
        ]);
        return { type: "listImageRules", requestId, ok: true, rules, general };
      }
      case "setImageRule":
        return {
          type: "setImageRule",
          requestId,
          ok: true,
          rule: await deps.images.setRule({
            scope: request.scope,
            value: request.value,
            decision: request.decision,
          }),
        };
      case "removeImageRule":
        return {
          type: "removeImageRule",
          requestId,
          ok: true,
          removed: await deps.images.removeRule(request.scope, request.value),
        };
      case "stopImages":
        await deps.images.stop({ address: request.address, source: request.source });
        return { type: "stopImages", requestId, ok: true };
      case "setGeneralImages":
        await deps.images.setGeneral(request.general);
        return { type: "setGeneralImages", requestId, ok: true };
      case "importImageAddresses":
        return {
          type: "importImageAddresses",
          requestId,
          ok: true,
          added: await deps.images.importAddresses(request.addresses),
        };
      case "listLabels":
        return { type: "listLabels", requestId, ok: true, labels: await deps.store.listLabels() };
      case "suggestPeople":
        return {
          type: "suggestPeople",
          requestId,
          ok: true,
          people: await suggestPeople(
            { people: deps.people, accounts: deps.accountStore },
            request.prefix,
            request.limit,
          ),
        };
      case "searchFiles":
        return {
          type: "searchFiles",
          requestId,
          ok: true,
          files: await searchFiles(
            { files: deps.fileSearch },
            {
              text: request.text,
              ...(request.limit === undefined ? {} : { limit: request.limit }),
              ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
            },
          ),
        };
      case "discoverServers":
        return {
          type: "discoverServers",
          requestId,
          ok: true,
          found: await deps.accounts.discover(request.domain),
        };
      case "listAccounts":
        return { type: "listAccounts", requestId, ok: true, accounts: await deps.accounts.list() };
      case "addAccount": {
        const added = await deps.accounts.add({
          address: request.address,
          displayName: request.displayName ?? "",
          password: request.password,
          imap: request.imap,
          ...(request.smtp === undefined ? {} : { smtp: request.smtp }),
        });
        return { type: "addAccount", requestId, ok: true, ...added };
      }
      case "removeAccount":
        return (await deps.accounts.remove(request.accountId))
          ? { type: "removeAccount", requestId, ok: true }
          : { type: "error", requestId, ok: false, code: "notFound", message: "no such account" };
      case "syncNow":
        return (await deps.accounts.syncNow(request.accountId))
          ? { type: "syncNow", requestId, ok: true }
          : { type: "error", requestId, ok: false, code: "notFound", message: "no such account" };
      case "changePassword": {
        const changed = await deps.accounts.changePassword(request.accountId, request.password);
        return changed
          ? { type: "changePassword", requestId, ok: true, ...changed }
          : { type: "error", requestId, ok: false, code: "notFound", message: "no such account" };
      }
      case "prepareNew": {
        const content = await prepareNewMessage({ accounts: deps.accountStore }, request.accountId);
        return {
          type: "prepareNew",
          requestId,
          ok: true,
          content,
          existing: null,
          redirect: null,
          messageLimitBytes: await messageLimit(deps, content.accountId),
        };
      }
      case "prepareReply": {
        const prepared = await prepareReplyDraft(
          {
            accounts: deps.accountStore,
            store: deps.store,
            bodies: deps.bodies,
            drafts: deps.drafts,
          },
          request.threadId,
          request.mode,
        );
        return prepared
          ? {
              type: "prepareReply",
              requestId,
              ok: true,
              ...prepared,
              messageLimitBytes: await messageLimit(deps, prepared.content.accountId),
            }
          : { type: "error", requestId, ok: false, code: "notFound", message: "no such thread" };
      }
      case "prepareForward": {
        const prepared = await prepareForwardDraft(
          { accounts: deps.accountStore, store: deps.store, bodies: deps.bodies },
          request.threadId,
          request.hidden === true,
        );
        return prepared
          ? {
              type: "prepareForward",
              requestId,
              ok: true,
              content: prepared.content,
              existing: null,
              redirect: null,
              forwardedKey: prepared.messageKey,
              messageLimitBytes: await messageLimit(deps, prepared.content.accountId),
            }
          : {
              type: "error",
              requestId,
              ok: false,
              code: "notFound",
              message: "There is no message to forward",
            };
      }
      case "getDraft": {
        const draft = await deps.drafts.get(request.draftId);
        return draft
          ? { type: "getDraft", requestId, ok: true, draft }
          : { type: "error", requestId, ok: false, code: "notFound", message: "no such draft" };
      }
      case "saveDraft":
        return {
          type: "saveDraft",
          requestId,
          ok: true,
          draft: await deps.send.saveDraft({
            content: request.content,
            ...(request.id === undefined ? {} : { id: request.id }),
          }),
        };
      case "deleteDraft":
        await deps.send.deleteDraft(request.draftId);
        return { type: "deleteDraft", requestId, ok: true };
      case "renderPreview":
        return {
          type: "renderPreview",
          requestId,
          ok: true,
          html: deps.renderer.render(request.markdown).html,
        };
      case "requestSend":
        return {
          type: "requestSend",
          requestId,
          ok: true,
          operation: await deps.send.requestSend(request.draftId),
        };
      case "undoSend":
        return {
          type: "undoSend",
          requestId,
          ok: true,
          result: await deps.send.undoSend(request.operationId),
        };
      case "sendAction":
        return {
          type: "sendAction",
          requestId,
          ok: true,
          done: await deps.send.sendAction(request.operationId, request.action),
        };
      case "addAttachments":
        return {
          type: "addAttachments",
          requestId,
          ok: true,
          attachments: await deps.attachmentWrites.add(request.draftId, request.files),
        };
      case "addForwardedAttachments":
        return {
          type: "addForwardedAttachments",
          requestId,
          ok: true,
          attachments: await deps.attachmentWrites.addForwarded(request.draftId, request.files),
        };
      case "checkAttachmentSources":
        return {
          type: "checkAttachmentSources",
          requestId,
          ok: true,
          changed: await deps.attachmentWrites.check(request.draftId),
        };
      case "recaptureAttachment": {
        const attachment = await deps.attachmentWrites.recapture(request.draftId, request.id);
        return attachment
          ? { type: "recaptureAttachment", requestId, ok: true, attachment }
          : { type: "error", requestId, ok: false, code: "notFound", message: "no such file" };
      }
      case "fetchReceived": {
        // The message of a failure stays in the worker's log: the page is told what it can act on.
        const outcome: FetchOutcome = deps.received
          ? await deps.received.fetch(request.messageKey, request.partId)
          : { kind: "failed", message: "Received files are not available" };
        return {
          type: "fetchReceived",
          requestId,
          ok: true,
          // A reader never gives up on a download, so `cancelled` is not an answer it can get.
          outcome: { kind: outcome.kind === "cancelled" ? "failed" : outcome.kind },
        };
      }
      case "listAttachments":
        return {
          type: "listAttachments",
          requestId,
          ok: true,
          attachments: (await deps.attachmentRows.forDraft(request.draftId)).map(toAttachmentInfo),
        };
      case "listOutbox":
        return {
          type: "listOutbox",
          requestId,
          ok: true,
          operations: await deps.outbox.listVisible((deps.now ?? Date.now)() - FINISHED_VISIBLE_MS),
        };
      case "listViews":
        return { type: "listViews", requestId, ok: true, views: await deps.savedViews.list() };
      case "saveView": {
        const view =
          request.id === undefined
            ? await deps.viewWrites.create({
                name: request.name as string,
                query: request.query as string,
              })
            : request.query !== undefined
              ? await deps.viewWrites.updateQuery(request.id, request.query)
              : await deps.viewWrites.rename(request.id, request.name as string);
        return { type: "saveView", requestId, ok: true, view };
      }
      case "listSearches":
        return {
          type: "listSearches",
          requestId,
          ok: true,
          searches: await deps.savedViews.recentSearches(request.viewId),
        };
      case "noteSearch":
        await deps.viewWrites.noteSearch(request.viewId, request.query);
        return { type: "noteSearch", requestId, ok: true };
      case "forgetSearch":
        await deps.viewWrites.forgetSearch(request.viewId, request.query);
        return { type: "forgetSearch", requestId, ok: true };
      case "clearSearches":
        await deps.viewWrites.clearSearches(request.viewId);
        return { type: "clearSearches", requestId, ok: true };
      case "deleteView":
        await deps.viewWrites.remove(request.id);
        return { type: "deleteView", requestId, ok: true };
      case "moveView":
        await deps.viewWrites.move(request.id, request.toIndex);
        return { type: "moveView", requestId, ok: true };
      case "agentStatus":
      case "agentDisable":
      case "agentInspect":
      case "agentPauseReading":
      case "agentResumeReading":
      case "agentTestRuntime": {
        const agent = needAgent(deps);
        const status = await (request.type === "agentStatus"
          ? agent.status()
          : request.type === "agentDisable"
            ? agent.disable()
            : request.type === "agentInspect"
              ? agent.inspect()
              : request.type === "agentPauseReading"
                ? agent.pauseReading()
                : request.type === "agentResumeReading"
                  ? agent.resumeReading()
                  : agent.testRuntime(request.runtimeId));
        return { type: request.type, requestId, ok: true, status };
      }
      case "agentSetEnabled":
        return {
          type: "agentSetEnabled",
          requestId,
          ok: true,
          status: await needAgent(deps).setEnabled({
            accountIds: request.accountIds,
            runtimeId: request.runtimeId,
          }),
        };
      case "agentSetKindRuntime":
        return {
          type: "agentSetKindRuntime",
          requestId,
          ok: true,
          status: await needAgent(deps).setKindRuntime(request.kinds, request.runtimeId),
        };
      case "agentSetModels":
        return {
          type: "agentSetModels",
          requestId,
          ok: true,
          status: await needAgent(deps).setModels(request.models, request.efforts),
        };
      case "agentSetWeekShare":
        return {
          type: "agentSetWeekShare",
          requestId,
          ok: true,
          status: await needAgent(deps).setWeekShare(request.percent),
        };
      case "agentSetTalkLoop":
        return {
          type: "agentSetTalkLoop",
          requestId,
          ok: true,
          status: await needAgent(deps).setTalkLoop(request.on),
        };
      case "agentThread":
        return {
          type: "agentThread",
          requestId,
          ok: true,
          view: await needAgent(deps).threadAgent(request.threadId),
        };
      case "agentJournal":
        return {
          type: "agentJournal",
          requestId,
          ok: true,
          entries: await needAgent(deps).journal(request.limit),
        };
      case "agentRules":
        return { type: "agentRules", requestId, ok: true, rules: await needAgent(deps).rules() };
      case "agentInstructions":
        return {
          type: "agentInstructions",
          requestId,
          ok: true,
          instructions: await needAgent(deps).instructions(),
        };
      case "agentRemember":
        return {
          type: "agentRemember",
          requestId,
          ok: true,
          result: await needAgent(deps).remember(request.threadId, request.words),
        };
      case "agentAddInstruction":
        return {
          type: "agentAddInstruction",
          requestId,
          ok: true,
          instruction: await needAgent(deps).addInstruction({
            scope: request.scope,
            text: request.text,
          }),
        };
      case "agentRemoveInstruction":
        await needAgent(deps).removeInstruction(request.instructionId);
        return { type: "agentRemoveInstruction", requestId, ok: true };
      case "agentRuleOffer":
        return {
          type: "agentRuleOffer",
          requestId,
          ok: true,
          offer: await needAgent(deps).ruleOffer(request.threadId),
        };
      case "agentAddRule":
        return {
          type: "agentAddRule",
          requestId,
          ok: true,
          rule: await needAgent(deps).addRule(
            "threadId" in request
              ? { threadId: request.threadId, scope: "sender" }
              : { scope: request.scope, subject: request.subject },
          ),
        };
      case "agentRemoveRule":
        await needAgent(deps).removeRule(request.ruleId);
        return { type: "agentRemoveRule", requestId, ok: true };
      case "agentPrepare":
        return {
          type: "agentPrepare",
          requestId,
          ok: true,
          prepared: await needAgent(deps).prepare(request.threadId, {
            ...(request.direction === undefined ? {} : { direction: request.direction }),
            ...(request.answer === undefined ? {} : { answer: request.answer }),
          }),
        };
      case "agentTalk":
        return {
          type: "agentTalk",
          requestId,
          ok: true,
          result: await needAgent(deps).talk(request.threadId, request.words, request.choice),
        };
      case "agentRewriteDraft":
        return {
          type: "agentRewriteDraft",
          requestId,
          ok: true,
          text: (await needAgent(deps).rewriteDraft(draftFor(request), request.text, request.how))
            .text,
        };
      case "agentWriteDraft":
        return {
          type: "agentWriteDraft",
          requestId,
          ok: true,
          text: (
            await needAgent(deps).writeDraft(
              draftFor(request),
              request.subject,
              request.text,
              request.words,
            )
          ).text,
        };
      case "agentAnswerQuestions":
        return {
          type: "agentAnswerQuestions",
          requestId,
          ok: true,
          text: (
            await needAgent(deps).answerQuestions(
              request.threadId,
              request.text,
              request.missing ?? [],
            )
          ).text,
        };
      case "agentCheckReply":
        return {
          type: "agentCheckReply",
          requestId,
          ok: true,
          check: await needAgent(deps).checkReply(request.threadId, request.text),
        };
      case "agentFillGaps":
        return {
          type: "agentFillGaps",
          requestId,
          ok: true,
          suggestions: await needAgent(deps).fillGaps(request.threadId, request.text),
        };
      case "agentTalkStop":
        await needAgent(deps).talkStop(request.threadId);
        return { type: "agentTalkStop", requestId, ok: true };
      case "agentTalkEntries":
        return {
          type: "agentTalkEntries",
          requestId,
          ok: true,
          entries: await needAgent(deps).talkEntries(request.threadId),
        };
      case "agentTalkAll":
        return {
          type: "agentTalkAll",
          requestId,
          ok: true,
          result: await needAgent(deps).talkAll(
            request.words,
            request.talkId ?? null,
            request.choice,
          ),
        };
      case "agentTalkAllStop":
        await needAgent(deps).talkAllStop();
        return { type: "agentTalkAllStop", requestId, ok: true };
      case "agentTalkAllEntries":
        return {
          type: "agentTalkAllEntries",
          requestId,
          ok: true,
          entries: await needAgent(deps).talkAllEntries(request.talkId, request.beforeId),
        };
      case "agentTalks":
        return { type: "agentTalks", requestId, ok: true, talks: await needAgent(deps).talks() };
      case "agentTalkRename":
        await needAgent(deps).renameTalk(request.talkId, request.title);
        return { type: "agentTalkRename", requestId, ok: true };
      case "agentTalkDelete":
        await needAgent(deps).deleteTalk(request.talkId);
        return { type: "agentTalkDelete", requestId, ok: true };
      case "agentTalkDeleteAll":
        return {
          type: "agentTalkDeleteAll",
          requestId,
          ok: true,
          count: await needAgent(deps).deleteAllTalks(),
        };
      case "agentUndoFeedback":
        await needAgent(deps).undoFeedback(request.threadId, request.kind);
        return { type: "agentUndoFeedback", requestId, ok: true };
      case "agentRevokeConsent":
        return {
          type: "agentRevokeConsent",
          requestId,
          ok: true,
          status: await needAgent(deps).revokeConsent(request.accountId, request.runtimeId),
        };
      case "agentDraftFromPrepared": {
        const made = await needAgent(deps).draftFromPrepared(request.threadId, request.body);
        return { type: "agentDraftFromPrepared", requestId, ok: true, ...made };
      }
      case "agentMatchAct": {
        const matched = await needAgent(deps).matchAct(request.query);
        return { type: "agentMatchAct", requestId, ok: true, ...matched };
      }
      // ADR 0116: a prompt is a filter.
      case "agentPromptCount":
        return {
          type: "agentPromptCount",
          requestId,
          ok: true,
          count: await needAgent(deps).promptCount(request.query),
        };
      case "agentPromptVerdicts":
        return {
          type: "agentPromptVerdicts",
          requestId,
          ok: true,
          list: await needAgent(deps).promptVerdicts(request.query),
        };
      case "agentPromptBadge":
        return {
          type: "agentPromptBadge",
          requestId,
          ok: true,
          badge: await needAgent(deps).promptBadge(request.query),
        };
      case "agentPromptRun":
        return {
          type: "agentPromptRun",
          requestId,
          ok: true,
          result: await needAgent(deps).promptRun(
            request.query,
            request.again === true,
            request.readAll === true,
          ),
        };
      case "agentPromptStop":
        await needAgent(deps).promptStop();
        return { type: "agentPromptStop", requestId, ok: true };
      case "agentReadingStatus":
        return {
          type: "agentReadingStatus",
          requestId,
          ok: true,
          status: await needAgent(deps).readingStatus(request.fresh === true),
        };
      case "countMatches": {
        const result = await deps.counts.count(request.query, request.cap, request.beforeKey);
        return { type: "countMatches", requestId, ok: true, ...result };
      }
      case "sortRanked": {
        if (deps.counts.rank === undefined) throw new Error("Sorting is not available");
        return {
          type: "sortRanked",
          requestId,
          ok: true,
          ranked: await deps.counts.rank(request.query),
        };
      }
      case "search": {
        const result = await searchMessages(
          {
            index: deps.index,
            store: deps.store,
            accounts: deps.accountStore,
            ...(deps.now === undefined ? {} : { now: deps.now }),
          },
          request.query,
          {
            limit: request.limit,
            ...(request.beforeKey === undefined ? {} : { beforeKey: request.beforeKey }),
            ...(request.afterKey === undefined ? {} : { afterKey: request.afterKey }),
          },
        );
        return {
          type: "search",
          requestId,
          ok: true,
          messages: result.messages,
          ...(result.nextBeforeKey === undefined ? {} : { nextBeforeKey: result.nextBeforeKey }),
          ...(result.nextAfterKey === undefined ? {} : { nextAfterKey: result.nextAfterKey }),
        };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = failureDetailOf(error);
    return {
      type: "error",
      requestId,
      ok: false,
      code: errorCodeOf(error),
      message,
      ...(detail === undefined ? {} : { detail }),
    };
  }
}
