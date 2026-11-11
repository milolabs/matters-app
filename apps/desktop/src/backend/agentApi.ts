import type {
  ActMatches,
  AddInstructionInput,
  AddRuleInput,
  AgentInstruction,
  AgentModels,
  AgentRule,
  AgentStatus,
  GapSuggestion,
  JournalEntry,
  PreparedGuidance,
  PrepareResult,
  PromptBadge,
  PromptCount,
  PromptList,
  PromptRunResult,
  RememberResult,
  ReplyCheck,
  RewriteHow,
  RuleOffer,
  TalkEntry,
  TalkResult,
  TalkSummary,
  ThreadAgentView,
} from "@matters/core";

/** Why an agent request could not be done. The message is for the person and holds no mail text. */
export class AgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

/** There is no such thread, or the agent may not read it. */
export class ThingNotFoundError extends Error {
  constructor(message = "That thread is not there") {
    super(message);
    this.name = "ThingNotFoundError";
  }
}

/** A choice the service refuses (an unknown model, a share that makes no sense). */
export class InvalidAgentSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentSettingError";
  }
}

/**
 * What the renderer can ask of agents (ADR 0051). `AgentService` implements it in the sync
 * worker; the router's `RemoteAgent` answers the reads itself on the reader connection and sends
 * the rest to the worker. There is no method that sends mail: `draftFromPrepared` makes a draft,
 * and the person sends it by the existing path.
 */
export interface AgentApi {
  status(): Promise<AgentStatus>;
  /**
   * What the agent already has for one ordinary thread (ADR 0063): the work prepared for it on
   * request, as it stands. Local only: no model, no worker.
   */
  threadAgent(threadId: string): Promise<ThreadAgentView>;
  /** What the agent and the person did, newest first (ADR 0054, rule 6): 50 by default, at most 200. Local only. */
  journal(limit?: number): Promise<readonly JournalEntry[]>;
  /** The active rules, in the order they were added (ADR 0054, rule 7). Local only. */
  rules(): Promise<readonly AgentRule[]>;
  /** What the tray offers after a closing: a rule for the thread's sender, or null. Local only. */
  ruleOffer(threadId: string): Promise<RuleOffer | null>;
  /**
   * Adds a rule as the person, and writes its journal line. Refuses an invalid subject, and the
   * person's own address. Adding an active rule again returns it and changes nothing.
   */
  addRule(input: AddRuleInput): Promise<AgentRule>;
  /** Removes the rule; what it hid shows again, and what it kept from reading is read. */
  removeRule(id: number): Promise<void>;
  /** The active instructions for the model, oldest first, a thread's included (ADR 0054). Local only. */
  instructions(): Promise<readonly AgentInstruction[]>;
  /**
   * Keeps an instruction the person typed in Settings. Refuses a blank or over-long text with a
   * sentence. It runs no turn. Adding an active one again returns it.
   */
  addInstruction(input: AddInstructionInput): Promise<AgentInstruction>;
  /** Removes the instruction; the next turns no longer carry it. */
  removeInstruction(id: number): Promise<void>;
  /**
   * What to keep from the words the person typed about a thread (ADR 0054, rules 7 and 8). One
   * background turn that gets the words and nothing else. Empty, and no turn, when the words are
   * blank, AI is off, the account has no consent or the plan has no room; a failed turn or an answer
   * that is not accepted is empty too, never an error.
   */
  remember(threadId: string, words: string): Promise<RememberResult>;
  /** Records the person's consent for these accounts and this runtime, and turns AI on. */
  setEnabled(input: { accountIds: readonly string[]; runtimeId: string }): Promise<AgentStatus>;
  /** Turns AI off and takes every consent back. */
  disable(): Promise<AgentStatus>;
  /** Takes back the consent for one account; AI stays on for the others. */
  revokeConsent(accountId: string): Promise<AgentStatus>;
  setModels(models: Partial<AgentModels>): Promise<AgentStatus>;
  setWeekShare(percent: number): Promise<AgentStatus>;
  /** The agent searches in a loop with tools instead of the plan and follow turns (ADR 0083). */
  setTalkLoop(on: boolean): Promise<AgentStatus>;
  /** Looks at the runtime again; spends nothing and sends no mail. */
  inspect(): Promise<AgentStatus>;
  /** The person stops the reading in the background; it stays stopped across restarts (ADR 0117). */
  pauseReading(): Promise<AgentStatus>;
  resumeReading(): Promise<AgentStatus>;
  /** The test with a made-up message (ADR 0051, rule 5). */
  testRuntime(): Promise<AgentStatus>;
  /** `P0`: the person asked for it. */
  prepare(threadId: string, guidance?: PreparedGuidance): Promise<PrepareResult>;
  /**
   * The person talks about one thread (ADR 0064, rule 6): one `P0` turn with the thread and its
   * talk, on the model for writing. The answer is text, a draft, a question or a closing. Refused
   * with a sentence and no turn when the words are blank, and when a turn for the thread is already
   * running. A turn that fails, is stopped or gives an answer the code does not accept stores
   * nothing, not even the words; the person tries again. May take a while.
   */
  talk(threadId: string, words: string): Promise<TalkResult>;
  /**
   * The agent helps write a reply (ADR 0098). Each is one `P0` turn for the thread, with the gates
   * of `prepare`: AI on, the thread there, its account agreed, the runtime ready, room in the plan.
   * `text` is the composer's whole Markdown body; the quote below the person's lines never goes to
   * the model for a rewrite and comes back as it was. Every gap in square brackets is kept. None of
   * these sends mail or changes a stored draft. An answer the code does not accept is an
   * `AgentUnavailableError` with a sentence for the person, never a crash.
   */
  rewriteDraft(threadId: string, text: string, how: RewriteHow): Promise<{ text: string }>;
  /** Short answers for what the other side's last message asked and the draft does not answer. */
  answerQuestions(
    threadId: string,
    text: string,
    missing?: readonly string[],
  ): Promise<{ text: string }>;
  /** What the draft answers of what the other side's last message asked. A small, cheap turn. */
  checkReply(threadId: string, text: string): Promise<ReplyCheck>;
  /** Values found in the thread for the gaps of the person's lines; gaps with none are left out. */
  fillGaps(threadId: string, text: string): Promise<readonly GapSuggestion[]>;
  /** Cuts the running talk turn of the thread short; it stores nothing. No turn running: nothing. */
  talkStop(threadId: string): Promise<void>;
  /** The newest 200 entries of the thread's talk, oldest first. Local only; empty while AI is off. */
  talkEntries(threadId: string): Promise<readonly TalkEntry[]>;
  /**
   * The person asks across all their mail (ADR 0064, rule 7): one turn from their point of view,
   * two for the model. The first turn gets only the person's own words and writes a search; the
   * code runs it on this machine over the accounts with consent; the second gets the threads found
   * and answers. Refused with a sentence and no turn when the words are blank and when another
   * turn across all mail is running. Nothing found, an unusable search, a failed or stopped turn,
   * and an answer the code does not accept: the first ends with an answer that says so and sends no
   * mail; the others store nothing, not even the words. The turn is asked in the talk `talkId`
   * (ADR 0086); `null`, absent or a talk that is gone starts a new talk, which the result names.
   */
  talkAll(words: string, talkId?: number | null): Promise<TalkResult>;
  /** Cuts the running turn across all mail short, at either of its two turns. */
  talkAllStop(): Promise<void>;
  /**
   * A prompt in the query bar (ADR 0116, rule 4): whether its search with the mail filters of
   * `query` ran, how many threads the kept search finds now, and how many of them have a verdict.
   * No model. While AI is off, or no account has consent, `ai` is `off` and nothing is counted
   * (rule 11). A query with no prompt is refused with a sentence.
   */
  promptCount(query: string): Promise<PromptCount>;
  /** The verdicts kept for the prompt of `query`, as the list shows them (rule 7). No model. */
  promptVerdicts(query: string): Promise<PromptList>;
  /**
   * The number on the tab of a saved view with a prompt (ADR 0117, rule 4): the unread threads
   * among those it shows, from stored verdicts. No model; none for a view never run.
   */
  promptBadge(query: string): Promise<PromptBadge>;
  /**
   * Runs the prompt of `query` (rule 3): the agent's search first when none is kept or `again`
   * asks for a new one (rule 4), then the threads found with no verdict yet, in `P0` batches, each
   * kept as it returns (rule 9); progress is pushed as it goes. One run at a time. Stopped or cut
   * short by the plan, it keeps what finished and says so. More than `PROMPT_ASK_ABOVE` threads to
   * read wait for `readAll` (rule 4): without it the run ends with `ask` and reads nothing.
   */
  promptRun(query: string, again?: boolean, readAll?: boolean): Promise<PromptRunResult>;
  /** Cuts the running prompt short: a search keeps nothing, a reading its finished batches. */
  promptStop(): Promise<void>;
  /**
   * The newest 200 entries of a talk across all mail, oldest first (ADR 0086): of `talkId`, or of
   * every talk without it; with `beforeId`, the 200 before that entry. Local only; empty while AI
   * is off.
   */
  talkAllEntries(talkId?: number, beforeId?: number): Promise<readonly TalkEntry[]>;
  /** The talks across all mail that have entries, the latest first (ADR 0086, rule 5). Local only. */
  talks(): Promise<readonly TalkSummary[]>;
  /** The person names a talk (rule 9); a blank name gives it back its first question. */
  renameTalk(talkId: number, title: string): Promise<void>;
  /** Removes one talk and its entries (rule 10), stopping a turn running in it first. */
  deleteTalk(talkId: number): Promise<void>;
  /** Removes every talk across all mail (rule 11), stopping a running turn; returns how many. */
  deleteAllTalks(): Promise<number>;
  /**
   * The person pressed Undo: the newest closing of the thread is forgotten. `notImportant` and
   * `later` undo lines of the journal kept from earlier versions.
   */
  undoFeedback(threadId: string, kind: "notImportant" | "later" | "closed"): Promise<void>;
  /**
   * What the press of a clean-up offer acts on (ADR 0102, rule 7): the query matched in the scope
   * its count was made in, the accounts agreed to and without the threads the rules cover, up to
   * the cap. Read-only: keys, threads, accounts, subjects and seen flags, no text.
   */
  matchAct(query: string): Promise<ActMatches>;
  /** A reply draft with this body, by the reply rules; the person sends it themselves. */
  draftFromPrepared(
    threadId: string,
    body: string,
  ): Promise<{ draftId: string; existing: boolean }>;
}
