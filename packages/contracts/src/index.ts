import type {
  ActMatch,
  AddInstructionInput,
  AddRuleInput,
  AgentInstruction,
  AgentModels,
  AgentRule,
  AgentStatus,
  AttachmentState,
  DeleteForeverResult,
  DiscoveredServers,
  Draft,
  DraftContent,
  FailureDetail,
  FileHit,
  GapSuggestion,
  GeneralImages,
  HtmlKind,
  ImageChoice,
  ImageRule,
  ImageRuleDecision,
  ImageRuleScope,
  JournalEntry,
  Label,
  Message,
  MoveAction,
  MoveKind,
  MoveTarget,
  MoveThreadResult,
  NoticeText,
  NotificationPrefs,
  PersonSuggestion,
  PrepareResult,
  PromptBadge,
  PromptCount,
  PromptList,
  PromptProgress,
  PromptRunResult,
  ReceivedAttachment,
  RememberResult,
  ReplyCheck,
  ReplyMode,
  ReplyRedirect,
  RewriteHow,
  RuleOffer,
  SavedView,
  SendOperation,
  SortRanked,
  StoppableSource,
  SyncStatus,
  TalkEntry,
  TalkResult,
  TalkSummary,
  Thread,
  ThreadAgentView,
  TransportSecurity,
  UndoMoveResult,
  UndoResult,
} from "@matters/core";

/**
 * Renderer <-> backend messages over a MessagePort. Plain data only, so every
 * value survives structured clone. The renderer chooses `requestId`; the
 * backend echoes it on the response.
 */
export type RequestId = string;

export interface ListNewestRequest {
  readonly type: "listNewest";
  readonly requestId: RequestId;
  readonly labelId?: string;
  readonly beforeKey?: number;
  readonly limit: number;
}

export interface OpenThreadRequest {
  readonly type: "openThread";
  readonly requestId: RequestId;
  readonly threadId: string;
  /**
   * The thread is being looked at from Trash or Spam (ADR 0044): all of its messages are shown.
   * Otherwise the ones that were deleted or marked as spam are left out of it.
   */
  readonly hidden?: boolean;
}

export interface SearchRequest {
  readonly type: "search";
  readonly requestId: RequestId;
  /** Raw user text; the backend parses it, nothing is trusted. */
  readonly query: string;
  readonly beforeKey?: number;
  /** The cursor of an oldest-first list (`sort:oldest`, ADR 0116, rule 4b). */
  readonly afterKey?: number;
  readonly limit: number;
}

/** Messages by key, to refresh rows after a `changes` event. */
export interface GetMessagesRequest {
  readonly type: "getMessages";
  readonly requestId: RequestId;
  readonly keys: readonly number[];
}

/** Only the domain is sent: discovery never sees the address or the password. */
/** The HTML of one message, as sent. Untrusted: the page sanitizes it before showing it. */
export interface GetMessageHtmlRequest {
  readonly type: "getMessageHtml";
  readonly requestId: RequestId;
  readonly key: number;
}

/** Distinct folded label names, for query suggestions (ADR 0026). */
export interface ListLabelsRequest {
  readonly type: "listLabels";
  readonly requestId: RequestId;
}

/** People whose name or address starts with `prefix`, for query suggestions (ADR 0028). */
export interface SuggestPeopleRequest {
  readonly type: "suggestPeople";
  readonly requestId: RequestId;
  readonly prefix: string;
  readonly limit: number;
}

/** Files received in mail whose name contains `text`, for the search panel (ADR 0074). */
export interface SearchFilesRequest {
  readonly type: "searchFiles";
  readonly requestId: RequestId;
  readonly text: string;
  /** Default 5, at most 50. */
  readonly limit?: number;
  readonly accountId?: string;
}

export interface DiscoverServersRequest {
  readonly type: "discoverServers";
  readonly requestId: RequestId;
  readonly domain: string;
}

export interface ListAccountsRequest {
  readonly type: "listAccounts";
  readonly requestId: RequestId;
}

export interface ServerInput {
  readonly host: string;
  readonly port: number;
  readonly security: TransportSecurity;
  readonly username: string;
}

/**
 * Tests the login (and lists folders), then stores the account and its password. The password
 * travels here once and is never sent back.
 */
export interface AddAccountRequest {
  readonly type: "addAccount";
  readonly requestId: RequestId;
  readonly address: string;
  readonly displayName?: string;
  readonly password: string;
  readonly imap: ServerInput;
  /** The outgoing server; without it the account can read but not send. */
  readonly smtp?: ServerInput;
}

export interface RemoveAccountRequest {
  readonly type: "removeAccount";
  readonly requestId: RequestId;
  readonly accountId: string;
}

export interface SyncNowRequest {
  readonly type: "syncNow";
  readonly requestId: RequestId;
  readonly accountId: string;
}

/**
 * A new password for an account that has one (ADR 0113). The backend logs in with it first and
 * replaces the saved password only when the servers take it. It travels here once and is never
 * sent back.
 */
export interface ChangePasswordRequest {
  readonly type: "changePassword";
  readonly requestId: RequestId;
  readonly accountId: string;
  readonly password: string;
}

/** The starting point of a new message. Nothing is stored until the first `saveDraft`. */
export interface PrepareNewRequest {
  readonly type: "prepareNew";
  readonly requestId: RequestId;
  readonly accountId?: string;
}

/** The starting point of a reply (or reply-all) to a thread, plus the draft already answering it. */
export interface PrepareReplyRequest {
  readonly type: "prepareReply";
  readonly requestId: RequestId;
  readonly threadId: string;
  readonly mode: ReplyMode;
}

/**
 * The starting point of a forward (ADR 0045, rule 1): the newest message of the thread that is not
 * in Trash or Spam, quoted, with no recipients and no thread. `hidden` is as for `openThread`.
 */
export interface PrepareForwardRequest {
  readonly type: "prepareForward";
  readonly requestId: RequestId;
  readonly threadId: string;
  readonly hidden?: boolean;
}

export interface GetDraftRequest {
  readonly type: "getDraft";
  readonly requestId: RequestId;
  readonly draftId: string;
}

/** Creates a draft (no `id`) or replaces the content of one; autosave calls this. */
export interface SaveDraftRequest {
  readonly type: "saveDraft";
  readonly requestId: RequestId;
  readonly id?: string;
  readonly content: DraftContent;
}

export interface DeleteDraftRequest {
  readonly type: "deleteDraft";
  readonly requestId: RequestId;
  readonly draftId: string;
}

/** The HTML the message will have, from the same function that builds the sent message. */
export interface RenderPreviewRequest {
  readonly type: "renderPreview";
  readonly requestId: RequestId;
  readonly markdown: string;
}

/** Send pressed: approves this version of the draft and starts the undo window. */
export interface RequestSendRequest {
  readonly type: "requestSend";
  readonly requestId: RequestId;
  readonly draftId: string;
}

export interface UndoSendRequest {
  readonly type: "undoSend";
  readonly requestId: RequestId;
  readonly operationId: string;
}

/**
 * What the user can do with a held, failed or unknown send. `stop` cuts a large upload short
 * while its data has not ended (ADR 0041, rule 14); the send becomes `cancelled`.
 */
export type SendAction = "sendNow" | "retry" | "discard" | "sendAgain" | "markSent" | "stop";

export interface SendActionRequest {
  readonly type: "sendAction";
  readonly requestId: RequestId;
  readonly operationId: string;
  readonly action: SendAction;
}

export interface ListOutboxRequest {
  readonly type: "listOutbox";
  readonly requestId: RequestId;
}

export interface ListViewsRequest {
  readonly type: "listViews";
  readonly requestId: RequestId;
}

/**
 * Without `id`, creates a view (`name` and `query`). With `id`, either replaces the query of the
 * view (`query`) or renames it (`name`), never both. Writes: the sync worker runs it.
 */
export interface SaveViewRequest {
  readonly type: "saveView";
  readonly requestId: RequestId;
  readonly id?: string;
  readonly name?: string;
  readonly query?: string;
}

export interface DeleteViewRequest {
  readonly type: "deleteView";
  readonly requestId: RequestId;
  readonly id: string;
}

/** The view's recent searches, latest first (ADR 0030). `All mail` has them too. */
export interface ListSearchesRequest {
  readonly type: "listSearches";
  readonly requestId: RequestId;
  readonly viewId: string;
}

/** Writes: the sync worker runs them. */
export interface NoteSearchRequest {
  readonly type: "noteSearch";
  readonly requestId: RequestId;
  readonly viewId: string;
  readonly query: string;
}

export interface ForgetSearchRequest {
  readonly type: "forgetSearch";
  readonly requestId: RequestId;
  readonly viewId: string;
  readonly query: string;
}

export interface ClearSearchesRequest {
  readonly type: "clearSearches";
  readonly requestId: RequestId;
  readonly viewId: string;
}

/** Puts the view at this place in the tab order (0 is first). */
export interface MoveViewRequest {
  readonly type: "moveView";
  readonly requestId: RequestId;
  readonly id: string;
  readonly toIndex: number;
}

/**
 * Unread messages a query matches in one index window of at most `cap` keys (ADR 0027); ask
 * again below `nextBeforeKey` to go on. Nothing is loaded.
 */
export interface CountMatchesRequest {
  readonly type: "countMatches";
  readonly requestId: RequestId;
  readonly query: string;
  readonly cap: number;
  readonly beforeKey?: number;
}

/**
 * The ranked order of a query without a prompt, `sort:relevance` (ADR 0116, rule 4b): asked
 * after `↵`, never on a keystroke. It runs in the sync worker.
 */
export interface SortRankedRequest {
  readonly type: "sortRanked";
  readonly requestId: RequestId;
  readonly query: string;
}

/**
 * What is decided about the images of one message, without its HTML: asked again after a rule or
 * the general setting changed (ADR 0037).
 */
export interface GetImageChoiceRequest {
  readonly type: "getImageChoice";
  readonly requestId: RequestId;
  readonly key: number;
}

/** Settings › Storage (ADR 0089): the cheap numbers and the kept measurements. */
export interface GetStorageRequest {
  readonly type: "getStorage";
  readonly requestId: RequestId;
}

/** Measures the database by table now (about 2 s, on the read thread) and keeps the result. */
export interface MeasureStorageRequest {
  readonly type: "measureStorage";
  readonly requestId: RequestId;
}

/** `VACUUM` on the sync worker: seconds, and sync waits for it. */
export interface CompactStorageRequest {
  readonly type: "compactStorage";
  readonly requestId: RequestId;
}

/** Empties the text the agent read from attached files (ADR 0087, rule 11). Writes: the sync worker runs it. */
export interface ClearFileTextRequest {
  readonly type: "clearFileText";
  readonly requestId: RequestId;
}

export interface ListImageRulesRequest {
  readonly type: "listImageRules";
  readonly requestId: RequestId;
}

/** Inserts or replaces the rule for this scope and value. Writes: the sync worker runs it. */
export interface SetImageRuleRequest {
  readonly type: "setImageRule";
  readonly requestId: RequestId;
  readonly scope: ImageRuleScope;
  readonly value: string;
  readonly decision: ImageRuleDecision;
}

export interface RemoveImageRuleRequest {
  readonly type: "removeImageRule";
  readonly requestId: RequestId;
  readonly scope: ImageRuleScope;
  readonly value: string;
}

/** `Stop showing images from …` for the rule that allowed them (ADR 0037, point 3). */
export interface StopImagesRequest {
  readonly type: "stopImages";
  readonly requestId: RequestId;
  readonly address: string;
  readonly source: StoppableSource;
}

export interface SetGeneralImagesRequest {
  readonly type: "setGeneralImages";
  readonly requestId: RequestId;
  readonly general: GeneralImages;
}

/** The addresses of the old per-sender list, to become `allow` rules once (ADR 0037, point 8). */
export interface ImportImageAddressesRequest {
  readonly type: "importImageAddresses";
  readonly requestId: RequestId;
  readonly addresses: readonly string[];
}

/**
 * Marks messages read or unread (ADR 0039). The local flag changes at once and the server is told
 * later by the sync worker, so the answer does not wait for the network.
 */
export interface SetSeenRequest {
  readonly type: "setSeen";
  readonly requestId: RequestId;
  readonly keys: readonly number[];
  readonly seen: boolean;
}

/**
 * Moves a thread: archive, delete, spam or to a folder (ADR 0044, rule 5). The labels change at
 * once and the server is told when the undo window is over, so the answer does not wait for the
 * network.
 */
export interface MoveThreadRequest {
  readonly type: "moveThread";
  readonly requestId: RequestId;
  readonly threadId: string;
  /** More threads moved with it as one action, with one Undo (ADR 0056, rule 6). */
  readonly others?: readonly string[];
  readonly action: MoveAction;
  /** Only for `move`. */
  readonly target?: MoveTarget;
  /** The thread is being looked at from Trash or Spam: what is shown there is moved. */
  readonly hidden?: boolean;
}

/** Takes the move back while its window lasts (ADR 0044, rule 10). */
export interface UndoMoveRequest {
  readonly type: "undoMove";
  readonly requestId: RequestId;
  readonly operationId: string;
}

/**
 * Deletes messages for good (ADR 0044, rules 7 and 16). Refused for anything not in Trash, here
 * and in the core. Answered when the requests are stored, not when the server has done it.
 */
export interface DeleteForeverRequest {
  readonly type: "deleteForever";
  readonly requestId: RequestId;
  readonly keys: readonly number[];
}

/** The folders sync last listed, for the Move list (ADR 0044, rule 17). */
/** The notification settings (ADR 0071); the router keeps them. */
export interface GetNotificationPrefsRequest {
  readonly type: "getNotificationPrefs";
  readonly requestId: RequestId;
}

/** Replaces the notification settings whole; the router defends every field. */
export interface SetNotificationPrefsRequest {
  readonly type: "setNotificationPrefs";
  readonly requestId: RequestId;
  readonly prefs: NotificationPrefs;
}

/** Shows one made-up notice through every channel that is on, to see what it looks like. */
export interface TestNotificationRequest {
  readonly type: "testNotification";
  readonly requestId: RequestId;
}

/**
 * Pauses banners until a time, or resumes them (null), and changes nothing else (ADR 0108). The
 * app menu asks it; the router keeps the settings, so every window hears the change.
 */
export interface PauseNotificationsRequest {
  readonly type: "pauseNotifications";
  readonly requestId: RequestId;
  readonly untilMs: number | null;
}

/** Main says the system refused the test banner (Electron's `failed`), with its reason. */
export interface BannerFailedRequest {
  readonly type: "bannerFailed";
  readonly requestId: RequestId;
  readonly reason: string;
}

export interface ListFoldersRequest {
  readonly type: "listFolders";
  readonly requestId: RequestId;
}

/**
 * Puts files, named by grants, on a draft (ADR 0041, rule 3). The page never supplies a path:
 * main minted each `grantId` for a path it saw itself, and a grant works once. `id` is chosen by
 * the renderer so its chip exists before this answers; the name and size come from the grant.
 */
export interface AddAttachmentsRequest {
  readonly type: "addAttachments";
  readonly requestId: RequestId;
  readonly draftId: string;
  readonly files: readonly { readonly id: string; readonly grantId: string }[];
}

/**
 * Puts files of a received message on a draft (ADR 0045, rule 6). Not paths and not grants: a
 * message key and a part, which are only names in the cache of ADR 0043. The backend takes the
 * file's name and size from the message, downloads the part and copies it into the draft's own.
 */
export interface AddForwardedAttachmentsRequest {
  readonly type: "addForwardedAttachments";
  readonly requestId: RequestId;
  readonly draftId: string;
  readonly files: readonly {
    readonly id: string;
    readonly messageKey: number;
    readonly partId: string;
  }[];
}

/** The ids of the draft's files whose original changed since they were copied. */
export interface CheckAttachmentSourcesRequest {
  readonly type: "checkAttachmentSources";
  readonly requestId: RequestId;
  readonly draftId: string;
}

/** "Use new version": reads the original of this file again, as a new attachment. */
export interface RecaptureAttachmentRequest {
  readonly type: "recaptureAttachment";
  readonly requestId: RequestId;
  readonly draftId: string;
  readonly id: string;
}

export interface ListAttachmentsRequest {
  readonly type: "listAttachments";
  readonly requestId: RequestId;
  readonly draftId: string;
}

/**
 * Makes a copy of a received file exist in the cache, downloading it if it is not there (ADR 0043,
 * rule 6). The page does not send this: main does, before it opens, previews or saves, over a port
 * of its own. The answer says how it ended and carries no path.
 */
export interface FetchReceivedRequest {
  readonly type: "fetchReceived";
  readonly requestId: RequestId;
  readonly messageKey: number;
  readonly partId: string;
}

// --- Agents (ADR 0051, 0052) ---

/** Where AI stands: settings, the runtime, consent, reading progress and the ledger. */
export interface AgentStatusRequest {
  readonly type: "agentStatus";
  readonly requestId: RequestId;
}

/** What the agent already has for one thread, in an ordinary thread view (ADR 0063). A local read. */
export interface AgentThreadRequest {
  readonly type: "agentThread";
  readonly requestId: RequestId;
  readonly threadId: string;
}

/** What the agent and the person did, newest first (ADR 0054, rule 6). A local read. */
export interface AgentJournalRequest {
  readonly type: "agentJournal";
  readonly requestId: RequestId;
  /** 1 to 200; 50 when absent. */
  readonly limit?: number;
}

/** The active rules (ADR 0054, rule 7), in the order they were added. A local read. */
export interface AgentRulesRequest {
  readonly type: "agentRules";
  readonly requestId: RequestId;
}

/** The active instructions for the model (ADR 0054, rule 7), oldest first. A local read. */
export interface AgentInstructionsRequest {
  readonly type: "agentInstructions";
  readonly requestId: RequestId;
}

/**
 * What to keep from words the person typed about a thread. One background turn on the sync worker;
 * its request holds the words and nothing from the thread (ADR 0054, rule 8).
 */
export interface AgentRememberRequest {
  readonly type: "agentRemember";
  readonly requestId: RequestId;
  readonly threadId: string;
  readonly words: string;
}

/** Keeps an instruction the person typed in Settings; runs no turn. */
export type AgentAddInstructionRequest = {
  readonly type: "agentAddInstruction";
  readonly requestId: RequestId;
} & AddInstructionInput;

export interface AgentRemoveInstructionRequest {
  readonly type: "agentRemoveInstruction";
  readonly requestId: RequestId;
  readonly instructionId: number;
}

/** What the tray offers after a thing is closed: a rule for its sender, or null. A local read. */
export interface AgentRuleOfferRequest {
  readonly type: "agentRuleOffer";
  readonly requestId: RequestId;
  readonly threadId: string;
}

/**
 * Adds a rule as the person. Either the sender of a thread (`threadId`, scope `sender`: the address
 * comes from the store) or a typed `subject`. Adding an active rule again changes nothing.
 */
export type AgentAddRuleRequest = {
  readonly type: "agentAddRule";
  readonly requestId: RequestId;
} & AddRuleInput;

export interface AgentRemoveRuleRequest {
  readonly type: "agentRemoveRule";
  readonly requestId: RequestId;
  readonly ruleId: number;
}

/** Turns AI on: records the consent for these accounts and this runtime. */
export interface AgentSetEnabledRequest {
  readonly type: "agentSetEnabled";
  readonly requestId: RequestId;
  readonly accountIds: readonly string[];
  readonly runtimeId: string;
}

/** Turns AI off and takes every consent back. */
export interface AgentDisableRequest {
  readonly type: "agentDisable";
  readonly requestId: RequestId;
}

export interface AgentSetModelsRequest {
  readonly type: "agentSetModels";
  readonly requestId: RequestId;
  readonly models: Partial<AgentModels>;
}

export interface AgentSetWeekShareRequest {
  readonly type: "agentSetWeekShare";
  readonly requestId: RequestId;
  /** 0 to 100. */
  readonly percent: number;
}

/** Turns the agent's search in a loop with tools on or off (ADR 0083). */
export interface AgentSetTalkLoopRequest {
  readonly type: "agentSetTalkLoop";
  readonly requestId: RequestId;
  readonly on: boolean;
}

/** Looks at the runtime again. Sends no mail and spends nothing from the plan. */
export interface AgentInspectRequest {
  readonly type: "agentInspect";
  readonly requestId: RequestId;
}

/** The person stops the reading until they say so; it lasts across restarts (ADR 0053, rule 8). */
export interface AgentPauseReadingRequest {
  readonly type: "agentPauseReading";
  readonly requestId: RequestId;
}

export interface AgentResumeReadingRequest {
  readonly type: "agentResumeReading";
  readonly requestId: RequestId;
}

/** The test with a made-up message (ADR 0051, rule 5). Never mail. */
export interface AgentTestRuntimeRequest {
  readonly type: "agentTestRuntime";
  readonly requestId: RequestId;
}

/** Prepares a draft for a thing, now. The person's direction and words go to the model as theirs. */
export interface AgentPrepareRequest {
  readonly type: "agentPrepare";
  readonly requestId: RequestId;
  readonly threadId: string;
  readonly direction?: string;
  readonly answer?: string;
}

/**
 * The person talks about a thread (ADR 0064): one turn on the sync worker. The words are theirs;
 * the answer is text, a draft, a question or a closing.
 */
export interface AgentTalkRequest {
  readonly type: "agentTalk";
  readonly requestId: RequestId;
  readonly threadId: string;
  readonly words: string;
}

/**
 * The agent helps write a reply (ADR 0098). Each is one `P0` turn the person asked for; none sends
 * mail or changes a stored draft, and the result goes back to the composer only. `text` is the
 * whole Markdown body as the composer holds it: the quote below the person's lines is kept as it is.
 */
export interface AgentRewriteDraftRequest {
  readonly type: "agentRewriteDraft";
  readonly requestId: RequestId;
  readonly threadId: string;
  readonly text: string;
  readonly how: RewriteHow;
}

/** Adds short answers for what the other side's last message asked and the draft does not answer. */
export interface AgentAnswerQuestionsRequest {
  readonly type: "agentAnswerQuestions";
  readonly requestId: RequestId;
  readonly threadId: string;
  readonly text: string;
  /** What the check found unanswered, in its words; answered first. */
  readonly missing?: readonly string[];
}

/** What the draft answers of what the other side's last message asked. */
export interface AgentCheckReplyRequest {
  readonly type: "agentCheckReply";
  readonly requestId: RequestId;
  readonly threadId: string;
  readonly text: string;
}

/** Values from the thread for the gaps in square brackets the person left. */
export interface AgentFillGapsRequest {
  readonly type: "agentFillGaps";
  readonly requestId: RequestId;
  readonly threadId: string;
  readonly text: string;
}

/** Cuts the running talk turn of a thread short. */
export interface AgentTalkStopRequest {
  readonly type: "agentTalkStop";
  readonly requestId: RequestId;
  readonly threadId: string;
}

/** The talk about a thread, oldest first. A local read. */
export interface AgentTalkEntriesRequest {
  readonly type: "agentTalkEntries";
  readonly requestId: RequestId;
  readonly threadId: string;
}

/**
 * The person asks across all their mail (ADR 0064, rule 7): a search turn, a search on this
 * machine, then an answer turn. One running at a time.
 */
export interface AgentTalkAllRequest {
  readonly type: "agentTalkAll";
  readonly requestId: RequestId;
  readonly words: string;
  /** The talk it is asked in (ADR 0086); absent starts a new talk. */
  readonly talkId?: number;
}

/** Cuts the running turn across all mail short. */
export interface AgentTalkAllStopRequest {
  readonly type: "agentTalkAllStop";
  readonly requestId: RequestId;
}

/**
 * A talk across all mail, oldest first (ADR 0086): of `talkId`, or of every talk without it; with
 * `beforeId`, the page before that entry. A local read.
 */
export interface AgentTalkAllEntriesRequest {
  readonly type: "agentTalkAllEntries";
  readonly requestId: RequestId;
  readonly talkId?: number;
  readonly beforeId?: number;
}

/** The talks across all mail, the latest first (ADR 0086, rule 5). A local read. */
export interface AgentTalksRequest {
  readonly type: "agentTalks";
  readonly requestId: RequestId;
}

/** The person names a talk (ADR 0086, rule 9); blank gives it back its first question. */
export interface AgentTalkRenameRequest {
  readonly type: "agentTalkRename";
  readonly requestId: RequestId;
  readonly talkId: number;
  readonly title: string;
}

/** Removes one talk across all mail and its entries (ADR 0086, rule 10). */
export interface AgentTalkDeleteRequest {
  readonly type: "agentTalkDelete";
  readonly requestId: RequestId;
  readonly talkId: number;
}

/** Removes every talk across all mail (ADR 0086, rule 11). */
export interface AgentTalkDeleteAllRequest {
  readonly type: "agentTalkDeleteAll";
  readonly requestId: RequestId;
}

/** Takes the consent for one account back; AI stays on for the others. */
export interface AgentRevokeConsentRequest {
  readonly type: "agentRevokeConsent";
  readonly requestId: RequestId;
  readonly accountId: string;
}

/** Undo of the latest `agentFeedback` of this kind for the thread. */
export interface AgentUndoFeedbackRequest {
  readonly type: "agentUndoFeedback";
  readonly requestId: RequestId;
  readonly threadId: string;
  readonly kind: "notImportant" | "later" | "closed";
}

/**
 * Makes a reply draft with this text, by the composer's reply rules. It is a draft and nothing
 * else: the page sends it with `requestSend`, or opens the composer on it.
 */
export interface AgentDraftFromPreparedRequest {
  readonly type: "agentDraftFromPrepared";
  readonly requestId: RequestId;
  readonly threadId: string;
  readonly body: string;
}

/**
 * What the press of a clean-up offer acts on (ADR 0102, rule 7): the query matched in the scope
 * its count was made in, the accounts agreed to and without the threads the person's rules cover,
 * up to the cap. Read-only; no text comes back.
 */
export interface AgentMatchActRequest {
  readonly type: "agentMatchAct";
  readonly requestId: RequestId;
  readonly query: string;
}

/**
 * A prompt in the query bar (ADR 0116, rule 4): whether its search with the mail filters of
 * `query` ran, how many threads the kept search finds now, how many of them have a verdict, and
 * whether a run of it is going on. No model.
 */
export interface AgentPromptCountRequest {
  readonly type: "agentPromptCount";
  readonly requestId: RequestId;
  /** The whole text of the query bar; it must hold a prompt. */
  readonly query: string;
}

/** The verdicts kept for the prompt of `query`, as the list shows them (ADR 0116, rule 7). No model. */
export interface AgentPromptVerdictsRequest {
  readonly type: "agentPromptVerdicts";
  readonly requestId: RequestId;
  readonly query: string;
}

/**
 * The number on the tab of a saved view whose text holds a prompt (ADR 0117, rule 4): unread
 * threads among those it shows, from stored verdicts. No model; none for a view never run.
 */
export interface AgentPromptBadgeRequest {
  readonly type: "agentPromptBadge";
  readonly requestId: RequestId;
  readonly query: string;
}

/**
 * Runs the prompt of `query` (ADR 0116, rule 3): `↵` in the query bar, or opening a saved view
 * that holds a prompt. The agent searches first when no search is kept for the prompt and its mail
 * filters, or when `again` asks for a new one (rule 4); then the threads found with no verdict are
 * read. `agentPromptProgress` follows each step.
 */
export interface AgentPromptRunRequest {
  readonly type: "agentPromptRun";
  readonly requestId: RequestId;
  readonly query: string;
  /** `Search again`: the kept search is replaced by a new one. */
  readonly again?: boolean;
  /**
   * The person saw how many threads are left to read and pressed `↵` (rule 4): more than
   * `PROMPT_ASK_ABOVE` are read without asking. Absent: above it the run ends with `ask`.
   */
  readonly readAll?: boolean;
}

/**
 * Cuts the running prompt short (ADR 0116, rule 9): a search keeps nothing, a reading keeps the
 * batches that finished.
 */
export interface AgentPromptStopRequest {
  readonly type: "agentPromptStop";
  readonly requestId: RequestId;
}

export type BackendRequest =
  | AgentStatusRequest
  | AgentPromptCountRequest
  | AgentPromptVerdictsRequest
  | AgentPromptBadgeRequest
  | AgentPromptRunRequest
  | AgentPromptStopRequest
  | AgentThreadRequest
  | AgentJournalRequest
  | AgentRulesRequest
  | AgentInstructionsRequest
  | AgentRememberRequest
  | AgentAddInstructionRequest
  | AgentRemoveInstructionRequest
  | AgentRuleOfferRequest
  | AgentAddRuleRequest
  | AgentRemoveRuleRequest
  | AgentSetEnabledRequest
  | AgentDisableRequest
  | AgentSetModelsRequest
  | AgentSetWeekShareRequest
  | AgentSetTalkLoopRequest
  | AgentInspectRequest
  | AgentTestRuntimeRequest
  | AgentPauseReadingRequest
  | AgentResumeReadingRequest
  | AgentPrepareRequest
  | AgentTalkRequest
  | AgentRewriteDraftRequest
  | AgentAnswerQuestionsRequest
  | AgentCheckReplyRequest
  | AgentFillGapsRequest
  | AgentTalkStopRequest
  | AgentTalkEntriesRequest
  | AgentTalkAllRequest
  | AgentTalkAllStopRequest
  | AgentTalkAllEntriesRequest
  | AgentTalksRequest
  | AgentTalkRenameRequest
  | AgentTalkDeleteRequest
  | AgentTalkDeleteAllRequest
  | AgentUndoFeedbackRequest
  | AgentRevokeConsentRequest
  | AgentDraftFromPreparedRequest
  | AgentMatchActRequest
  | FetchReceivedRequest
  | AddAttachmentsRequest
  | AddForwardedAttachmentsRequest
  | CheckAttachmentSourcesRequest
  | RecaptureAttachmentRequest
  | ListAttachmentsRequest
  | SetSeenRequest
  | MoveThreadRequest
  | UndoMoveRequest
  | DeleteForeverRequest
  | ListFoldersRequest
  | GetNotificationPrefsRequest
  | SetNotificationPrefsRequest
  | TestNotificationRequest
  | PauseNotificationsRequest
  | BannerFailedRequest
  | GetImageChoiceRequest
  | GetStorageRequest
  | MeasureStorageRequest
  | CompactStorageRequest
  | ClearFileTextRequest
  | ListImageRulesRequest
  | SetImageRuleRequest
  | RemoveImageRuleRequest
  | StopImagesRequest
  | SetGeneralImagesRequest
  | ImportImageAddressesRequest
  | SuggestPeopleRequest
  | SearchFilesRequest
  | ListViewsRequest
  | SaveViewRequest
  | DeleteViewRequest
  | MoveViewRequest
  | ListSearchesRequest
  | NoteSearchRequest
  | ForgetSearchRequest
  | ClearSearchesRequest
  | CountMatchesRequest
  | SortRankedRequest
  | PrepareNewRequest
  | PrepareReplyRequest
  | PrepareForwardRequest
  | GetDraftRequest
  | SaveDraftRequest
  | DeleteDraftRequest
  | RenderPreviewRequest
  | RequestSendRequest
  | UndoSendRequest
  | SendActionRequest
  | ListOutboxRequest
  | ListNewestRequest
  | OpenThreadRequest
  | SearchRequest
  | GetMessagesRequest
  | GetMessageHtmlRequest
  | ListLabelsRequest
  | DiscoverServersRequest
  | ListAccountsRequest
  | AddAccountRequest
  | RemoveAccountRequest
  | SyncNowRequest
  | ChangePasswordRequest;

export interface ListNewestResponse {
  readonly type: "listNewest";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly messages: readonly Message[];
}

/** A message of an opened thread with its plain-text body (empty when none is stored). */
export interface ThreadMessage extends Message {
  readonly bodyText: string;
  /** Absent when the message has no HTML stored. */
  readonly htmlKind?: HtmlKind;
  /** The files to list, in order, read with the thread (ADR 0043, rule 1). No path, no hash. */
  readonly attachments: readonly ReceivedAttachment[];
  /** False until the structure has been read: the paperclip shows, and nothing can be opened yet. */
  readonly attachmentsKnown: boolean;
  /** The message also has parts inside its body that are not listed (ADR 0045, rule 12). */
  readonly hasInline: boolean;
}

export interface OpenThreadResponse {
  readonly type: "openThread";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly thread: Thread;
  readonly messages: readonly ThreadMessage[];
}

export interface SearchResponse {
  readonly type: "search";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly messages: readonly Message[];
  /** Ask again below this key. A page may be short or empty and still have one. */
  readonly nextBeforeKey?: number;
  /** An oldest-first list: ask again above this key. */
  readonly nextAfterKey?: number;
}

export interface GetMessagesResponse {
  readonly type: "getMessages";
  readonly requestId: RequestId;
  readonly ok: true;
  /** Same order as the keys asked for; keys that no longer exist are left out. */
  readonly messages: readonly Message[];
}

export interface ListLabelsResponse {
  readonly type: "listLabels";
  readonly requestId: RequestId;
  readonly ok: true;
  /** Folded, sorted, at most 500. */
  readonly labels: readonly string[];
}

export interface SuggestPeopleResponse {
  readonly type: "suggestPeople";
  readonly requestId: RequestId;
  readonly ok: true;
  /** Most messages first; the user's own addresses are left out. */
  readonly people: readonly PersonSuggestion[];
}

export interface SearchFilesResponse {
  readonly type: "searchFiles";
  readonly requestId: RequestId;
  readonly ok: true;
  /** Newest message first; the same name in the same thread once. */
  readonly files: readonly FileHit[];
}

export interface GetMessageHtmlResponse {
  readonly type: "getMessageHtml";
  readonly requestId: RequestId;
  readonly ok: true;
  /** Null: this message has no HTML stored. */
  readonly html: string | null;
  /** What the rules say about its images; null when the message is gone (ADR 0037). */
  readonly images: ImageChoice | null;
}

export interface GetImageChoiceResponse {
  readonly type: "getImageChoice";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly images: ImageChoice | null;
}

/** One measurement of the database, bytes by the group Settings shows (ADR 0089). */
export interface StorageSampleInfo {
  readonly atMs: number;
  readonly messages: number;
  readonly fileBytes: number;
  readonly freeBytes: number;
  readonly searchBytes: number;
  readonly htmlBytes: number;
  readonly textBytes: number;
  /** Text the agent read from attached files (ADR 0087). */
  readonly filesTextBytes: number;
  readonly mailBytes: number;
}

export interface StorageReport {
  readonly messages: number;
  readonly accounts: readonly { readonly accountId: string; readonly messages: number }[];
  /** The database file now, and its unused pages. */
  readonly fileBytes: number;
  readonly freeBytes: number;
  /** Files whose text the agent read and kept (ADR 0087). */
  readonly filesRead: number;
  /** ADR 0088's move: messages left, and whether it is still listing them. */
  readonly repack: { readonly left: number; readonly listing: boolean };
  /** Kept measurements, oldest first; the last one splits the bar. */
  readonly samples: readonly StorageSampleInfo[];
}

/**
 * What main knows about the system's banners, for Settings › Notifications (ADR 0108): the
 * platform, and on macOS whether the app runs as its own bundle (`own`, ADR 0107) or as the stock
 * Electron runtime (`runtime`), which macOS shows no banners for. Never whether they are allowed:
 * Electron cannot read that.
 */
export interface NoticeSystem {
  readonly platform: "macos" | "windows" | "other";
  readonly app: "own" | "runtime" | "unknown";
}

/** What main measures for Settings › Storage: sizes per kind of folder, never paths (ADR 0089). */
export interface MainStorageInfo {
  readonly folders: {
    /** The database file with its WAL and shared memory. */
    readonly databaseBytes: number;
    /** Attachments of drafts, the send spool, received files, pasted files. */
    readonly filesBytes: number;
    /** What Chromium and Node keep to start fast; clearing them loses nothing. */
    readonly cachesBytes: number;
    readonly otherBytes: number;
  };
  readonly processes: readonly ProcessUsageInfo[];
}

export type ProcessKind = "backend" | "mail" | "settings" | "app" | "gpu" | "network" | "other";

export interface ProcessUsageInfo {
  readonly kind: ProcessKind;
  readonly memoryBytes: number;
  /** Percent of one core since the last sample, as Electron reports it. */
  readonly cpuPercent: number;
}

export interface GetStorageResponse {
  readonly type: "getStorage";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly storage: StorageReport;
}

export interface MeasureStorageResponse {
  readonly type: "measureStorage";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly storage: StorageReport;
}

export interface CompactStorageResponse {
  readonly type: "compactStorage";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly freedBytes: number;
  readonly ms: number;
}

export interface ClearFileTextResponse {
  readonly type: "clearFileText";
  readonly requestId: RequestId;
  readonly ok: true;
  /** How many files' text went. */
  readonly cleared: number;
}

export interface ListImageRulesResponse {
  readonly type: "listImageRules";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly rules: readonly ImageRule[];
  readonly general: GeneralImages;
}

export interface SetImageRuleResponse {
  readonly type: "setImageRule";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly rule: ImageRule;
}

export interface RemoveImageRuleResponse {
  readonly type: "removeImageRule";
  readonly requestId: RequestId;
  readonly ok: true;
  /** False when there was no such rule. */
  readonly removed: boolean;
}

export interface StopImagesResponse {
  readonly type: "stopImages";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface SetGeneralImagesResponse {
  readonly type: "setGeneralImages";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface ImportImageAddressesResponse {
  readonly type: "importImageAddresses";
  readonly requestId: RequestId;
  readonly ok: true;
  /** Rules added; addresses that already had a rule are not counted. */
  readonly added: number;
}

export interface DiscoverServersResponse {
  readonly type: "discoverServers";
  readonly requestId: RequestId;
  readonly ok: true;
  /** Null: nothing knew the domain; the user types the settings. */
  readonly found: DiscoveredServers | null;
}

/** An account for display: no secrets. */
export interface AccountInfo {
  readonly id: string;
  readonly address: string;
  readonly displayName: string;
  readonly host: string;
  readonly port: number;
  readonly security: TransportSecurity;
  readonly username: string;
  /** An outgoing server is set up. */
  readonly canSend: boolean;
  readonly status: SyncStatus;
}

export interface ListAccountsResponse {
  readonly type: "listAccounts";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly accounts: readonly AccountInfo[];
}

export interface AddAccountResponse {
  readonly type: "addAccount";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly account: AccountInfo;
  readonly folderCount: number;
}

export interface RemoveAccountResponse {
  readonly type: "removeAccount";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface SyncNowResponse {
  readonly type: "syncNow";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface ChangePasswordResponse {
  readonly type: "changePassword";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly account: AccountInfo;
  /**
   * What the outgoing server said: it logged in, the account does not send, or it could not be
   * asked (`outgoingNote` says why); a refusal is an `outgoingAuthFailed` error instead.
   */
  readonly outgoing: "verified" | "none" | "unchecked";
  readonly outgoingNote?: string;
}

/**
 * A file of a draft as the page sees it. There is no path and no hash: the page learns a file by
 * its name, size and state only (ADR 0041, rule 3).
 */
export interface AttachmentInfo {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly state: AttachmentState;
  /** Why it `failed` or is `tooLarge`, in words for the user; null otherwise. */
  readonly reason: string | null;
  /** Try again can help: false for a failed file whose message left the server (ADR 0045). */
  readonly canRetry: boolean;
  /** A part of a received message put on the draft by a forward (ADR 0045), not a file of the user. */
  readonly forwarded: boolean;
}

/**
 * What main tells the page about a file it was offered: the grant to hand to `addAttachments`
 * and what to show on the chip. A `kind` other than `file` has no grant (`grantId` is empty): a
 * folder or a path that is gone cannot be attached, and `tooLarge` is a pasted image over 50 MB.
 */
export interface PickedFile {
  readonly grantId: string;
  readonly name: string;
  readonly size: number;
  readonly kind: "file" | "directory" | "missing" | "tooLarge";
}

export interface AddAttachmentsResponse {
  readonly type: "addAttachments" | "addForwardedAttachments";
  readonly requestId: RequestId;
  readonly ok: true;
  /** The rows now on the draft, in the order asked; their copies are still being made. */
  readonly attachments: readonly AttachmentInfo[];
}

export interface CheckAttachmentSourcesResponse {
  readonly type: "checkAttachmentSources";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly changed: readonly string[];
}

export interface RecaptureAttachmentResponse {
  readonly type: "recaptureAttachment";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly attachment: AttachmentInfo;
}

export interface ListAttachmentsResponse {
  readonly type: "listAttachments";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly attachments: readonly AttachmentInfo[];
}

export interface PrepareResponse {
  readonly type: "prepareNew" | "prepareReply" | "prepareForward";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly content: DraftContent;
  /**
   * The largest message the account's outgoing server takes (ADR 0040, rule 4); null while
   * unknown. An unknown limit is asked once per session in the background and arrives as a
   * `messageLimit` event.
   */
  readonly messageLimitBytes: number | null;
  /** A draft already in progress for this thread; the composer opens it instead. */
  readonly existing: Draft | null;
  /** Set when a new reply goes elsewhere than to the sender, for the line above the fields (ADR 0042). */
  readonly redirect: ReplyRedirect | null;
  /** For a forward: the message it quotes, whose files the page puts on the draft (ADR 0045). */
  readonly forwardedKey?: number;
}

export interface GetDraftResponse {
  readonly type: "getDraft";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly draft: Draft;
}

export interface SaveDraftResponse {
  readonly type: "saveDraft";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly draft: Draft;
}

export interface DeleteDraftResponse {
  readonly type: "deleteDraft";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface RenderPreviewResponse {
  readonly type: "renderPreview";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly html: string;
}

export interface RequestSendResponse {
  readonly type: "requestSend";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly operation: SendOperation;
}

export interface UndoSendResponse {
  readonly type: "undoSend";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly result: UndoResult;
}

export interface SendActionResponse {
  readonly type: "sendAction";
  readonly requestId: RequestId;
  readonly ok: true;
  /** False when the operation was not in a state that allows the action. */
  readonly done: boolean;
}

export interface ListOutboxResponse {
  readonly type: "listOutbox";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly operations: readonly SendOperation[];
}

export type ErrorCode =
  | "notFound"
  /** A view was refused; the message says why and is meant to be shown. */
  | "invalidView"
  | "sendBlocked"
  | "invalidRequest"
  | "internal"
  // adding or syncing an account
  | "invalidAccount"
  | "accountExists"
  | "authFailed"
  | "tlsFailed"
  | "unreachable"
  | "insecureTransport"
  | "credentialsUnavailable"
  // incoming mail works, the outgoing server does not
  | "outgoingAuthFailed"
  | "outgoingFailed"
  /** The assistant cannot do this now (not ready, not agreed to, or out of allowance); the message says which. */
  | "agentUnavailable";

export interface ErrorResponse {
  readonly type: "error";
  readonly requestId: RequestId;
  readonly ok: false;
  readonly code: ErrorCode;
  readonly message: string;
  /**
   * What the server's answer told when adding or mending an account failed (ADR 0114): why a
   * sign-in was refused, what was wrong with TLS, and the server's own sentence for a quote.
   */
  readonly detail?: FailureDetail;
}

export interface ListViewsResponse {
  readonly type: "listViews";
  readonly requestId: RequestId;
  readonly ok: true;
  /** In tab order. */
  readonly views: readonly SavedView[];
}

export interface SaveViewResponse {
  readonly type: "saveView";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly view: SavedView;
}

export interface DeleteViewResponse {
  readonly type: "deleteView";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface ListSearchesResponse {
  readonly type: "listSearches";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly searches: readonly string[];
}

export interface NoteSearchResponse {
  readonly type: "noteSearch";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface ForgetSearchResponse {
  readonly type: "forgetSearch";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface ClearSearchesResponse {
  readonly type: "clearSearches";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface MoveViewResponse {
  readonly type: "moveView";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface CountMatchesResponse {
  readonly type: "countMatches";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly count: number;
  readonly nextBeforeKey?: number;
}

export interface SortRankedResponse {
  readonly type: "sortRanked";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly ranked: SortRanked;
}

export interface SetSeenResponse {
  readonly type: "setSeen";
  readonly requestId: RequestId;
  readonly ok: true;
  /** The change sequence after the write, and the messages whose flag really changed. */
  readonly changeSeq: number;
  readonly changedKeys: readonly number[];
}

export interface MoveThreadResponse extends MoveThreadResult {
  readonly type: "moveThread";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface UndoMoveResponse {
  readonly type: "undoMove";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly result: UndoMoveResult;
}

export interface DeleteForeverResponse extends DeleteForeverResult {
  readonly type: "deleteForever";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface NotificationPrefsResponse {
  readonly type: "getNotificationPrefs" | "setNotificationPrefs" | "pauseNotifications";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly prefs: NotificationPrefs;
}

export interface TestNotificationResponse {
  readonly type: "testNotification" | "bannerFailed";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface ListFoldersResponse {
  readonly type: "listFolders";
  readonly requestId: RequestId;
  readonly ok: true;
  /** Every account's folders, by account and id. */
  readonly folders: readonly Label[];
}

export type FetchReceivedOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "gone" }
  | { readonly kind: "offline" }
  | { readonly kind: "failed" };

export interface FetchReceivedResponse {
  readonly type: "fetchReceived";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly outcome: FetchReceivedOutcome;
}

/** The answer to every request that ends with the status of AI. */
export interface AgentStatusResponse {
  readonly type:
    | "agentStatus"
    | "agentSetEnabled"
    | "agentDisable"
    | "agentRevokeConsent"
    | "agentSetModels"
    | "agentSetWeekShare"
    | "agentSetTalkLoop"
    | "agentInspect"
    | "agentPauseReading"
    | "agentResumeReading"
    | "agentTestRuntime";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly status: AgentStatus;
}

export interface AgentThreadResponse {
  readonly type: "agentThread";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly view: ThreadAgentView;
}

export interface AgentJournalResponse {
  readonly type: "agentJournal";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly entries: readonly JournalEntry[];
}

export interface AgentRulesResponse {
  readonly type: "agentRules";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly rules: readonly AgentRule[];
}

export interface AgentInstructionsResponse {
  readonly type: "agentInstructions";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly instructions: readonly AgentInstruction[];
}

export interface AgentRememberResponse {
  readonly type: "agentRemember";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly result: RememberResult;
}

export interface AgentAddInstructionResponse {
  readonly type: "agentAddInstruction";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly instruction: AgentInstruction;
}

export interface AgentRemoveInstructionResponse {
  readonly type: "agentRemoveInstruction";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface AgentRuleOfferResponse {
  readonly type: "agentRuleOffer";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly offer: RuleOffer | null;
}

export interface AgentAddRuleResponse {
  readonly type: "agentAddRule";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly rule: AgentRule;
}

export interface AgentRemoveRuleResponse {
  readonly type: "agentRemoveRule";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface AgentPrepareResponse {
  readonly type: "agentPrepare";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly prepared: PrepareResult;
}

export interface AgentRewriteDraftResponse {
  readonly type: "agentRewriteDraft";
  readonly requestId: RequestId;
  readonly ok: true;
  /** The whole body again: the person's lines rewritten, the quote as it was. */
  readonly text: string;
}

export interface AgentAnswerQuestionsResponse {
  readonly type: "agentAnswerQuestions";
  readonly requestId: RequestId;
  readonly ok: true;
  /** The whole body again; exactly the text sent when nothing was left to answer. */
  readonly text: string;
}

export interface AgentCheckReplyResponse {
  readonly type: "agentCheckReply";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly check: ReplyCheck;
}

export interface AgentFillGapsResponse {
  readonly type: "agentFillGaps";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly suggestions: readonly GapSuggestion[];
}

export interface AgentTalkResponse {
  readonly type: "agentTalk";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly result: TalkResult;
}

export interface AgentTalkStopResponse {
  readonly type: "agentTalkStop";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface AgentTalkEntriesResponse {
  readonly type: "agentTalkEntries";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly entries: readonly TalkEntry[];
}

export interface AgentTalkAllResponse {
  readonly type: "agentTalkAll";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly result: TalkResult;
}

export interface AgentTalkAllStopResponse {
  readonly type: "agentTalkAllStop";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface AgentTalkAllEntriesResponse {
  readonly type: "agentTalkAllEntries";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly entries: readonly TalkEntry[];
}

export interface AgentTalksResponse {
  readonly type: "agentTalks";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly talks: readonly TalkSummary[];
}

export interface AgentTalkRenameResponse {
  readonly type: "agentTalkRename";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface AgentTalkDeleteResponse {
  readonly type: "agentTalkDelete";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface AgentTalkDeleteAllResponse {
  readonly type: "agentTalkDeleteAll";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly count: number;
}

export interface AgentUndoFeedbackResponse {
  readonly type: "agentUndoFeedback";
  readonly requestId: RequestId;
  readonly ok: true;
}

export interface AgentDraftFromPreparedResponse {
  readonly type: "agentDraftFromPrepared";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly draftId: string;
  /** The person already had a draft answering this thread; it is that one, unchanged. */
  readonly existing: boolean;
}

export interface AgentMatchActResponse {
  readonly type: "agentMatchAct";
  readonly requestId: RequestId;
  readonly ok: true;
  /** Newest first, at most the cap. */
  readonly messages: readonly ActMatch[];
  /** More may match than these: too many to act on from the offer. */
  readonly capped: boolean;
}

export interface AgentPromptCountResponse {
  readonly type: "agentPromptCount";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly count: PromptCount;
}

export interface AgentPromptVerdictsResponse {
  readonly type: "agentPromptVerdicts";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly list: PromptList;
}

export interface AgentPromptBadgeResponse {
  readonly type: "agentPromptBadge";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly badge: PromptBadge;
}

export interface AgentPromptRunResponse {
  readonly type: "agentPromptRun";
  readonly requestId: RequestId;
  readonly ok: true;
  readonly result: PromptRunResult;
}

export interface AgentPromptStopResponse {
  readonly type: "agentPromptStop";
  readonly requestId: RequestId;
  readonly ok: true;
}

export type BackendResponse =
  | AgentStatusResponse
  | AgentPromptCountResponse
  | AgentPromptVerdictsResponse
  | AgentPromptBadgeResponse
  | AgentPromptRunResponse
  | AgentPromptStopResponse
  | AgentThreadResponse
  | AgentJournalResponse
  | AgentRulesResponse
  | AgentInstructionsResponse
  | AgentRememberResponse
  | AgentAddInstructionResponse
  | AgentRemoveInstructionResponse
  | AgentRuleOfferResponse
  | AgentAddRuleResponse
  | AgentRemoveRuleResponse
  | AgentPrepareResponse
  | AgentTalkResponse
  | AgentRewriteDraftResponse
  | AgentAnswerQuestionsResponse
  | AgentCheckReplyResponse
  | AgentFillGapsResponse
  | AgentTalkStopResponse
  | AgentTalkEntriesResponse
  | AgentTalkAllResponse
  | AgentTalkAllStopResponse
  | AgentTalkAllEntriesResponse
  | AgentTalksResponse
  | AgentTalkRenameResponse
  | AgentTalkDeleteResponse
  | AgentTalkDeleteAllResponse
  | AgentUndoFeedbackResponse
  | AgentDraftFromPreparedResponse
  | AgentMatchActResponse
  | FetchReceivedResponse
  | AddAttachmentsResponse
  | CheckAttachmentSourcesResponse
  | RecaptureAttachmentResponse
  | ListAttachmentsResponse
  | SetSeenResponse
  | MoveThreadResponse
  | UndoMoveResponse
  | DeleteForeverResponse
  | ListFoldersResponse
  | NotificationPrefsResponse
  | TestNotificationResponse
  | GetImageChoiceResponse
  | GetStorageResponse
  | MeasureStorageResponse
  | CompactStorageResponse
  | ClearFileTextResponse
  | ListImageRulesResponse
  | SetImageRuleResponse
  | RemoveImageRuleResponse
  | StopImagesResponse
  | SetGeneralImagesResponse
  | ImportImageAddressesResponse
  | SuggestPeopleResponse
  | SearchFilesResponse
  | ListViewsResponse
  | SaveViewResponse
  | DeleteViewResponse
  | MoveViewResponse
  | ListSearchesResponse
  | NoteSearchResponse
  | ForgetSearchResponse
  | ClearSearchesResponse
  | CountMatchesResponse
  | SortRankedResponse
  | PrepareResponse
  | GetDraftResponse
  | SaveDraftResponse
  | DeleteDraftResponse
  | RenderPreviewResponse
  | RequestSendResponse
  | UndoSendResponse
  | SendActionResponse
  | ListOutboxResponse
  | ListNewestResponse
  | OpenThreadResponse
  | SearchResponse
  | GetMessagesResponse
  | GetMessageHtmlResponse
  | ListLabelsResponse
  | DiscoverServersResponse
  | ListAccountsResponse
  | AddAccountResponse
  | RemoveAccountResponse
  | SyncNowResponse
  | ChangePasswordResponse
  | ErrorResponse;

/** Pushed by the backend after the store changed; the renderer refetches what it shows. */
export interface ChangesEvent {
  readonly type: "changes";
  readonly changeSeq: number;
  readonly changedKeys: readonly number[];
  readonly removedKeys: readonly number[];
}

/** Sync state of one account, pushed whenever it changes. */
export interface SyncStatusEvent {
  readonly type: "syncStatus";
  readonly accountId: string;
  readonly status: SyncStatus;
}

/** An account was added or removed (by this window or another path). */
export interface AccountsChangedEvent {
  readonly type: "accountsChanged";
}

/** The sends in progress changed; carries the whole list the UI shows (it is short). */
export interface OutboxEvent {
  readonly type: "outbox";
  readonly operations: readonly SendOperation[];
}

/**
 * An image rule or the general setting changed, from any window: an open message asks again
 * what is decided for its images (ADR 0037).
 */
export interface ImageRulesChangedEvent {
  readonly type: "imageRulesChanged";
}

/** The files of a draft changed (added, finished or failed): the whole list, in order. */
export interface AttachmentsEvent {
  readonly type: "attachments";
  readonly draftId: string;
  readonly attachments: readonly AttachmentInfo[];
}

/**
 * A file is this far into being copied. At most four a second per file, never stored and never a
 * change event (ADR 0041, rule 5).
 */
export interface AttachmentProgressEvent {
  readonly type: "attachmentProgress";
  readonly id: string;
  /** 0 to 1. */
  readonly fraction: number;
}

/** Bytes of a message handed to the server so far; throttled and not stored like the above. */
export interface SendProgressEvent {
  readonly type: "sendProgress";
  readonly operationId: string;
  readonly sentBytes: number;
  readonly totalBytes: number;
}

/** The outgoing server's limit of an account became known (or changed). */
export interface MessageLimitEvent {
  readonly type: "messageLimit";
  readonly accountId: string;
  readonly limitBytes: number | null;
}

/**
 * A received file is this far into being downloaded (ADR 0043, rule 7). At most four a second per
 * file, never stored and never a change event.
 */
export interface ReceivedProgressEvent {
  readonly type: "receivedProgress";
  readonly messageKey: number;
  readonly partId: string;
  readonly bytes: number;
  /** What the part is expected to be; never less than `bytes`. */
  readonly totalBytes: number;
}

/** One action in its undo window, as the tray shows it (ADR 0044, rule 10). */
export interface MoveSummary {
  readonly id: string;
  readonly action: MoveKind;
  /** The name of the folder, for a move to one. */
  readonly place?: string;
  /** Messages it holds. */
  readonly count: number;
  /** The window ends then; the line is gone by itself after. */
  readonly notBeforeMs: number;
}

/** The actions that can still be taken back. Pushed whenever the list changes; it is short. */
export interface MovesEvent {
  readonly type: "moves";
  readonly operations: readonly MoveSummary[];
}

/** The server turned a move or a deletion down for good, and the mail is back (ADR 0044, rule 15). */
export interface MoveRefusedEvent {
  readonly type: "moveRefused";
  readonly action: MoveKind;
  readonly count: number;
}

/**
 * What agents found or made changed (a reading, prepared work, a setting, progress): the page
 * asks again for what it shows. Carries no data.
 */
export interface AgentChangedEvent {
  readonly type: "agentChanged";
  /**
   * The status itself changed by a request (AI on or off, consent, a pause, a setting): a window
   * reads it now, however fresh its copy is (ADR 0115). Absent for a reading's many steps.
   */
  readonly status?: true;
}

/**
 * A turn across all mail (ADR 0064, rule 12) finished its search on this machine and is going on
 * to the answer. It carries what the code did and nothing from the mail: the query the model wrote
 * from the person's own words, and how many threads go to the runtime.
 */
export interface AgentTalkStepEvent {
  readonly type: "agentTalkStep";
  readonly query: string;
  readonly threads: number;
  /**
   * ADR 0080. "search": one query of the trail ran and found `threads` threads. "follow": a follow
   * turn decided what next, in `note`. Absent: the search is over and `threads` go to the answer.
   * ADR 0083, the loop with tools: "read": a thread the agent opened, written by the tool server
   * (`note` is its subject, sender and date); "note": a line the model wrote between its steps.
   * ADR 0102: "count": `count_mail` counted `query`, `threads` is the messages and `note` the count
   * as a line; "look": `list_views` or `mail_overview` ran, `note` says what it looked at.
   */
  readonly kind?: "search" | "follow" | "read" | "note" | "count" | "look";
  /** A line the model wrote after seeing summaries of mail, or what a step read: shown as text only. */
  readonly note?: string;
}

/**
 * New mail for the notices inside the window (ADR 0071, rule 7), newest first. The window shows
 * them only while it is in front, for `seconds` (0: until closed).
 */
export interface NoticesEvent {
  readonly type: "notices";
  readonly notices: readonly NoticeText[];
  readonly seconds: number;
}

/** The notification settings changed, from any window. */
export interface NotificationPrefsChangedEvent {
  readonly type: "notificationPrefsChanged";
  readonly prefs: NotificationPrefs;
}

/** The system refused the test banner; Settings says so with the reason it gave (ADR 0108). */
export interface NotificationTestFailedEvent {
  readonly type: "notificationTestFailed";
  readonly reason: string;
}

/**
 * How far a prompt is (ADR 0116, rule 9): the phase, each query the search ran with the threads
 * it listed, each batch read, and once when the run ends. Never stored: the page asks for the
 * verdicts again and the bar shows how far it is.
 */
export interface AgentPromptProgressEvent extends PromptProgress {
  readonly type: "agentPromptProgress";
}

/**
 * The saved views changed without a window asking (ADR 0117, rule 2: `Needs you` was added): the
 * windows read the list again.
 */
export interface ViewsChangedEvent {
  readonly type: "viewsChanged";
}

export type BackendEvent =
  | NoticesEvent
  | ViewsChangedEvent
  | AgentPromptProgressEvent
  | NotificationPrefsChangedEvent
  | NotificationTestFailedEvent
  | AgentChangedEvent
  | AgentTalkStepEvent
  | MovesEvent
  | MoveRefusedEvent
  | ReceivedProgressEvent
  | AttachmentsEvent
  | AttachmentProgressEvent
  | SendProgressEvent
  | MessageLimitEvent
  | ChangesEvent
  | SyncStatusEvent
  | AccountsChangedEvent
  | OutboxEvent
  | ImageRulesChangedEvent;

/** Everything the backend sends to the renderer. */
export type BackendMessage = BackendResponse | BackendEvent;

/**
 * What the page asks main to do with a received file (ADR 0043, rules 10 to 14). It names the file
 * by message key and part id and nothing else: there is no path in either direction.
 */
export type ReceivedAction = "open" | "preview" | "save" | "saveAll";

/** One file of a Save all. */
export interface ReceivedItem {
  readonly messageKey: number;
  readonly partId: string;
}

/**
 * How it ended. `gone`, `offline` and `failed` come from the download; `refused` is main
 * declining: `runnable` (Open on a file that can run programs), `quarantine` (Open when the file
 * could not be marked as from the internet), `unsupported` (Preview off macOS), `invalid` (a key
 * that names no file of the cache).
 */
export type ReceivedAnswer =
  | { readonly kind: "opened" }
  | { readonly kind: "previewed" }
  | { readonly kind: "saved"; readonly count: number; readonly skipped: number }
  | { readonly kind: "cancelled" }
  | { readonly kind: "gone" }
  | { readonly kind: "offline" }
  | { readonly kind: "failed" }
  | {
      readonly kind: "refused";
      readonly reason: "runnable" | "quarantine" | "unsupported" | "invalid";
    };

/**
 * What the router tells main on main's own line (ADR 0071, rule 8): banners to show and the text
 * of the badge. Main shows them and decides nothing but whether its window is in front.
 */
export type NoticeToMain =
  | {
      readonly type: "banners";
      readonly banners: readonly NoticeText[];
      readonly sound: boolean;
      /** Show them also while the mail window is in front. */
      readonly whenFront: boolean;
    }
  | { readonly type: "badge"; readonly text: string }
  /** Take back the banners of these messages: read, archived or deleted since (ADR 0108). */
  | { readonly type: "close"; readonly keys: readonly number[] }
  /** Whether banners are paused, for the app menu (ADR 0108); sent at start and on every change. */
  | { readonly type: "pause"; readonly enabled: boolean; readonly untilMs: number | null };
