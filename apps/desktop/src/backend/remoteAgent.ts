import type {
  ActMatches,
  AddInstructionInput,
  AddRuleInput,
  AgentInstruction,
  AgentModels,
  AgentRule,
  AgentStatus,
  FeedbackOutcome,
  GapSuggestion,
  JournalEntry,
  PreparedGuidance,
  PreparedWork,
  PrepareResult,
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
import type { AgentApi, ReadEstimate } from "./agentApi.ts";
import {
  type AgentReadDeps,
  preparedFor,
  readInstructions,
  readJournal,
  readRuleOffer,
  readRules,
  readTalk,
  readTalkAll,
  readTalks,
} from "./agentReads.ts";
import type { HeavyAnswer, HeavyRead } from "./heavyReads.ts";
import type { SyncHost } from "./syncHost.ts";

/** Answers the reads that walk a lot of mail: the read thread, or a stand-in in a test. */
export interface HeavyReads {
  ask<R extends HeavyRead>(read: R): Promise<HeavyAnswer<R>>;
}

/**
 * Agents as the router serves them (ADR 0019, 0051 rule 10). What only reads a little (what was
 * prepared, the journal, the rules and the offer of a rule) is answered here on the reader connection,
 * and what walks a lot of mail (the list of things, what the agent has for a thread, the count for the
 * consent screen) on the read thread (ADR 0070, rule 2): opening the list never waits for a model or a
 * write, and no list of mail waits for the list of things. Everything that runs a model, writes, or
 * holds state of the service goes to the sync worker.
 */
export class RemoteAgent implements AgentApi {
  private readonly host: SyncHost;
  private readonly reads: AgentReadDeps;
  private readonly heavy: HeavyReads;
  private readonly onStatus: () => void;

  /**
   * `onStatus`: a request changed the status (its answer is the status after it), so every window
   * is told to read it now (ADR 0115). Said after the answer, when a read already sees the change.
   */
  constructor(host: SyncHost, reads: AgentReadDeps, heavy: HeavyReads, onStatus = () => {}) {
    this.host = host;
    this.reads = reads;
    this.heavy = heavy;
    this.onStatus = onStatus;
  }

  private async changed(work: Promise<AgentStatus>): Promise<AgentStatus> {
    const status = await work;
    this.onStatus();
    return status;
  }

  things(limit?: number) {
    return this.heavy.ask(limit === undefined ? { name: "things" } : { name: "things", limit });
  }

  prepared(threadId: string): Promise<PreparedWork | null> {
    return preparedFor(this.reads, threadId);
  }

  threadAgent(threadId: string): Promise<ThreadAgentView> {
    return this.heavy.ask({ name: "threadAgent", threadId });
  }

  readEstimate(input: {
    accountIds: readonly string[];
    windowDays: number;
  }): Promise<ReadEstimate> {
    return this.heavy.ask({ name: "readEstimate", input });
  }

  journal(limit?: number): Promise<readonly JournalEntry[]> {
    return readJournal(this.reads, limit);
  }

  rules(): Promise<readonly AgentRule[]> {
    return readRules(this.reads);
  }

  ruleOffer(threadId: string): Promise<RuleOffer | null> {
    return readRuleOffer(this.reads, threadId);
  }

  instructions(): Promise<readonly AgentInstruction[]> {
    return readInstructions(this.reads);
  }

  addInstruction(input: AddInstructionInput): Promise<AgentInstruction> {
    return this.host.command({ name: "agentAddInstruction", input });
  }

  async removeInstruction(id: number): Promise<void> {
    await this.host.command({ name: "agentRemoveInstruction", id });
  }

  /** Goes to the worker, which runs the turn there; nothing on the router waits for it. */
  remember(threadId: string, words: string): Promise<RememberResult> {
    return this.host.command({ name: "agentRemember", threadId, words });
  }

  addRule(input: AddRuleInput): Promise<AgentRule> {
    return this.host.command({ name: "agentAddRule", input });
  }

  async removeRule(id: number): Promise<void> {
    await this.host.command({ name: "agentRemoveRule", ruleId: id });
  }

  status(): Promise<AgentStatus> {
    return this.host.command({ name: "agentStatus" });
  }

  setEnabled(input: {
    accountIds: readonly string[];
    runtimeId: string;
    windowDays: number;
  }): Promise<AgentStatus> {
    return this.changed(this.host.command({ name: "agentSetEnabled", ...input }));
  }

  disable(): Promise<AgentStatus> {
    return this.changed(this.host.command({ name: "agentDisable" }));
  }

  revokeConsent(accountId: string): Promise<AgentStatus> {
    return this.changed(this.host.command({ name: "agentRevokeConsent", accountId }));
  }

  setModels(models: Partial<AgentModels>): Promise<AgentStatus> {
    return this.changed(this.host.command({ name: "agentSetModels", models }));
  }

  setWeekShare(percent: number): Promise<AgentStatus> {
    return this.changed(this.host.command({ name: "agentSetWeekShare", percent }));
  }

  setTalkLoop(on: boolean): Promise<AgentStatus> {
    return this.changed(this.host.command({ name: "agentSetTalkLoop", on }));
  }

  setWindowDays(days: number): Promise<AgentStatus> {
    return this.changed(this.host.command({ name: "agentSetWindowDays", days }));
  }

  inspect(): Promise<AgentStatus> {
    return this.changed(this.host.command({ name: "agentInspect" }));
  }

  pauseReading(): Promise<AgentStatus> {
    return this.changed(this.host.command({ name: "agentPauseReading" }));
  }

  resumeReading(): Promise<AgentStatus> {
    return this.changed(this.host.command({ name: "agentResumeReading" }));
  }

  testRuntime(): Promise<AgentStatus> {
    return this.changed(this.host.command({ name: "agentTestRuntime" }));
  }

  prepare(threadId: string, guidance?: PreparedGuidance): Promise<PrepareResult> {
    return this.host.command({
      name: "agentPrepare",
      threadId,
      ...(guidance?.direction === undefined ? {} : { direction: guidance.direction }),
      ...(guidance?.answer === undefined ? {} : { answer: guidance.answer }),
    });
  }

  talk(threadId: string, words: string): Promise<TalkResult> {
    return this.host.command({ name: "agentTalk", threadId, words });
  }

  rewriteDraft(threadId: string, text: string, how: RewriteHow): Promise<{ text: string }> {
    return this.host.command({ name: "agentRewriteDraft", threadId, text, how });
  }

  answerQuestions(
    threadId: string,
    text: string,
    missing: readonly string[] = [],
  ): Promise<{ text: string }> {
    return this.host.command({
      name: "agentAnswerQuestions",
      threadId,
      text,
      ...(missing.length === 0 ? {} : { missing }),
    });
  }

  checkReply(threadId: string, text: string): Promise<ReplyCheck> {
    return this.host.command({ name: "agentCheckReply", threadId, text });
  }

  fillGaps(threadId: string, text: string): Promise<readonly GapSuggestion[]> {
    return this.host.command({ name: "agentFillGaps", threadId, text });
  }

  async talkStop(threadId: string): Promise<void> {
    await this.host.command({ name: "agentTalkStop", threadId });
  }

  talkEntries(threadId: string): Promise<readonly TalkEntry[]> {
    return readTalk(this.reads, threadId);
  }

  talkAll(words: string, talkId?: number | null): Promise<TalkResult> {
    return this.host.command({
      name: "agentTalkAll",
      words,
      ...(typeof talkId === "number" ? { talkId } : {}),
    });
  }

  async talkAllStop(): Promise<void> {
    await this.host.command({ name: "agentTalkAllStop" });
  }

  talkAllEntries(talkId?: number, beforeId?: number): Promise<readonly TalkEntry[]> {
    return readTalkAll(this.reads, talkId, beforeId);
  }

  talks(): Promise<readonly TalkSummary[]> {
    return readTalks(this.reads);
  }

  async renameTalk(talkId: number, title: string): Promise<void> {
    await this.host.command({ name: "agentTalkRename", talkId, title });
  }

  async deleteTalk(talkId: number): Promise<void> {
    await this.host.command({ name: "agentTalkDelete", talkId });
  }

  deleteAllTalks(): Promise<number> {
    return this.host.command({ name: "agentTalkDeleteAll" });
  }

  feedback(
    threadId: string,
    kind: "notImportant" | "later" | "closed",
    outcome?: FeedbackOutcome,
  ): Promise<number> {
    return this.host.command({
      name: "agentFeedback",
      threadId,
      kind,
      ...(outcome === undefined ? {} : { outcome }),
    });
  }

  async undoFeedback(threadId: string, kind: "notImportant" | "later" | "closed"): Promise<void> {
    await this.host.command({ name: "agentUndoFeedback", threadId, kind });
  }

  /** Read-only, but on the worker: it walks the index like a count (ADR 0116, rule 4). */
  promptCount(query: string): Promise<PromptCount> {
    return this.host.command({ name: "agentPromptCount", query });
  }

  /** Read-only, on the worker for the same reason; it never waits for a model (ADR 0051, rule 10). */
  promptVerdicts(query: string): Promise<PromptList> {
    return this.host.command({ name: "agentPromptVerdicts", query });
  }

  /** Goes to the worker, which searches and reads there; progress comes back as pushes. */
  promptRun(query: string, again?: boolean, readAll?: boolean): Promise<PromptRunResult> {
    return this.host.command({
      name: "agentPromptRun",
      query,
      ...(again ? { again } : {}),
      ...(readAll ? { readAll } : {}),
    });
  }

  async promptStop(): Promise<void> {
    await this.host.command({ name: "agentPromptStop" });
  }

  /** Read-only, but on the worker: it walks the index like a count (ADR 0102). */
  matchAct(query: string): Promise<ActMatches> {
    return this.host.command({ name: "agentMatchAct", query });
  }

  draftFromPrepared(
    threadId: string,
    body: string,
  ): Promise<{ draftId: string; existing: boolean }> {
    return this.host.command({ name: "agentDraftFromPrepared", threadId, body });
  }
}
