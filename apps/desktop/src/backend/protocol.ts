// Messages between the router (backend main thread) and the sync worker. The router serves
// reads; the worker owns everything that writes or talks to a mail server.
import type {
  AccountInfo,
  AttachmentInfo,
  RemovalCompaction,
  SendAction,
  StorageSampleInfo,
} from "@matters/contracts";
import type {
  ActMatches,
  AddInstructionInput,
  AddRuleInput,
  AgentEfforts,
  AgentInstruction,
  AgentModels,
  AgentRule,
  AgentStatus,
  AgentWorkKind,
  DeleteForeverResult,
  Draft,
  DraftContent,
  DraftFor,
  FailureDetail,
  FetchOutcome,
  GapSuggestion,
  GeneralImages,
  ImageRule,
  ImageRuleDecision,
  ImageRuleScope,
  MoveKind,
  MoveThreadInput,
  MoveThreadResult,
  PrepareResult,
  PromptBadge,
  PromptCount,
  PromptList,
  PromptProgress,
  PromptRunResult,
  ReadingStatus,
  RememberResult,
  ReplyCheck,
  RewriteHow,
  SavedView,
  SendOperation,
  SetSeenResult,
  SortRanked,
  StoppableSource,
  SyncStatus,
  TalkChoice,
  TalkResult,
  ThemeInput,
  UndoMoveResult,
  UndoResult,
} from "@matters/core";
import type { NewAccountInput, PasswordChanged } from "./handler.ts";

/** Account changes: they write, so they run in the worker. */
export type WorkerCommand =
  /** With a password, or the handle of a browser sign-in main holds (ADR 0133, rule 6). */
  | ({ readonly name: "addAccount" } & NewAccountInput)
  | { readonly name: "removeAccount"; readonly accountId: string }
  | { readonly name: "setSeen"; readonly keys: readonly number[]; readonly seen: boolean }
  | ({ readonly name: "moveThread" } & MoveThreadInput)
  | { readonly name: "undoMove"; readonly operationId: string }
  | { readonly name: "deleteForever"; readonly keys: readonly number[] }
  | { readonly name: "syncNow"; readonly accountId: string }
  /** A new password, verified before it replaces the saved one (ADR 0113). */
  | { readonly name: "changePassword"; readonly accountId: string; readonly password: string }
  /** A new browser sign-in, verified before it replaces the stored one (ADR 0133, rule 11). */
  | { readonly name: "signInAgain"; readonly accountId: string; readonly signIn: string }
  /** The account's own signature (ADR 0142); empty takes it away. */
  | { readonly name: "setSignature"; readonly accountId: string; readonly signature: string }
  | { readonly name: "saveDraft"; readonly id?: string; readonly content: DraftContent }
  | { readonly name: "deleteDraft"; readonly draftId: string }
  | { readonly name: "requestSend"; readonly draftId: string }
  | { readonly name: "undoSend"; readonly operationId: string }
  | { readonly name: "sendAction"; readonly operationId: string; readonly action: SendAction }
  /**
   * The only place a path travels: the router turned each grant into one (ADR 0041, rule 3). It
   * goes to this worker and no further; nothing that comes back carries it.
   */
  | {
      readonly name: "addAttachments";
      readonly draftId: string;
      readonly files: readonly {
        readonly id: string;
        readonly name: string;
        readonly size: number;
        readonly sourcePath: string;
      }[];
    }
  /** Parts of received messages: names in the cache, not paths (ADR 0045). */
  | {
      readonly name: "addForwardedAttachments";
      readonly draftId: string;
      readonly files: readonly {
        readonly id: string;
        readonly messageKey: number;
        readonly partId: string;
      }[];
    }
  | { readonly name: "checkAttachmentSources"; readonly draftId: string }
  | { readonly name: "recaptureAttachment"; readonly draftId: string; readonly id: string }
  | { readonly name: "probeMessageLimit"; readonly accountId: string }
  | { readonly name: "fetchReceived"; readonly messageKey: number; readonly partId: string }
  | { readonly name: "createView"; readonly viewName: string; readonly query: string }
  | { readonly name: "updateViewQuery"; readonly id: string; readonly query: string }
  | { readonly name: "renameView"; readonly id: string; readonly viewName: string }
  | { readonly name: "deleteView"; readonly id: string }
  | { readonly name: "moveView"; readonly id: string; readonly toIndex: number }
  | { readonly name: "noteSearch"; readonly viewId: string; readonly query: string }
  | { readonly name: "forgetSearch"; readonly viewId: string; readonly query: string }
  | { readonly name: "clearSearches"; readonly viewId: string }
  | {
      readonly name: "setImageRule";
      readonly scope: ImageRuleScope;
      readonly value: string;
      readonly decision: ImageRuleDecision;
    }
  | { readonly name: "removeImageRule"; readonly scope: ImageRuleScope; readonly value: string }
  | { readonly name: "stopImages"; readonly address: string; readonly source: StoppableSource }
  | { readonly name: "setGeneralImages"; readonly general: GeneralImages }
  | { readonly name: "importImageAddresses"; readonly addresses: readonly string[] }
  /** Settings › Storage (ADR 0089): a measurement the read thread made, kept by the writer. */
  | { readonly name: "recordStorageSample"; readonly sample: StorageSampleInfo }
  | { readonly name: "compactDatabase" }
  /** Empties the text the agent read from attached files (ADR 0087, rule 11). */
  | { readonly name: "clearFileText" }
  /** Agents (ADR 0051): what runs a model or writes settings runs here. */
  | { readonly name: "agentStatus" }
  | {
      readonly name: "agentSetEnabled";
      readonly accountIds: readonly string[];
      readonly runtimeId: string;
    }
  | { readonly name: "agentDisable" }
  | {
      readonly name: "agentSetModels";
      readonly models: Partial<AgentModels>;
      readonly efforts?: Partial<AgentEfforts>;
    }
  | { readonly name: "agentSetWeekShare"; readonly percent: number }
  // The key goes to the worker, which hands it to main's vault; it is never logged (ADR 0141).
  | { readonly name: "agentSaveKey"; readonly runtimeId: string; readonly key: string }
  | { readonly name: "agentRemoveKey"; readonly runtimeId: string }
  | { readonly name: "agentSetKeyReading"; readonly runtimeId: string; readonly on: boolean }
  | { readonly name: "agentSetTalkLoop"; readonly on: boolean }
  | { readonly name: "agentInspect" }
  | { readonly name: "agentTestRuntime"; readonly runtimeId?: string }
  | { readonly name: "agentPauseReading" }
  | { readonly name: "agentResumeReading" }
  | {
      readonly name: "agentPrepare";
      readonly threadId: string;
      readonly direction?: string;
      readonly answer?: string;
    }
  | {
      readonly name: "agentTalk";
      readonly threadId: string;
      readonly words: string;
      readonly choice?: TalkChoice;
    }
  | { readonly name: "agentTalkStop"; readonly threadId: string }
  | { readonly name: "agentMakeTheme"; readonly input: ThemeInput }
  | { readonly name: "agentMakeThemeStop" }
  | ({
      readonly name: "agentRewriteDraft";
      readonly text: string;
      readonly how: RewriteHow;
    } & DraftFor)
  | ({
      readonly name: "agentWriteDraft";
      readonly subject: string;
      readonly text: string;
      readonly words: string;
    } & DraftFor)
  | {
      readonly name: "agentAnswerQuestions";
      readonly threadId: string;
      readonly text: string;
      readonly missing?: readonly string[];
    }
  | { readonly name: "agentCheckReply"; readonly threadId: string; readonly text: string }
  | { readonly name: "agentFillGaps"; readonly threadId: string; readonly text: string }
  | {
      readonly name: "agentTalkAll";
      readonly words: string;
      readonly talkId?: number;
      readonly choice?: TalkChoice;
    }
  | { readonly name: "agentTalkAllStop" }
  | { readonly name: "agentTalkRename"; readonly talkId: number; readonly title: string }
  | { readonly name: "agentTalkDelete"; readonly talkId: number }
  | { readonly name: "agentTalkDeleteAll" }
  | { readonly name: "agentRevokeConsent"; readonly accountId: string; readonly runtimeId?: string }
  | {
      readonly name: "agentSetKindRuntime";
      readonly kinds: readonly AgentWorkKind[];
      readonly runtimeId: string;
    }
  | {
      readonly name: "agentUndoFeedback";
      readonly threadId: string;
      readonly kind: "notImportant" | "later" | "closed";
    }
  | { readonly name: "agentRemember"; readonly threadId: string; readonly words: string }
  | { readonly name: "agentAddInstruction"; readonly input: AddInstructionInput }
  | { readonly name: "agentRemoveInstruction"; readonly id: number }
  | { readonly name: "agentAddRule"; readonly input: AddRuleInput }
  | { readonly name: "agentRemoveRule"; readonly ruleId: number }
  | { readonly name: "agentDraftFromPrepared"; readonly threadId: string; readonly body: string }
  /** Read-only: what the press of a clean-up acts on, matched as its count was (ADR 0102). */
  | { readonly name: "agentMatchAct"; readonly query: string }
  /**
   * A prompt is a filter (ADR 0116). The count and the verdicts read only, but they walk the index
   * like a count; the run sends mail to the runtime. All of it runs here, where the agent runs.
   */
  | { readonly name: "agentPromptCount"; readonly query: string }
  | { readonly name: "agentPromptVerdicts"; readonly query: string }
  /** Read-only, as the verdicts: the number on the tab of a view with a prompt (ADR 0117, rule 4). */
  | { readonly name: "agentPromptBadge"; readonly query: string }
  | {
      readonly name: "agentPromptRun";
      readonly query: string;
      readonly again?: boolean;
      readonly readAll?: boolean;
    }
  | { readonly name: "agentPromptStop" }
  | { readonly name: "agentReadingStatus"; readonly fresh?: boolean }
  /** Read-only, but it runs here: a count can take tens of ms and the router serves keystrokes. */
  | {
      readonly name: "countMatches";
      readonly query: string;
      readonly cap: number;
      readonly beforeKey?: number;
    }
  /** Read-only: a ranked order after `↵` (ADR 0116, rule 4b), over a bounded pool. */
  | { readonly name: "sortRanked"; readonly query: string };

/**
 * An account's removal: `removed` false when there is no such account; `compaction` what became of
 * the freed pages (ADR 0138, rule 6), absent where nothing compacts (tests).
 */
export interface RemovedAccount {
  readonly removed: boolean;
  readonly compaction?: RemovalCompaction;
}

export interface CommandResults {
  readonly addAccount: { readonly account: AccountInfo; readonly folderCount: number };
  readonly removeAccount: RemovedAccount;
  readonly setSeen: SetSeenResult;
  readonly moveThread: MoveThreadResult;
  readonly undoMove: UndoMoveResult;
  readonly deleteForever: DeleteForeverResult;
  readonly syncNow: boolean;
  /** Null when there is no such account. */
  readonly changePassword: PasswordChanged | null;
  readonly signInAgain: PasswordChanged | null;
  /** The signature as kept; null when there is no such account. */
  readonly setSignature: string | null;
  readonly saveDraft: Draft;
  readonly deleteDraft: boolean;
  readonly requestSend: SendOperation;
  readonly undoSend: UndoResult;
  readonly sendAction: boolean;
  readonly addAttachments: readonly AttachmentInfo[];
  readonly addForwardedAttachments: readonly AttachmentInfo[];
  readonly checkAttachmentSources: readonly string[];
  readonly recaptureAttachment: AttachmentInfo | null;
  readonly probeMessageLimit: number | null;
  readonly fetchReceived: FetchOutcome;
  readonly createView: SavedView;
  readonly updateViewQuery: SavedView;
  readonly renameView: SavedView;
  readonly deleteView: boolean;
  readonly moveView: null;
  readonly noteSearch: null;
  readonly forgetSearch: null;
  readonly clearSearches: null;
  readonly setImageRule: ImageRule;
  readonly removeImageRule: boolean;
  readonly stopImages: null;
  readonly setGeneralImages: null;
  readonly importImageAddresses: number;
  readonly recordStorageSample: null;
  readonly compactDatabase: { readonly freedBytes: number; readonly ms: number };
  readonly clearFileText: number;
  readonly countMatches: { readonly count: number; readonly nextBeforeKey?: number };
  readonly sortRanked: SortRanked;
  readonly agentStatus: AgentStatus;
  readonly agentSetEnabled: AgentStatus;
  readonly agentDisable: AgentStatus;
  readonly agentSetModels: AgentStatus;
  readonly agentSetWeekShare: AgentStatus;
  readonly agentSaveKey: AgentStatus;
  readonly agentRemoveKey: AgentStatus;
  readonly agentSetKeyReading: AgentStatus;
  readonly agentSetTalkLoop: AgentStatus;
  readonly agentInspect: AgentStatus;
  readonly agentTestRuntime: AgentStatus;
  readonly agentPauseReading: AgentStatus;
  readonly agentResumeReading: AgentStatus;
  readonly agentPrepare: PrepareResult;
  readonly agentTalk: TalkResult;
  readonly agentTalkStop: null;
  readonly agentMakeTheme: { readonly text: string };
  readonly agentMakeThemeStop: null;
  readonly agentRewriteDraft: { readonly text: string };
  readonly agentWriteDraft: { readonly text: string };
  readonly agentAnswerQuestions: { readonly text: string };
  readonly agentCheckReply: ReplyCheck;
  readonly agentFillGaps: readonly GapSuggestion[];
  readonly agentTalkAll: TalkResult;
  readonly agentTalkAllStop: null;
  readonly agentTalkRename: null;
  readonly agentTalkDelete: null;
  readonly agentTalkDeleteAll: number;
  readonly agentUndoFeedback: null;
  readonly agentRemember: RememberResult;
  readonly agentAddInstruction: AgentInstruction;
  readonly agentRemoveInstruction: null;
  readonly agentAddRule: AgentRule;
  readonly agentRemoveRule: null;
  readonly agentRevokeConsent: AgentStatus;
  readonly agentSetKindRuntime: AgentStatus;
  readonly agentDraftFromPrepared: { readonly draftId: string; readonly existing: boolean };
  readonly agentMatchAct: ActMatches;
  readonly agentPromptCount: PromptCount;
  readonly agentPromptVerdicts: PromptList;
  readonly agentPromptBadge: PromptBadge;
  readonly agentPromptRun: PromptRunResult;
  readonly agentPromptStop: null;
  readonly agentReadingStatus: ReadingStatus;
}

export type CommandResult<C extends WorkerCommand> = CommandResults[C["name"]];

/**
 * Enough of an error for the router to classify it again (`name` and `kind`, see handler.ts),
 * and what the adapter could tell about it (ADR 0114), so the screen can say why.
 */
export interface WireError {
  readonly name: string;
  readonly message: string;
  readonly kind?: string;
  readonly detail?: FailureDetail;
}

export type ToWorker =
  | { readonly type: "command"; readonly id: number; readonly command: WorkerCommand }
  /** A reply from the credential vault in main, relayed untouched by the router. */
  | { readonly type: "credentials"; readonly data: unknown }
  | { readonly type: "shutdown" };

export type FromWorker =
  | { readonly type: "ready"; readonly seeded: number; readonly ms: number }
  /** Updating the schema of an existing database: step `step` (from 1) of `total` (ADR 0103). */
  | { readonly type: "migrating"; readonly step: number; readonly total: number }
  | { readonly type: "result"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "result"; readonly id: number; readonly ok: false; readonly error: WireError }
  | { readonly type: "status"; readonly accountId: string; readonly status: SyncStatus }
  /** A batch is committed: the router reads what changed on its own connection. */
  | { readonly type: "committed" }
  /** A send changed state (committed): the router reads the list and tells the renderer. */
  | { readonly type: "outbox" }
  /** The moves waiting for their window or the server changed: the router reads and tells the renderer. */
  | { readonly type: "moves" }
  /** What agents found or made changed (committed): the router tells the renderer, which asks again. */
  | { readonly type: "agent" }
  /** The saved views changed here and not by a request (ADR 0117, rule 2): the windows read them. */
  | { readonly type: "views" }
  /**
   * A turn across all mail finished its search and goes on to the answer (ADR 0064, rule 12). Not
   * data: the query and a count, relayed as they are and never stored.
   */
  | {
      readonly type: "agentTalkStep";
      readonly query: string;
      readonly threads: number;
      readonly kind?: "search" | "follow" | "read" | "note" | "count" | "look";
      readonly note?: string;
    }
  /** How far a prompt is read (ADR 0116, rule 9): counts, relayed as they are and never stored. */
  | ({ readonly type: "agentPrompt" } & PromptProgress)
  /** The server turned down moves for good; the router tells the renderer, which says so in the tray. */
  | { readonly type: "moveRefused"; readonly action: MoveKind; readonly count: number }
  /** The files of a draft changed (committed): the router reads the list and tells the renderer. */
  | { readonly type: "attachments"; readonly draftId: string }
  /** Not data: throttled in the worker, relayed as it is and never stored (ADR 0041, rule 5). */
  | { readonly type: "attachmentProgress"; readonly id: string; readonly fraction: number }
  /** Not data either: throttled in the worker, relayed as it is and never stored (ADR 0043, rule 7). */
  | {
      readonly type: "receivedProgress";
      readonly messageKey: number;
      readonly partId: string;
      readonly bytes: number;
      readonly totalBytes: number;
    }
  | {
      readonly type: "sendProgress";
      readonly operationId: string;
      readonly sentBytes: number;
      readonly totalBytes: number;
    }
  /** The copies of these attachments ended, well or not: their grants are no longer needed. */
  | { readonly type: "captured"; readonly ids: readonly string[] }
  | {
      readonly type: "synced";
      readonly accountId: string;
      readonly scope: string;
      readonly documents: number;
      readonly durationMs: number;
    }
  /** A request to the credential vault in main, relayed untouched by the router. */
  | { readonly type: "credentials"; readonly data: unknown }
  | { readonly type: "stopped" };

/** The worker's end of the message channel; `worker_threads` or a test double implements it. */
export interface WorkerChannel {
  post(message: FromWorker): void;
  onMessage(handler: (message: ToWorker) => void): void;
}

/** What `workerData` carries into the worker. */
export interface WorkerConfig {
  readonly dbPath: string;
  readonly seed: boolean;
  /** One mail for each state of the image bar, in a demo run but not in the smoke. */
  readonly seedImages: boolean;
  /** JSON of the account the smoke driver pre-configures (see main/index.ts). */
  readonly testAccount: string | null;
  /** Where stored copies and built messages live, and the attachment worker's entry (ADR 0041). */
  readonly attachmentsDir: string;
  readonly spoolDir: string;
  readonly attachmentWorker: string;
  /** Where downloaded copies of received files live (ADR 0043, rule 6). */
  readonly receivedDir: string;
  /**
   * Window tests of a dev build only: a stand-in Graph service on this machine in place of
   * Microsoft's (ADR 0136, rule 12). The adapter refuses anything that is not loopback; main
   * passes it only in a dev build. Null: Microsoft Graph.
   */
  readonly graphBase?: string | null;
  /**
   * A stand-in for the Anthropic API in a dev build's window tests (ADR 0141, rule 11):
   * `http://127.0.0.1:<port>`, and the adapter takes nothing else. A release never has it.
   */
  readonly anthropicBase?: string | null;
}
