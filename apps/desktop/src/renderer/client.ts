import type {
  AddAccountRequest,
  AddAccountResponse,
  AddAttachmentsResponse,
  AgentAddInstructionResponse,
  AgentAddRuleResponse,
  AgentAnswerQuestionsResponse,
  AgentCheckReplyResponse,
  AgentDraftFromPreparedResponse,
  AgentFillGapsResponse,
  AgentInstructionsResponse,
  AgentJournalResponse,
  AgentMatchActResponse,
  AgentPrepareResponse,
  AgentPromptBadgeResponse,
  AgentPromptCountResponse,
  AgentPromptRunResponse,
  AgentPromptVerdictsResponse,
  AgentRememberResponse,
  AgentRewriteDraftResponse,
  AgentRuleOfferResponse,
  AgentRulesResponse,
  AgentStatusResponse,
  AgentTalkAllEntriesResponse,
  AgentTalkAllResponse,
  AgentTalkDeleteAllResponse,
  AgentTalkEntriesResponse,
  AgentTalkResponse,
  AgentTalksResponse,
  AgentThreadResponse,
  AttachmentInfo,
  BackendEvent,
  BackendMessage,
  BackendRequest,
  BackendResponse,
  ChangePasswordResponse,
  CheckAttachmentSourcesResponse,
  ClearFileTextResponse,
  CompactStorageResponse,
  CountMatchesResponse,
  DeleteForeverResponse,
  DiscoverServersResponse,
  ErrorCode,
  GetDraftResponse,
  GetImageChoiceResponse,
  GetMessageHtmlResponse,
  GetMessagesResponse,
  GetStorageResponse,
  ImportImageAddressesResponse,
  ListAccountsResponse,
  ListAttachmentsResponse,
  ListFoldersResponse,
  ListImageRulesResponse,
  ListLabelsResponse,
  ListNewestResponse,
  ListOutboxResponse,
  ListSearchesResponse,
  ListViewsResponse,
  MeasureStorageResponse,
  MoveThreadResponse,
  NotificationPrefsResponse,
  OpenThreadResponse,
  PrepareResponse,
  RecaptureAttachmentResponse,
  RemoveImageRuleResponse,
  RenderPreviewResponse,
  RequestSendResponse,
  SaveDraftResponse,
  SaveViewResponse,
  SearchFilesResponse,
  SearchResponse,
  SendAction,
  SendActionResponse,
  SetImageRuleResponse,
  SetSeenResponse,
  SortRankedResponse,
  StorageReport,
  SuggestPeopleResponse,
  UndoMoveResponse,
  UndoSendResponse,
} from "@matters/contracts";
import type {
  ActMatch,
  AddInstructionInput,
  AddRuleInput,
  AgentInstruction,
  AgentModels,
  AgentRule,
  AgentStatus,
  DeleteForeverResult,
  Draft,
  DraftContent,
  FailureDetail,
  FileHit,
  GapSuggestion,
  GeneralImages,
  ImageChoice,
  ImageRule,
  ImageRuleDecision,
  ImageRuleScope,
  JournalEntry,
  Label,
  MoveAction,
  MoveTarget,
  MoveThreadResult,
  NotificationPrefs,
  PersonSuggestion,
  PrepareResult,
  PromptBadge,
  PromptCount,
  PromptList,
  PromptRunResult,
  RememberResult,
  ReplyCheck,
  ReplyMode,
  RewriteHow,
  RuleOffer,
  SavedView,
  SendOperation,
  SortRanked,
  StoppableSource,
  TalkEntry,
  TalkResult,
  TalkSummary,
  ThreadAgentView,
  UndoMoveResult,
  UndoResult,
} from "@matters/core";
import { mark } from "./trace.ts";

type Omit1<T> = T extends unknown ? Omit<T, "requestId"> : never;

/** A request the backend answered with an error; `code` says which kind. */
export class BackendError extends Error {
  readonly code: ErrorCode;
  /** What the server's answer told, when adding or mending an account failed (ADR 0114). */
  readonly detail: FailureDetail | undefined;
  constructor(code: ErrorCode, message: string, detail?: FailureDetail) {
    super(message);
    this.name = "BackendError";
    this.code = code;
    this.detail = detail;
  }
}

export interface Backend {
  listNewest(args: { beforeKey?: number; limit: number }): Promise<ListNewestResponse>;
  /** `hidden`: the thread is looked at from Trash or Spam, so its deleted messages are shown too. */
  openThread(threadId: string, hidden?: boolean): Promise<OpenThreadResponse>;
  /** `afterKey` and `nextAfterKey` page a `sort:oldest` list (ADR 0116, rule 4b). */
  search(args: {
    query: string;
    beforeKey?: number;
    afterKey?: number;
    limit: number;
  }): Promise<SearchResponse>;
  getMessages(keys: readonly number[]): Promise<GetMessagesResponse>;
  /** The message's HTML, as sent: untrusted, see `mailHtml.ts`. */
  getMessageHtml(key: number): Promise<GetMessageHtmlResponse>;
  /**
   * Marks messages read or unread (ADR 0039). Resolves once the local flag is written; the server
   * is told later. `changeSeq` is the sequence the write produced, `changedKeys` what changed.
   */
  setSeen(
    keys: readonly number[],
    seen: boolean,
  ): Promise<{ changeSeq: number; changedKeys: readonly number[] }>;
  /**
   * Moves a thread (ADR 0044). Resolves once the labels and the request are stored; the server is
   * told when the undo window is over. `operationId` is what `undoMove` takes back, null when
   * nothing was left to move.
   */
  moveThread(args: {
    threadId: string;
    others?: readonly string[];
    action: MoveAction;
    target?: MoveTarget;
    hidden?: boolean;
  }): Promise<MoveThreadResult>;
  undoMove(operationId: string): Promise<UndoMoveResult>;
  /** Deletes messages for good; the core refuses any that is not in Trash. */
  deleteForever(keys: readonly number[]): Promise<DeleteForeverResult>;
  /** Every account's folders as sync last listed them. */
  listFolders(): Promise<readonly Label[]>;
  /** What the rules say about the images of one message, for when they changed (ADR 0037). */
  getImageChoice(key: number): Promise<ImageChoice | null>;
  listImageRules(): Promise<{ rules: readonly ImageRule[]; general: GeneralImages }>;
  /** Settings › Storage (ADR 0089): the cheap numbers and the kept measurements. */
  getStorage(): Promise<StorageReport>;
  /** Measures the database by table now (seconds, on the read thread) and keeps it. */
  measureStorage(): Promise<StorageReport>;
  /** `VACUUM`: seconds, and sync waits for it. */
  compactStorage(): Promise<{ freedBytes: number; ms: number }>;
  /** Empties the text the agent read from attached files; returns how many files it held (ADR 0087). */
  clearFileText(): Promise<number>;
  /** The notification settings (ADR 0071). */
  getNotificationPrefs(): Promise<NotificationPrefs>;
  /** Replaces them whole; the answer is what the backend kept. */
  setNotificationPrefs(prefs: NotificationPrefs): Promise<NotificationPrefs>;
  /** One made-up notice through every channel that is on. */
  testNotification(): Promise<void>;
  /** Inserts or replaces the rule for this scope and value. */
  setImageRule(args: {
    scope: ImageRuleScope;
    value: string;
    decision: ImageRuleDecision;
  }): Promise<ImageRule>;
  /** Returns whether the rule existed. */
  removeImageRule(scope: ImageRuleScope, value: string): Promise<boolean>;
  /** `Stop showing images from …` for the rule that allowed them. */
  stopImages(address: string, source: StoppableSource): Promise<void>;
  setGeneralImages(general: GeneralImages): Promise<void>;
  /** The old per-sender list, once; resolves with the number of rules added. */
  importImageAddresses(addresses: readonly string[]): Promise<number>;
  /** Distinct folded label names, for suggestions. */
  listLabels(): Promise<ListLabelsResponse>;
  /** People matching what is typed, never the user's own addresses (ADR 0028). */
  suggestPeople(prefix: string, limit: number): Promise<readonly PersonSuggestion[]>;
  /** Files received in mail whose name contains the text, newest first (ADR 0074). */
  searchFiles(text: string, limit?: number, accountId?: string): Promise<readonly FileHit[]>;
  discoverServers(domain: string): Promise<DiscoverServersResponse>;
  listAccounts(): Promise<ListAccountsResponse>;
  addAccount(args: Omit<AddAccountRequest, "type" | "requestId">): Promise<AddAccountResponse>;
  removeAccount(accountId: string): Promise<void>;
  syncNow(accountId: string): Promise<void>;
  /** Verifies a new password, then replaces the saved one (ADR 0113). */
  changePassword(accountId: string, password: string): Promise<ChangePasswordResponse>;
  /** Starting points of a message; nothing is stored until the first `saveDraft`. */
  prepareNew(accountId?: string): Promise<PrepareResponse>;
  prepareReply(threadId: string, mode: ReplyMode): Promise<PrepareResponse>;
  /** The draft of a forward of the thread; `hidden` as for `openThread` (ADR 0045, rule 1). */
  prepareForward(threadId: string, hidden: boolean): Promise<PrepareResponse>;
  getDraft(draftId: string): Promise<Draft>;
  saveDraft(args: { id?: string; content: DraftContent }): Promise<SaveDraftResponse["draft"]>;
  deleteDraft(draftId: string): Promise<void>;
  /** The HTML the message will have: the same function builds the sent message. */
  renderPreview(markdown: string): Promise<string>;
  requestSend(draftId: string): Promise<SendOperation>;
  undoSend(operationId: string): Promise<UndoResult>;
  sendAction(operationId: string, action: SendAction): Promise<boolean>;
  listOutbox(): Promise<ListOutboxResponse>;
  /**
   * Puts files on a draft by the grants main minted for them (see `files.ts`). Resolves when the
   * rows exist; the copies go on and arrive as `attachments` and `attachmentProgress` events.
   * Rejects with `invalidRequest` for a grant that is unknown, used or expired.
   */
  addAttachments(
    draftId: string,
    files: readonly { id: string; grantId: string }[],
  ): Promise<readonly AttachmentInfo[]>;
  /**
   * Puts the files of a received message on a draft (ADR 0045, rule 6). Name and size come from
   * the message; each is downloaded and then copied, and arrives as `attachments` and
   * `attachmentProgress` events like any other file.
   */
  addForwardedAttachments(
    draftId: string,
    files: readonly { id: string; messageKey: number; partId: string }[],
  ): Promise<readonly AttachmentInfo[]>;
  /** Ids of the draft's files whose original changed since they were copied. */
  checkAttachmentSources(draftId: string): Promise<readonly string[]>;
  /** "Use new version": the original read again, as a new attachment with a new id. */
  recaptureAttachment(draftId: string, id: string): Promise<AttachmentInfo>;
  listAttachments(draftId: string): Promise<readonly AttachmentInfo[]>;
  listViews(): Promise<readonly SavedView[]>;
  /** Creates a view. Rejects with a `BackendError` whose message the UI shows (`invalidView`). */
  createView(name: string, query: string): Promise<SavedView>;
  updateViewQuery(id: string, query: string): Promise<SavedView>;
  renameView(id: string, name: string): Promise<SavedView>;
  deleteView(id: string): Promise<void>;
  moveView(id: string, toIndex: number): Promise<void>;
  /** The view's recent searches, latest first (ADR 0030). */
  listSearches(viewId: string): Promise<readonly string[]>;
  noteSearch(viewId: string, query: string): Promise<void>;
  forgetSearch(viewId: string, query: string): Promise<void>;
  /** Everything remembered for the view, not only what the panel shows. */
  clearSearches(viewId: string): Promise<void>;
  /** The ranked order of a query without a prompt, after `↵` (ADR 0116, rule 4b). */
  sortRanked(query: string): Promise<SortRanked>;
  /** Unread matches in one window of at most `cap` keys; follow `nextBeforeKey` for more. */
  countMatches(args: {
    query: string;
    cap: number;
    beforeKey?: number;
  }): Promise<{ count: number; nextBeforeKey?: number }>;
  // --- Agents (ADR 0051). None of these waits for a model except `agentPrepare`. ---
  /** Settings, consent, the runtime as last looked at, reading progress and the ledger. */
  agentStatus(): Promise<AgentStatus>;
  /** What the agent already has for one thread: work prepared on request. Local; no model. */
  agentThread(threadId: string): Promise<ThreadAgentView>;
  /** What the agent and the person did, newest first (ADR 0054, rule 6). A local read; 50 by default. */
  agentJournal(limit?: number): Promise<readonly JournalEntry[]>;
  /** The active rules (ADR 0054, rule 7), in the order they were added. A local read. */
  agentRules(): Promise<readonly AgentRule[]>;
  /** The active instructions for the model (ADR 0054, rule 7), oldest first. A local read. */
  agentInstructions(): Promise<readonly AgentInstruction[]>;
  /** Keeps an instruction typed in Settings. Rejects with the backend's sentence when it is refused. */
  agentAddInstruction(input: AddInstructionInput): Promise<AgentInstruction>;
  agentRemoveInstruction(instructionId: number): Promise<void>;
  /**
   * What to keep from words the person typed about a thread: one background turn on the plan that
   * gets the words and nothing else. Empty when nothing is kept or anything refuses; never rejects
   * for a failed turn.
   */
  agentRemember(threadId: string, words: string): Promise<RememberResult>;
  /** What the tray offers after a closing: a rule for the thread's sender, or null. A local read. */
  agentRuleOffer(threadId: string): Promise<RuleOffer | null>;
  /** Adds a rule as the person. Rejects with the backend's sentence when the subject is invalid. */
  agentAddRule(input: AddRuleInput): Promise<AgentRule>;
  agentRemoveRule(ruleId: number): Promise<void>;
  /** Turns AI on for these accounts. Sends nothing by itself beyond what reading then does. */
  agentSetEnabled(args: { accountIds: readonly string[]; runtimeId: string }): Promise<AgentStatus>;
  agentDisable(): Promise<AgentStatus>;
  agentRevokeConsent(accountId: string): Promise<AgentStatus>;
  agentSetModels(models: Partial<AgentModels>): Promise<AgentStatus>;
  agentSetWeekShare(percent: number): Promise<AgentStatus>;
  agentSetTalkLoop(on: boolean): Promise<AgentStatus>;
  /** Looks at the runtime again. Spends nothing. */
  agentInspect(): Promise<AgentStatus>;
  /** The test with a made-up message. Never mail. */
  agentTestRuntime(): Promise<AgentStatus>;
  agentPauseReading(): Promise<AgentStatus>;
  agentResumeReading(): Promise<AgentStatus>;
  /** The person asked: a draft or a question, now. May take a while. */
  agentPrepare(
    threadId: string,
    guidance?: { direction?: string; answer?: string },
  ): Promise<PrepareResult>;
  /**
   * The person talks about a thread (ADR 0064): one turn that gives text, a draft, a question or a
   * closing. May take a while. A failure (also a stop) stores nothing; the words stay in the prompt.
   */
  agentTalk(threadId: string, words: string): Promise<TalkResult>;
  /** Cuts the running talk turn of the thread short. */
  agentTalkStop(threadId: string): Promise<void>;
  // Help with a reply (ADR 0098). Each is one turn the person asked for, on their plan; none sends
  // mail or saves the draft. `text` is the composer's whole Markdown body; what comes back keeps
  // the quote below the person's lines as it was and every gap in [brackets]. They reject with a
  // `BackendError`: `agentUnavailable` (AI off or not ready, no consent, allowance used up, or an
  // answer that was not used), `notFound` (no such thread) or `invalidRequest` (nothing written
  // yet, too long); its message is a sentence to show as it is. May take a while.
  /** The person's lines rewritten: shorter, formal, or in English. */
  agentRewriteDraft(threadId: string, text: string, how: RewriteHow): Promise<string>;
  /** Short answers added for what the other side asked; the same text when nothing was open. */
  agentAnswerQuestions(
    threadId: string,
    text: string,
    missing?: readonly string[],
  ): Promise<string>;
  /** How many asks of the other side's last message the draft answers, and what is missing. */
  agentCheckReply(threadId: string, text: string): Promise<ReplyCheck>;
  /** Values from the thread for the gaps the person left, with where each was found. */
  agentFillGaps(threadId: string, text: string): Promise<readonly GapSuggestion[]>;
  /** The talk about a thread, oldest first, at most the newest 200. A local read. */
  agentTalkEntries(threadId: string): Promise<readonly TalkEntry[]>;
  /**
   * The person asks across all their mail (ADR 0064, rule 7): a search turn, a search on this
   * machine, an answer turn. May take a while. A failure (also a stop) stores nothing.
   */
  agentTalkAll(words: string, talkId?: number | null): Promise<TalkResult>;
  /** Cuts the running turn across all mail short. */
  agentTalkAllStop(): Promise<void>;
  /** The talk across all mail, oldest first, at most the newest 200. A local read. */
  agentTalkAllEntries(talkId?: number, beforeId?: number): Promise<readonly TalkEntry[]>;
  /** The talks across all mail, the latest first (ADR 0086). */
  agentTalks(): Promise<readonly TalkSummary[]>;
  agentTalkRename(talkId: number, title: string): Promise<void>;
  agentTalkDelete(talkId: number): Promise<void>;
  /** Returns how many talks went. */
  agentTalkDeleteAll(): Promise<number>;
  agentUndoFeedback(threadId: string, kind: "notImportant" | "later" | "closed"): Promise<void>;
  /** A reply draft with this text by the composer's rules; sending it is a separate step. */
  agentDraftFromPrepared(
    threadId: string,
    body: string,
  ): Promise<{ draftId: string; existing: boolean }>;
  /**
   * What the press of a clean-up offer acts on (ADR 0102, rule 7): matched as its count was, in the
   * accounts agreed to and without the threads the rules cover. Read-only.
   */
  agentMatchAct(query: string): Promise<{ messages: readonly ActMatch[]; capped: boolean }>;
  /** ADR 0116, rule 4: what a run of the prompt in `query` would read. No model. */
  agentPromptCount(query: string): Promise<PromptCount>;
  /** ADR 0116, rule 7: the verdicts kept for the prompt in `query`, as the list shows them. */
  agentPromptVerdicts(query: string): Promise<PromptList>;
  /** ADR 0117, rule 4: the number on the tab of a view with a prompt, from stored verdicts. */
  agentPromptBadge(query: string): Promise<PromptBadge>;
  /**
   * ADR 0116, rules 3 and 4: runs the prompt in `query`, its search first when none is kept or
   * `again` asks for a new one, then what it found and has not read; progress is pushed. Above
   * `PROMPT_ASK_ABOVE` threads to read it reads only with `readAll`, else it answers `ask`.
   */
  agentPromptRun(query: string, again?: boolean, readAll?: boolean): Promise<PromptRunResult>;
  /** ADR 0116, rule 9: cuts the running prompt short. */
  agentPromptStop(): Promise<void>;
  /** Pushes from the backend (changes, sync status). Returns the unsubscribe function. */
  onEvent(listener: (event: BackendEvent) => void): () => void;
}

interface Pending {
  resolve(response: BackendResponse): void;
  reject(error: Error): void;
}

/** Wraps the port main handed over; correlates responses by `requestId`. */
export function createBackend(port: MessagePort): Backend {
  const pending = new Map<string, Pending>();
  const listeners = new Set<(event: BackendEvent) => void>();
  let counter = 0;

  let answered = false;
  port.onmessage = (event: MessageEvent<BackendMessage>) => {
    const message = event.data;
    if (!answered && "requestId" in message) {
      answered = true;
      mark("first-answer");
    }
    if (!("requestId" in message)) {
      for (const listener of listeners) listener(message);
      return;
    }
    const waiting = pending.get(message.requestId);
    if (!waiting) return;
    pending.delete(message.requestId);
    if (message.ok) waiting.resolve(message);
    else waiting.reject(new BackendError(message.code, message.message, message.detail));
  };
  port.start();

  function request<T extends BackendResponse>(body: Omit1<BackendRequest>): Promise<T> {
    const requestId = `r${++counter}`;
    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, { resolve: resolve as (r: BackendResponse) => void, reject });
      port.postMessage({ ...body, requestId });
    });
  }

  return {
    listNewest: (args) => request<ListNewestResponse>({ type: "listNewest", ...args }),
    openThread: (threadId, hidden) =>
      request<OpenThreadResponse>({
        type: "openThread",
        threadId,
        ...(hidden === true ? { hidden } : {}),
      }),
    search: (args) => request<SearchResponse>({ type: "search", ...args }),
    getMessages: (keys) => request<GetMessagesResponse>({ type: "getMessages", keys }),
    moveThread: async (args) => {
      const {
        type: _,
        requestId: __,
        ok: ___,
        ...done
      } = await request<MoveThreadResponse>({
        type: "moveThread",
        ...args,
      });
      return done;
    },
    undoMove: async (operationId) =>
      (await request<UndoMoveResponse>({ type: "undoMove", operationId })).result,
    deleteForever: async (keys) => {
      const r = await request<DeleteForeverResponse>({ type: "deleteForever", keys });
      return { queued: r.queued, removed: r.removed, refused: r.refused };
    },
    listFolders: async () => (await request<ListFoldersResponse>({ type: "listFolders" })).folders,
    getMessageHtml: (key) => request<GetMessageHtmlResponse>({ type: "getMessageHtml", key }),
    setSeen: async (keys, seen) => {
      const r = await request<SetSeenResponse>({ type: "setSeen", keys, seen });
      return { changeSeq: r.changeSeq, changedKeys: r.changedKeys };
    },
    getImageChoice: async (key) =>
      (await request<GetImageChoiceResponse>({ type: "getImageChoice", key })).images,
    getNotificationPrefs: async () =>
      (await request<NotificationPrefsResponse>({ type: "getNotificationPrefs" })).prefs,
    setNotificationPrefs: async (prefs) =>
      (await request<NotificationPrefsResponse>({ type: "setNotificationPrefs", prefs })).prefs,
    testNotification: async () => {
      await request({ type: "testNotification" });
    },
    getStorage: async () => (await request<GetStorageResponse>({ type: "getStorage" })).storage,
    measureStorage: async () =>
      (await request<MeasureStorageResponse>({ type: "measureStorage" })).storage,
    compactStorage: async () => {
      const r = await request<CompactStorageResponse>({ type: "compactStorage" });
      return { freedBytes: r.freedBytes, ms: r.ms };
    },
    clearFileText: async () =>
      (await request<ClearFileTextResponse>({ type: "clearFileText" })).cleared,
    listImageRules: async () => {
      const r = await request<ListImageRulesResponse>({ type: "listImageRules" });
      return { rules: r.rules, general: r.general };
    },
    setImageRule: async (args) =>
      (await request<SetImageRuleResponse>({ type: "setImageRule", ...args })).rule,
    removeImageRule: async (scope, value) =>
      (await request<RemoveImageRuleResponse>({ type: "removeImageRule", scope, value })).removed,
    stopImages: async (address, source) => {
      await request({ type: "stopImages", address, source });
    },
    setGeneralImages: async (general) => {
      await request({ type: "setGeneralImages", general });
    },
    importImageAddresses: async (addresses) =>
      (await request<ImportImageAddressesResponse>({ type: "importImageAddresses", addresses }))
        .added,
    listLabels: () => request<ListLabelsResponse>({ type: "listLabels" }),
    suggestPeople: async (prefix, limit) =>
      (await request<SuggestPeopleResponse>({ type: "suggestPeople", prefix, limit })).people,
    searchFiles: async (text, limit, accountId) =>
      (
        await request<SearchFilesResponse>({
          type: "searchFiles",
          text,
          ...(limit === undefined ? {} : { limit }),
          ...(accountId === undefined ? {} : { accountId }),
        })
      ).files,
    discoverServers: (domain) =>
      request<DiscoverServersResponse>({ type: "discoverServers", domain }),
    listAccounts: () => request<ListAccountsResponse>({ type: "listAccounts" }),
    addAccount: (args) => request<AddAccountResponse>({ type: "addAccount", ...args }),
    removeAccount: async (accountId) => {
      await request({ type: "removeAccount", accountId });
    },
    syncNow: async (accountId) => {
      await request({ type: "syncNow", accountId });
    },
    changePassword: (accountId, password) =>
      request<ChangePasswordResponse>({ type: "changePassword", accountId, password }),
    prepareNew: (accountId) =>
      request<PrepareResponse>({ type: "prepareNew", ...(accountId ? { accountId } : {}) }),
    prepareReply: (threadId, mode) =>
      request<PrepareResponse>({ type: "prepareReply", threadId, mode }),
    prepareForward: (threadId, hidden) =>
      request<PrepareResponse>({
        type: "prepareForward",
        threadId,
        ...(hidden ? { hidden } : {}),
      }),
    getDraft: async (draftId) =>
      (await request<GetDraftResponse>({ type: "getDraft", draftId })).draft,
    saveDraft: async (args) =>
      (await request<SaveDraftResponse>({ type: "saveDraft", ...args })).draft,
    deleteDraft: async (draftId) => {
      await request({ type: "deleteDraft", draftId });
    },
    renderPreview: async (markdown) =>
      (await request<RenderPreviewResponse>({ type: "renderPreview", markdown })).html,
    requestSend: async (draftId) =>
      (await request<RequestSendResponse>({ type: "requestSend", draftId })).operation,
    undoSend: async (operationId) =>
      (await request<UndoSendResponse>({ type: "undoSend", operationId })).result,
    sendAction: async (operationId, action) =>
      (await request<SendActionResponse>({ type: "sendAction", operationId, action })).done,
    listOutbox: () => request<ListOutboxResponse>({ type: "listOutbox" }),
    addAttachments: async (draftId, files) =>
      (await request<AddAttachmentsResponse>({ type: "addAttachments", draftId, files }))
        .attachments,
    addForwardedAttachments: async (draftId, files) =>
      (await request<AddAttachmentsResponse>({ type: "addForwardedAttachments", draftId, files }))
        .attachments,
    checkAttachmentSources: async (draftId) =>
      (await request<CheckAttachmentSourcesResponse>({ type: "checkAttachmentSources", draftId }))
        .changed,
    recaptureAttachment: async (draftId, id) =>
      (await request<RecaptureAttachmentResponse>({ type: "recaptureAttachment", draftId, id }))
        .attachment,
    listAttachments: async (draftId) =>
      (await request<ListAttachmentsResponse>({ type: "listAttachments", draftId })).attachments,
    listViews: async () => (await request<ListViewsResponse>({ type: "listViews" })).views,
    createView: async (name, query) =>
      (await request<SaveViewResponse>({ type: "saveView", name, query })).view,
    updateViewQuery: async (id, query) =>
      (await request<SaveViewResponse>({ type: "saveView", id, query })).view,
    renameView: async (id, name) =>
      (await request<SaveViewResponse>({ type: "saveView", id, name })).view,
    deleteView: async (id) => {
      await request({ type: "deleteView", id });
    },
    listSearches: async (viewId) =>
      (await request<ListSearchesResponse>({ type: "listSearches", viewId })).searches,
    noteSearch: async (viewId, query) => {
      await request({ type: "noteSearch", viewId, query });
    },
    forgetSearch: async (viewId, query) => {
      await request({ type: "forgetSearch", viewId, query });
    },
    clearSearches: async (viewId) => {
      await request({ type: "clearSearches", viewId });
    },
    moveView: async (id, toIndex) => {
      await request({ type: "moveView", id, toIndex });
    },
    sortRanked: async (query) =>
      (await request<SortRankedResponse>({ type: "sortRanked", query })).ranked,
    countMatches: async ({ query, cap, beforeKey }) => {
      const r = await request<CountMatchesResponse>({
        type: "countMatches",
        query,
        cap,
        ...(beforeKey === undefined ? {} : { beforeKey }),
      });
      return {
        count: r.count,
        ...(r.nextBeforeKey === undefined ? {} : { nextBeforeKey: r.nextBeforeKey }),
      };
    },
    agentStatus: async () => (await request<AgentStatusResponse>({ type: "agentStatus" })).status,
    agentThread: async (threadId) =>
      (await request<AgentThreadResponse>({ type: "agentThread", threadId })).view,
    agentJournal: async (limit) =>
      (
        await request<AgentJournalResponse>({
          type: "agentJournal",
          ...(limit === undefined ? {} : { limit }),
        })
      ).entries,
    agentRules: async () => (await request<AgentRulesResponse>({ type: "agentRules" })).rules,
    agentInstructions: async () =>
      (await request<AgentInstructionsResponse>({ type: "agentInstructions" })).instructions,
    agentAddInstruction: async (input) =>
      (await request<AgentAddInstructionResponse>({ type: "agentAddInstruction", ...input }))
        .instruction,
    agentRemoveInstruction: async (instructionId) => {
      await request({ type: "agentRemoveInstruction", instructionId });
    },
    agentRemember: async (threadId, words) =>
      (await request<AgentRememberResponse>({ type: "agentRemember", threadId, words })).result,
    agentRuleOffer: async (threadId) =>
      (await request<AgentRuleOfferResponse>({ type: "agentRuleOffer", threadId })).offer,
    agentAddRule: async (input) =>
      (await request<AgentAddRuleResponse>({ type: "agentAddRule", ...input })).rule,
    agentRemoveRule: async (ruleId) => {
      await request({ type: "agentRemoveRule", ruleId });
    },
    agentSetEnabled: async (args) =>
      (await request<AgentStatusResponse>({ type: "agentSetEnabled", ...args })).status,
    agentDisable: async () => (await request<AgentStatusResponse>({ type: "agentDisable" })).status,
    agentRevokeConsent: async (accountId) =>
      (await request<AgentStatusResponse>({ type: "agentRevokeConsent", accountId })).status,
    agentSetModels: async (models) =>
      (await request<AgentStatusResponse>({ type: "agentSetModels", models })).status,
    agentSetWeekShare: async (percent) =>
      (await request<AgentStatusResponse>({ type: "agentSetWeekShare", percent })).status,
    agentSetTalkLoop: async (on) =>
      (await request<AgentStatusResponse>({ type: "agentSetTalkLoop", on })).status,
    agentInspect: async () => (await request<AgentStatusResponse>({ type: "agentInspect" })).status,
    agentPauseReading: async () =>
      (await request<AgentStatusResponse>({ type: "agentPauseReading" })).status,
    agentResumeReading: async () =>
      (await request<AgentStatusResponse>({ type: "agentResumeReading" })).status,
    agentTestRuntime: async () =>
      (await request<AgentStatusResponse>({ type: "agentTestRuntime" })).status,
    agentPrepare: async (threadId, guidance) =>
      (
        await request<AgentPrepareResponse>({
          type: "agentPrepare",
          threadId,
          ...(guidance?.direction === undefined ? {} : { direction: guidance.direction }),
          ...(guidance?.answer === undefined ? {} : { answer: guidance.answer }),
        })
      ).prepared,
    agentTalk: async (threadId, words) =>
      (await request<AgentTalkResponse>({ type: "agentTalk", threadId, words })).result,
    agentTalkStop: async (threadId) => {
      await request({ type: "agentTalkStop", threadId });
    },
    agentRewriteDraft: async (threadId, text, how) =>
      (await request<AgentRewriteDraftResponse>({ type: "agentRewriteDraft", threadId, text, how }))
        .text,
    agentAnswerQuestions: async (threadId, text, missing) =>
      (
        await request<AgentAnswerQuestionsResponse>({
          type: "agentAnswerQuestions",
          threadId,
          text,
          ...(missing === undefined || missing.length === 0 ? {} : { missing }),
        })
      ).text,
    agentCheckReply: async (threadId, text) =>
      (await request<AgentCheckReplyResponse>({ type: "agentCheckReply", threadId, text })).check,
    agentFillGaps: async (threadId, text) =>
      (await request<AgentFillGapsResponse>({ type: "agentFillGaps", threadId, text })).suggestions,
    agentTalkEntries: async (threadId) =>
      (await request<AgentTalkEntriesResponse>({ type: "agentTalkEntries", threadId })).entries,
    agentTalkAll: async (words, talkId) =>
      (
        await request<AgentTalkAllResponse>({
          type: "agentTalkAll",
          words,
          ...(typeof talkId === "number" ? { talkId } : {}),
        })
      ).result,
    agentTalkAllStop: async () => {
      await request({ type: "agentTalkAllStop" });
    },
    agentTalkAllEntries: async (talkId, beforeId) =>
      (
        await request<AgentTalkAllEntriesResponse>({
          type: "agentTalkAllEntries",
          ...(talkId === undefined ? {} : { talkId }),
          ...(beforeId === undefined ? {} : { beforeId }),
        })
      ).entries,
    agentTalks: async () => (await request<AgentTalksResponse>({ type: "agentTalks" })).talks,
    agentTalkRename: async (talkId, title) => {
      await request({ type: "agentTalkRename", talkId, title });
    },
    agentTalkDelete: async (talkId) => {
      await request({ type: "agentTalkDelete", talkId });
    },
    agentTalkDeleteAll: async () =>
      (await request<AgentTalkDeleteAllResponse>({ type: "agentTalkDeleteAll" })).count,
    agentUndoFeedback: async (threadId, kind) => {
      await request({ type: "agentUndoFeedback", threadId, kind });
    },
    agentDraftFromPrepared: async (threadId, body) => {
      const r = await request<AgentDraftFromPreparedResponse>({
        type: "agentDraftFromPrepared",
        threadId,
        body,
      });
      return { draftId: r.draftId, existing: r.existing };
    },
    agentMatchAct: async (query) => {
      const r = await request<AgentMatchActResponse>({ type: "agentMatchAct", query });
      return { messages: r.messages, capped: r.capped };
    },
    agentPromptCount: async (query) =>
      (await request<AgentPromptCountResponse>({ type: "agentPromptCount", query })).count,
    agentPromptVerdicts: async (query) =>
      (await request<AgentPromptVerdictsResponse>({ type: "agentPromptVerdicts", query })).list,
    agentPromptBadge: async (query) =>
      (await request<AgentPromptBadgeResponse>({ type: "agentPromptBadge", query })).badge,
    agentPromptRun: async (query, again, readAll) =>
      (
        await request<AgentPromptRunResponse>({
          type: "agentPromptRun",
          query,
          ...(again === true ? { again } : {}),
          ...(readAll === true ? { readAll } : {}),
        })
      ).result,
    agentPromptStop: async () => {
      await request({ type: "agentPromptStop" });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Resolves with the port the preload forwards once main has connected us to the backend. */
export function waitForPort(): Promise<MessagePort> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const [port] = event.ports;
      if (event.source !== window || event.data !== "matters:port" || !port) return;
      window.removeEventListener("message", onMessage);
      resolve(port);
    };
    window.addEventListener("message", onMessage);
  });
}
