import type {
  AgentConsent,
  AgentInsightStorePort,
  AgentInstruction,
  AgentInstructionInput,
  AgentRule,
  AgentRuleInput,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentRuntimePort,
  AgentRuntimeRecord,
  AgentSettings,
  AgentSettingsPort,
  JournalEntry,
  JournalMemo,
  LedgerEntry,
  NewTalkEntry,
  PlanLimits,
  PreparedRecord,
  PromptSearch,
  PromptVerdict,
  TalkEntry,
  TalkSummary,
  TalkTitleBy,
  ThingEdge,
  ThingFeedback,
  ThreadAnalysis,
} from "@matters/core";
import { cutTitle, DEFAULT_AGENT_SETTINGS } from "@matters/core";

type Step =
  | AgentRunResult
  | Error
  | ((request: AgentRunRequest) => AgentRunResult | Promise<AgentRunResult>);

/**
 * A runtime that answers from a script, one step per `run`. A step is a result, an error to
 * reject with, or a function of the request. Running out of steps rejects, so a test cannot
 * silently depend on a call it did not plan.
 */
export class FakeAgentRuntime implements AgentRuntimePort {
  readonly id: string;
  readonly name: string;
  /** Every request seen, in order. */
  readonly calls: AgentRunRequest[] = [];
  info: AgentRuntimeInfo;
  private steps: Step[] = [];

  constructor(options: { id?: string; name?: string; info?: Partial<AgentRuntimeInfo> } = {}) {
    this.id = options.id ?? "fake";
    this.name = options.name ?? "Fake runtime";
    this.info = {
      id: this.id,
      name: this.name,
      status: "ready",
      models: ["small", "large"],
      ...options.info,
    };
  }

  /** Queues steps for the next runs. */
  script(...steps: Step[]): this {
    this.steps.push(...steps);
    return this;
  }

  async inspect(): Promise<AgentRuntimeInfo> {
    return this.info;
  }

  async run(request: AgentRunRequest, options?: { signal?: AbortSignal }): Promise<AgentRunResult> {
    this.calls.push(request);
    if (options?.signal?.aborted) throw new Error("aborted");
    const step = this.steps.shift();
    if (step === undefined) throw new Error("FakeAgentRuntime: no step scripted");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(request) : step;
  }
}

const same = (a: { threadId: string; lastMessageKey: number }, b: typeof a) =>
  a.threadId === b.threadId && a.lastMessageKey === b.lastMessageKey;

function publicRule(r: AgentRule & { removed?: true }): AgentRule {
  const { removed: _removed, ...rule } = r;
  return rule;
}

function publicInstruction(i: AgentInstruction & { removed?: true }): AgentInstruction {
  const { removed: _removed, ...instruction } = i;
  return instruction;
}

export class InMemoryAgentInsightStore implements AgentInsightStorePort {
  private analyses: ThreadAnalysis[] = [];
  private prepared: PreparedRecord[] = [];
  private feedback: ThingFeedback[] = [];
  private ledger: LedgerEntry[] = [];
  private journal: JournalEntry[] = [];
  private nextJournalId = 1;
  private rules: (AgentRule & { removed?: true })[] = [];
  private nextRuleId = 1;
  private instructions: (AgentInstruction & { removed?: true })[] = [];
  private nextInstructionId = 1;
  private talk: TalkEntry[] = [];
  private nextTalkId = 1;
  private talks: {
    id: number;
    startedAtMs: number;
    lastAtMs: number;
    title?: string;
    titleBy?: TalkTitleBy;
  }[] = [];
  private nextTalksId = 1;
  private verdicts: PromptVerdict[] = [];
  private searches: PromptSearch[] = [];

  async putPromptSearch(search: PromptSearch): Promise<void> {
    this.searches = this.searches.filter(
      (o) => !(o.promptKey === search.promptKey && o.filters === search.filters),
    );
    this.searches.push({
      ...search,
      queries: [...search.queries],
      threadIds: [...search.threadIds],
    });
  }

  async getPromptSearch(promptKey: string, filters: string): Promise<PromptSearch | null> {
    const found = this.searches.find((o) => o.promptKey === promptKey && o.filters === filters);
    return found === undefined
      ? null
      : { ...found, queries: [...found.queries], threadIds: [...found.threadIds] };
  }

  async putPromptVerdicts(verdicts: readonly PromptVerdict[]): Promise<void> {
    for (const v of verdicts) {
      this.verdicts = this.verdicts.filter(
        (o) => !(o.promptKey === v.promptKey && o.threadId === v.threadId),
      );
      this.verdicts.push({ ...v });
    }
  }

  async getPromptVerdicts(
    promptKey: string,
    version: number,
    threads: readonly { readonly threadId: string; readonly lastMessageKey: number }[],
  ): Promise<readonly PromptVerdict[]> {
    const at = new Map(threads.map((t) => [t.threadId, t.lastMessageKey]));
    return this.verdicts
      .filter(
        (v) =>
          v.promptKey === promptKey &&
          v.version === version &&
          at.get(v.threadId) === v.lastMessageKey,
      )
      .map((v) => ({ ...v }));
  }

  async prunePromptVerdicts(keep: readonly string[], beforeMs: number): Promise<number> {
    const newest = new Map<string, number>();
    for (const v of this.verdicts) {
      newest.set(v.promptKey, Math.max(newest.get(v.promptKey) ?? -Infinity, v.atMs));
    }
    const kept = new Set(keep);
    const before = this.verdicts.length;
    this.verdicts = this.verdicts.filter(
      (v) => kept.has(v.promptKey) || (newest.get(v.promptKey) ?? 0) >= beforeMs,
    );
    const judged = new Set(this.verdicts.map((v) => v.promptKey));
    this.searches = this.searches.filter(
      (o) => kept.has(o.promptKey) || o.atMs >= beforeMs || judged.has(o.promptKey),
    );
    return before - this.verdicts.length;
  }

  async getAnalysis(threadId: string, lastMessageKey: number, analyzerVersion: number) {
    return (
      this.analyses.find(
        (a) =>
          a.threadId === threadId &&
          a.lastMessageKey === lastMessageKey &&
          a.analyzerVersion === analyzerVersion,
      ) ?? null
    );
  }

  private bundleReads = new Map<string, readonly ThingEdge[]>();

  async getBundleRead(signature: string): Promise<readonly ThingEdge[] | null> {
    return this.bundleReads.get(signature) ?? null;
  }

  async putBundleRead(signature: string, edges: readonly ThingEdge[]): Promise<void> {
    this.bundleReads.set(signature, edges);
  }

  async putAnalysis(analyses: readonly ThreadAnalysis[]): Promise<void> {
    for (const a of analyses) {
      this.analyses = this.analyses.filter(
        (x) => !(same(x, a) && x.analyzerVersion === a.analyzerVersion),
      );
      this.analyses.push(a);
    }
  }

  async listAnalyses(analyzerVersion: number, threadIds?: readonly string[]) {
    const wanted = threadIds === undefined ? undefined : new Set(threadIds);
    const latest = new Map<string, ThreadAnalysis>();
    for (const a of this.analyses) {
      if (a.analyzerVersion !== analyzerVersion) continue;
      if (wanted !== undefined && !wanted.has(a.threadId)) continue;
      const seen = latest.get(a.threadId);
      if (seen === undefined || a.lastMessageKey > seen.lastMessageKey) latest.set(a.threadId, a);
    }
    return [...latest.values()];
  }

  async putPrepared(records: readonly PreparedRecord[]): Promise<void> {
    for (const r of records) {
      this.prepared = this.prepared.filter((x) => !same(x, r));
      this.prepared.push(r);
    }
  }

  async getPrepared(threadId: string, lastMessageKey: number) {
    return (
      this.prepared.find((p) => p.threadId === threadId && p.lastMessageKey === lastMessageKey) ??
      null
    );
  }

  async recordFeedback(feedback: ThingFeedback, memo?: JournalMemo): Promise<void> {
    this.feedback.push(feedback);
    this.journal.push({
      id: this.nextJournalId++,
      atMs: feedback.atMs,
      action: feedback.kind,
      actor: memo?.actor ?? "person",
      threadId: feedback.threadId,
      lastMessageKey: feedback.lastMessageKey,
      senderAddress: feedback.senderAddress,
      ...(memo?.headline === undefined ? {} : { headline: memo.headline }),
      ...(memo?.words === undefined ? {} : { words: memo.words }),
      ...(feedback.reason === undefined ? {} : { reason: feedback.reason }),
      ...(feedback.untilMs === undefined ? {} : { untilMs: feedback.untilMs }),
      ...(memo?.alsoCovers === undefined ? {} : { alsoCovers: memo.alsoCovers }),
    });
  }

  async listFeedback() {
    return [...this.feedback];
  }

  async withdrawFeedback(
    threadId: string,
    kind: ThingFeedback["kind"],
    atMs: number = Date.now(),
  ): Promise<void> {
    const at = this.feedback.findLastIndex((f) => f.threadId === threadId && f.kind === kind);
    if (at >= 0) this.feedback.splice(at, 1);
    const line = this.journal.findLastIndex(
      (j) => j.action === kind && j.threadId === threadId && j.undoneAtMs === undefined,
    );
    const entry = this.journal[line];
    if (entry !== undefined) this.journal[line] = { ...entry, undoneAtMs: atMs };
  }

  async addRule(input: AgentRuleInput, atMs: number): Promise<AgentRule> {
    const active = this.rules.find(
      (r) => r.removed !== true && r.scope === input.scope && r.subject === input.subject,
    );
    if (active !== undefined) return publicRule(active);
    const rule: AgentRule = {
      id: this.nextRuleId++,
      scope: input.scope,
      subject: input.subject,
      action: input.action,
      actor: input.actor,
      atMs,
      ...(input.words === undefined ? {} : { words: input.words }),
    };
    this.rules.push(rule);
    this.journal.push({
      id: this.nextJournalId++,
      atMs,
      action: "ruleAdded",
      actor: input.actor,
      ruleId: rule.id,
      scope: rule.scope,
      subject: rule.subject,
      ...(input.words === undefined ? {} : { words: input.words }),
    });
    return rule;
  }

  async removeRule(id: number, atMs: number): Promise<void> {
    const at = this.rules.findIndex((r) => r.id === id && r.removed !== true);
    const rule = this.rules[at];
    if (rule !== undefined) this.rules[at] = { ...rule, removed: true };
    this.journal = this.journal.map((j) =>
      j.action === "ruleAdded" && j.ruleId === id && j.undoneAtMs === undefined
        ? { ...j, undoneAtMs: atMs }
        : j,
    );
  }

  async listRules() {
    return this.rules.filter((r) => r.removed !== true).map(publicRule);
  }

  async addInstruction(input: AgentInstructionInput, atMs: number): Promise<AgentInstruction> {
    const threadId = input.scope === "thread" ? input.threadId : undefined;
    const active = this.instructions.find(
      (i) =>
        i.removed !== true &&
        i.scope === input.scope &&
        i.threadId === threadId &&
        i.text === input.text,
    );
    if (active !== undefined) return publicInstruction(active);
    const instruction: AgentInstruction = {
      id: this.nextInstructionId++,
      scope: input.scope,
      text: input.text,
      ...(threadId === undefined ? {} : { threadId }),
      actor: input.actor,
      ...(input.words === undefined ? {} : { words: input.words }),
      atMs,
    };
    this.instructions.push(instruction);
    this.journal.push({
      id: this.nextJournalId++,
      atMs,
      action: "instructionAdded",
      actor: input.actor,
      instructionId: instruction.id,
      scope: instruction.scope,
      text: instruction.text,
      ...(threadId === undefined ? {} : { threadId }),
      ...(input.words === undefined ? {} : { words: input.words }),
    });
    return instruction;
  }

  async removeInstruction(id: number, atMs: number): Promise<void> {
    const at = this.instructions.findIndex((i) => i.id === id && i.removed !== true);
    const instruction = this.instructions[at];
    if (instruction !== undefined) this.instructions[at] = { ...instruction, removed: true };
    this.journal = this.journal.map((j) =>
      j.action === "instructionAdded" && j.instructionId === id && j.undoneAtMs === undefined
        ? { ...j, undoneAtMs: atMs }
        : j,
    );
  }

  async listInstructions() {
    return this.instructions.filter((i) => i.removed !== true).map(publicInstruction);
  }

  async listJournal(limit: number) {
    return [...this.journal].reverse().slice(0, Math.max(0, Math.trunc(limit)));
  }

  async appendLedger(entries: readonly LedgerEntry[]): Promise<void> {
    this.ledger.push(...entries);
  }

  async appendTalk(entries: readonly NewTalkEntry[]): Promise<readonly TalkEntry[]> {
    const added = entries.map((e) => {
      // A thread's entries have no talk of their own; the store drops one given by mistake.
      const { talkId, ...rest } = e;
      const own = e.threadId === null && talkId !== undefined ? { talkId } : {};
      if (e.threadId === null && talkId !== undefined) {
        const talk = this.talks.find((t) => t.id === talkId);
        if (talk !== undefined) talk.lastAtMs = Math.max(talk.lastAtMs, e.atMs);
      }
      return { ...rest, ...own, id: this.nextTalkId++ } as TalkEntry;
    });
    this.talk.push(...added);
    return added;
  }

  async listTalk(
    threadId: string | null,
    limit: number,
    options?: { readonly talkId?: number; readonly beforeId?: number },
  ): Promise<readonly TalkEntry[]> {
    const n = Math.max(0, Math.trunc(limit));
    const before = options?.beforeId ?? Number.MAX_SAFE_INTEGER;
    const talkId = threadId === null ? options?.talkId : undefined;
    return n === 0
      ? []
      : this.talk
          .filter(
            (t) =>
              t.threadId === threadId &&
              t.id < before &&
              (talkId === undefined || t.talkId === talkId),
          )
          .slice(-n);
  }

  private summary(t: (typeof this.talks)[number]): TalkSummary {
    const own = this.talk.filter((e) => e.threadId === null && e.talkId === t.id);
    const first = own.find((e) => e.role === "you");
    return {
      id: t.id,
      startedAtMs: t.startedAtMs,
      lastAtMs: t.lastAtMs,
      ...(t.title === undefined || t.titleBy === undefined
        ? {}
        : { title: t.title, titleBy: t.titleBy }),
      firstWords: first?.role === "you" ? first.text : "",
      entries: own.length,
    };
  }

  async createTalk(atMs: number): Promise<TalkSummary> {
    this.talks = this.talks.filter((t) => this.summary(t).entries > 0);
    const talk = { id: this.nextTalksId++, startedAtMs: atMs, lastAtMs: atMs };
    this.talks.push(talk);
    return this.summary(talk);
  }

  async getTalk(id: number): Promise<TalkSummary | null> {
    const talk = this.talks.find((t) => t.id === id);
    return talk === undefined ? null : this.summary(talk);
  }

  async listTalks(): Promise<readonly TalkSummary[]> {
    return [...this.talks]
      .sort((a, b) => b.lastAtMs - a.lastAtMs || b.id - a.id)
      .map((t) => this.summary(t));
  }

  async nameTalk(id: number, title: string, by: TalkTitleBy): Promise<boolean> {
    const talk = this.talks.find((t) => t.id === id);
    const name = cutTitle(title);
    if (talk === undefined || (by === "model" && (name === "" || talk.titleBy === "person"))) {
      return false;
    }
    if (name === "") {
      delete talk.title;
      delete talk.titleBy;
    } else {
      talk.title = name;
      talk.titleBy = by;
    }
    return true;
  }

  async deleteTalk(id: number): Promise<void> {
    this.talk = this.talk.filter((e) => !(e.threadId === null && e.talkId === id));
    this.talks = this.talks.filter((t) => t.id !== id);
  }

  async deleteAllTalks(): Promise<number> {
    const n = this.talks.length;
    this.talk = this.talk.filter((e) => e.threadId !== null);
    this.talks = [];
    return n;
  }

  async removeForThreads(threadIds: readonly string[]): Promise<void> {
    const gone = new Set(threadIds);
    this.searches = this.searches.map((o) => ({
      ...o,
      threadIds: o.threadIds.filter((id) => !gone.has(id)),
    }));
    this.talk = this.talk
      .filter((t) => t.threadId === null || !gone.has(t.threadId))
      .map((t) =>
        t.threadId === null && t.role === "agent"
          ? {
              ...t,
              quotes: t.quotes.filter((q) => q.threadId === undefined || !gone.has(q.threadId)),
              ...(t.hits === undefined
                ? {}
                : { hits: t.hits.filter((h) => !gone.has(h.threadId)) }),
              ...(t.carry === undefined
                ? {}
                : {
                    carry: { ...t.carry, threadIds: t.carry.threadIds.filter((i) => !gone.has(i)) },
                  }),
            }
          : t,
      );
    this.analyses = this.analyses.filter((a) => !gone.has(a.threadId));
    this.verdicts = this.verdicts.filter((v) => !gone.has(v.threadId));
    this.prepared = this.prepared.filter((p) => !gone.has(p.threadId));
    this.feedback = this.feedback.filter((f) => !gone.has(f.threadId));
    this.journal = this.journal.filter(
      (j) => j.action === "ruleAdded" || j.threadId === undefined || !gone.has(j.threadId),
    );
    this.instructions = this.instructions.filter(
      (i) => i.threadId === undefined || !gone.has(i.threadId),
    );
  }

  async listLedger(limit: number) {
    return this.ledger
      .map((entry, i) => ({ entry, i }))
      .sort((a, b) => b.entry.atMs - a.entry.atMs || b.i - a.i)
      .slice(0, Math.max(0, limit))
      .map((x) => x.entry);
  }
}

type SettingsPatch = Parameters<AgentSettingsPort["update"]>[0];

export class InMemoryAgentSettings implements AgentSettingsPort {
  private settings: AgentSettings = DEFAULT_AGENT_SETTINGS;
  private consents: AgentConsent[] = [];
  private records = new Map<string, AgentRuntimeRecord>();

  async get(): Promise<AgentSettings> {
    return this.settings;
  }

  async update(patch: SettingsPatch): Promise<AgentSettings> {
    const { limits, usedWeekResetsAtMs, ...rest } = patch;
    const next: { -readonly [K in keyof AgentSettings]: AgentSettings[K] } = { ...this.settings };
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) (next as Record<string, unknown>)[key] = value;
    }
    if (limits === null) next.limits = undefined;
    else if (limits !== undefined) next.limits = limits as PlanLimits;
    if (usedWeekResetsAtMs === null) next.usedWeekResetsAtMs = undefined;
    else if (usedWeekResetsAtMs !== undefined) next.usedWeekResetsAtMs = usedWeekResetsAtMs;
    // An absent field is absent, not undefined, as a stored value reads back.
    if (next.limits === undefined) delete next.limits;
    if (next.usedWeekResetsAtMs === undefined) delete next.usedWeekResetsAtMs;
    if (next.runtimeId === undefined) delete next.runtimeId;
    this.settings = next;
    return next;
  }

  async grantConsent(accountId: string, runtimeId: string, atMs: number): Promise<void> {
    if (this.consents.some((c) => c.accountId === accountId && c.runtimeId === runtimeId)) return;
    this.consents.push({ accountId, runtimeId, grantedAtMs: atMs });
  }

  async revokeConsent(accountId: string, runtimeId?: string): Promise<void> {
    this.consents = this.consents.filter(
      (c) => !(c.accountId === accountId && (runtimeId === undefined || c.runtimeId === runtimeId)),
    );
  }

  async listConsents(): Promise<readonly AgentConsent[]> {
    return [...this.consents].sort(
      (a, b) =>
        (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0) ||
        (a.runtimeId < b.runtimeId ? -1 : a.runtimeId > b.runtimeId ? 1 : 0),
    );
  }

  async getRuntimeRecord(runtimeId: string): Promise<AgentRuntimeRecord | null> {
    return this.records.get(runtimeId) ?? null;
  }

  async putRuntimeRecord(record: AgentRuntimeRecord): Promise<void> {
    this.records.set(record.runtimeId, record);
  }
}
