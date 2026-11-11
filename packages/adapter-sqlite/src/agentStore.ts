import type {
  AgentConsent,
  AgentInsightStorePort,
  AgentInstruction,
  AgentInstructionInput,
  AgentRule,
  AgentRuleInput,
  AgentRuntimeRecord,
  AgentSettings,
  AgentSettingsPort,
  AmountRole,
  AnalysisIntent,
  CaseStatus,
  Evidence,
  FeedbackOutcome,
  JournalEntry,
  JournalMemo,
  LedgerEntry,
  MatterAmount,
  NewTalkEntry,
  PlanLimits,
  PreparedRecord,
  PreparedWork,
  PromptFit,
  PromptSearch,
  PromptVerdict,
  TalkCarry,
  TalkEntry,
  TalkFact,
  TalkFactRow,
  TalkHit,
  TalkLoopUse,
  TalkOffer,
  TalkQuote,
  TalkSummary,
  TalkTitleBy,
  ThingEdge,
  ThingFeedback,
  ThreadAnalysis,
  ThreadCategory,
  ThreadFact,
} from "@matters/core";
import {
  AMOUNT_ROLES,
  ANALYSIS_INTENTS,
  CASE_STATUSES,
  cutTitle,
  DEFAULT_AGENT_SETTINGS,
  FEEDBACK_OUTCOMES,
  THREAD_CATEGORIES,
} from "@matters/core";
import { type Database, exclusive, write } from "./database.ts";

interface AnalysisRow {
  thread_id: string;
  last_message_key: number;
  analyzer_version: number;
  state: ThreadAnalysis["state"];
  headline: string;
  facts_json: string;
  stakes: ThreadAnalysis["stakes"];
  confidence: number;
  analyzed_at_ms: number;
  consequence: ThreadAnalysis["consequence"] | null;
  case_name: string | null;
  anchors_json: string | null;
  intent: string | null;
  reading_json: string | null;
}

/** What `reading_json` holds: everything of a reading that is not a column (ADR 0066). */
interface StoredReading {
  intentEvidence?: Evidence;
  amount?: MatterAmount;
  windowEndMs?: number;
  forYouEvidence?: Evidence;
  status?: CaseStatus;
  category?: ThreadCategory;
}

const isEvidence = (v: unknown): v is Evidence =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Evidence).quote === "string" &&
  Number.isInteger((v as Evidence).messageKey);

/** A value this build does not know (a newer one wrote it) reads as absent. */
function known<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function readingOf(json: string | null): StoredReading {
  if (json === null) return {};
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const amount = raw.amount as Partial<MatterAmount> | undefined;
    const role = known<AmountRole>(amount?.role, AMOUNT_ROLES);
    const status = known<CaseStatus>(raw.status, CASE_STATUSES);
    // A kind this build does not know reads as `other` (ADR 0068).
    const category =
      typeof raw.category === "string"
        ? (known<ThreadCategory>(raw.category, THREAD_CATEGORIES) ?? "other")
        : undefined;
    return {
      ...(isEvidence(raw.intentEvidence) ? { intentEvidence: raw.intentEvidence } : {}),
      ...(amount !== undefined &&
      role !== undefined &&
      typeof amount.value === "number" &&
      Number.isFinite(amount.value) &&
      typeof amount.currency === "string" &&
      isEvidence(amount.evidence)
        ? {
            amount: {
              value: amount.value,
              currency: amount.currency,
              role,
              evidence: amount.evidence,
            },
          }
        : {}),
      ...(typeof raw.windowEndMs === "number" && Number.isFinite(raw.windowEndMs)
        ? { windowEndMs: raw.windowEndMs }
        : {}),
      ...(isEvidence(raw.forYouEvidence) ? { forYouEvidence: raw.forYouEvidence } : {}),
      ...(status === undefined ? {} : { status }),
      ...(category === undefined ? {} : { category }),
    };
  } catch {
    return {};
  }
}

function readingJson(a: ThreadAnalysis): string | null {
  const reading: StoredReading = {
    ...(a.intentEvidence === undefined
      ? {}
      : {
          intentEvidence: {
            quote: a.intentEvidence.quote,
            messageKey: a.intentEvidence.messageKey,
          },
        }),
    ...(a.amount === undefined
      ? {}
      : {
          amount: {
            value: a.amount.value,
            currency: a.amount.currency,
            role: a.amount.role,
            evidence: {
              quote: a.amount.evidence.quote,
              messageKey: a.amount.evidence.messageKey,
            },
          },
        }),
    ...(a.windowEndMs === undefined ? {} : { windowEndMs: a.windowEndMs }),
    ...(a.forYouEvidence === undefined
      ? {}
      : {
          forYouEvidence: {
            quote: a.forYouEvidence.quote,
            messageKey: a.forYouEvidence.messageKey,
          },
        }),
    ...(a.status === undefined ? {} : { status: a.status }),
    ...(a.category === undefined ? {} : { category: a.category }),
  };
  return Object.keys(reading).length === 0 ? null : JSON.stringify(reading);
}

function toAnalysis(row: AnalysisRow): ThreadAnalysis {
  const intent = known<AnalysisIntent>(row.intent, ANALYSIS_INTENTS);
  const reading = readingOf(row.reading_json);
  return {
    threadId: row.thread_id,
    lastMessageKey: row.last_message_key,
    analyzerVersion: row.analyzer_version,
    state: row.state,
    headline: row.headline,
    facts: JSON.parse(row.facts_json) as ThreadFact[],
    stakes: row.stakes,
    confidence: row.confidence,
    analyzedAtMs: row.analyzed_at_ms,
    ...(row.consequence === null ? {} : { consequence: row.consequence }),
    ...(row.case_name === null ? {} : { caseName: row.case_name }),
    ...(row.anchors_json === null ? {} : { anchors: JSON.parse(row.anchors_json) as string[] }),
    ...(intent === undefined ? {} : { intent }),
    ...reading,
  };
}

interface TalkRow {
  id: number;
  thread_id: string | null;
  at_ms: number;
  role: "you" | "agent";
  kind: "answer" | "draft" | "question" | "closed" | "found" | null;
  text: string;
  quotes_json: string | null;
  runtime_name: string | null;
  model: string | null;
  threads: number | null;
  query: string | null;
  hits_json: string | null;
  carry_json: string | null;
  loop_json: string | null;
  talk_id: number | null;
  offers_json: string | null;
  facts_json: string | null;
}

interface TalksRow {
  id: number;
  started_at_ms: number;
  last_at_ms: number;
  title: string | null;
  title_by: string | null;
  first_words: string | null;
  entries: number;
}

function toTalkSummary(row: TalksRow): TalkSummary {
  const titleBy = known<TalkTitleBy>(row.title_by, ["model", "person"]);
  return {
    id: row.id,
    startedAtMs: row.started_at_ms,
    lastAtMs: row.last_at_ms,
    ...(row.title === null || titleBy === undefined ? {} : { title: row.title, titleBy }),
    firstWords: row.first_words ?? "",
    entries: row.entries,
  };
}

const TALKS_SELECT = `
  SELECT t.id, t.started_at_ms, t.last_at_ms, t.title, t.title_by,
         (SELECT e.text FROM agent_talk e WHERE e.talk_id = t.id AND e.role = 'you'
           ORDER BY e.id LIMIT 1) AS first_words,
         (SELECT COUNT(*) FROM agent_talk e WHERE e.talk_id = t.id) AS entries
    FROM agent_talks t`;

/** A quote as stored: only its own fields. */
function storedQuote(q: TalkQuote): TalkQuote {
  return {
    text: q.text,
    from: q.from,
    dateMs: q.dateMs,
    messageKey: q.messageKey,
    ...(q.threadId === undefined ? {} : { threadId: q.threadId }),
    ...(q.unchecked === true ? { unchecked: true as const } : {}),
  };
}

/** A hit as stored: only its own fields. */
function storedHit(h: TalkHit): TalkHit {
  return {
    threadId: h.threadId,
    who: h.who,
    subject: h.subject,
    note: h.note,
    lastMessageMs: h.lastMessageMs,
    state: h.state,
  };
}

/** What the loop did, as stored: only its own fields (ADR 0083, 0087, 0102). */
function storedLoop(l: TalkLoopUse): TalkLoopUse {
  return {
    searches: l.searches,
    read: l.read,
    ...(l.files === undefined ? {} : { files: l.files }),
    ...(l.counts === undefined ? {} : { counts: l.counts }),
    ...(l.views === true ? { views: true as const } : {}),
  };
}

/** An offer as stored: only the fields of its kind (ADR 0102). */
function storedOffer(o: TalkOffer): TalkOffer {
  switch (o.kind) {
    case "view":
      return {
        kind: "view",
        name: o.name,
        query: o.query,
        why: o.why,
        ...(o.notify === true ? { notify: true as const } : {}),
        matches: o.matches,
        matchesCapped: o.matchesCapped,
        unread: o.unread,
      };
    case "act":
      return {
        kind: "act",
        action: o.action,
        query: o.query,
        why: o.why,
        matches: o.matches,
        matchesCapped: o.matchesCapped,
        unread: o.unread,
      };
    case "message":
      return {
        kind: "message",
        to: [...o.to],
        unknownTo: [...o.unknownTo],
        subject: o.subject,
        body: o.body,
        why: o.why,
      };
  }
}

/** A fact as stored: only the fields of its kind (ADR 0102). */
function storedTalkFact(f: TalkFact): TalkFact {
  if (f.kind === "count") {
    return {
      kind: "count",
      query: f.query,
      matches: f.matches,
      capped: f.capped,
      unread: f.unread,
    };
  }
  const row = (r: TalkFactRow): TalkFactRow => ({
    key: r.key,
    ...(r.name === undefined ? {} : { name: r.name }),
    messages: r.messages,
    unread: r.unread,
  });
  return {
    kind: "overview",
    months: f.months,
    senders: f.senders.map(row),
    domains: f.domains.map(row),
  };
}

/** What the next question builds on, as stored: only its own fields. */
function storedCarry(c: TalkCarry): TalkCarry {
  return {
    hypothesis: c.hypothesis,
    threadIds: [...c.threadIds],
    queries: [...c.queries],
  };
}

function toTalkEntry(row: TalkRow): TalkEntry {
  // A talk of all mail has no thread, and since ADR 0086 a talk of its own.
  const base = {
    id: row.id,
    threadId: row.thread_id,
    ...(row.talk_id === null ? {} : { talkId: row.talk_id }),
    atMs: row.at_ms,
  };
  if (row.role === "you") return { ...base, role: "you", text: row.text };
  return {
    ...base,
    role: "agent",
    kind: row.kind ?? "answer",
    text: row.text,
    quotes: row.quotes_json === null ? [] : (JSON.parse(row.quotes_json) as TalkQuote[]),
    runtimeName: row.runtime_name ?? "",
    model: row.model ?? "",
    threads: row.threads ?? 0,
    ...(row.kind === "found"
      ? {
          query: row.query ?? "",
          hits: row.hits_json === null ? [] : (JSON.parse(row.hits_json) as TalkHit[]),
          ...(row.carry_json === null ? {} : { carry: JSON.parse(row.carry_json) as TalkCarry }),
          ...(row.loop_json === null ? {} : { loop: JSON.parse(row.loop_json) as TalkLoopUse }),
          ...(row.offers_json === null
            ? {}
            : { offers: JSON.parse(row.offers_json) as TalkOffer[] }),
          ...(row.facts_json === null ? {} : { facts: JSON.parse(row.facts_json) as TalkFact[] }),
        }
      : {}),
  };
}

/** A fact as stored: only its own fields, so an extra property of a caller's object is not kept. */
function storedFact(f: ThreadFact): ThreadFact {
  return {
    kind: f.kind,
    who: f.who,
    ...(f.dueMs === undefined ? {} : { dueMs: f.dueMs }),
    evidence: { quote: f.evidence.quote, messageKey: f.evidence.messageKey },
  };
}

interface FeedbackRow {
  thread_id: string;
  last_message_key: number;
  sender_address: string;
  kind: ThingFeedback["kind"];
  at_ms: number;
  until_ms: number | null;
  reason: string | null;
  outcome: string | null;
  case_key: string | null;
  amount_value: number | null;
}

interface JournalRow {
  id: number;
  at_ms: number;
  action: JournalEntry["action"];
  actor: JournalEntry["actor"];
  thread_id: string | null;
  last_message_key: number | null;
  sender_address: string | null;
  headline: string | null;
  words: string | null;
  reason: string | null;
  until_ms: number | null;
  undone_at_ms: number | null;
  also_covers: number | null;
  rule_id: number | null;
  subject: string | null;
  /** From `agent_rules`, by `rule_id`; rules are never deleted, so it is there for a rule line. */
  rule_scope: AgentRule["scope"] | null;
  instruction_id: number | null;
  /** From `agent_instructions`, by `instruction_id`; a line goes when its instruction does. */
  instruction_scope: AgentInstruction["scope"] | null;
  instruction_text: string | null;
}

interface InstructionRow {
  id: number;
  scope: AgentInstruction["scope"];
  text: string;
  thread_id: string | null;
  actor: AgentInstruction["actor"];
  words: string | null;
  at_ms: number;
}

function toInstruction(r: InstructionRow): AgentInstruction {
  return {
    id: r.id,
    scope: r.scope,
    text: r.text,
    ...(r.thread_id === null ? {} : { threadId: r.thread_id }),
    actor: r.actor,
    ...(r.words === null ? {} : { words: r.words }),
    atMs: r.at_ms,
  };
}

interface RuleRow {
  id: number;
  scope: AgentRule["scope"];
  subject: string;
  action: AgentRule["action"];
  actor: AgentRule["actor"];
  words: string | null;
  at_ms: number;
}

function toRule(r: RuleRow): AgentRule {
  return {
    id: r.id,
    scope: r.scope,
    subject: r.subject,
    action: r.action,
    actor: r.actor,
    atMs: r.at_ms,
    ...(r.words === null ? {} : { words: r.words }),
  };
}

function toJournalEntry(r: JournalRow): JournalEntry {
  const undone = r.undone_at_ms === null ? {} : { undoneAtMs: r.undone_at_ms };
  if (r.action === "ruleAdded") {
    return {
      id: r.id,
      atMs: r.at_ms,
      action: "ruleAdded",
      actor: r.actor,
      ruleId: r.rule_id ?? 0,
      scope: r.rule_scope ?? "sender",
      subject: r.subject ?? "",
      ...(r.words === null ? {} : { words: r.words }),
      ...undone,
    };
  }
  if (r.action === "instructionAdded") {
    return {
      id: r.id,
      atMs: r.at_ms,
      action: "instructionAdded",
      actor: r.actor,
      instructionId: r.instruction_id ?? 0,
      scope: r.instruction_scope ?? "general",
      text: r.instruction_text ?? "",
      ...(r.thread_id === null ? {} : { threadId: r.thread_id }),
      ...(r.words === null ? {} : { words: r.words }),
      ...undone,
    };
  }
  return {
    id: r.id,
    atMs: r.at_ms,
    action: r.action,
    actor: r.actor,
    threadId: r.thread_id ?? "",
    lastMessageKey: r.last_message_key ?? 0,
    senderAddress: r.sender_address ?? "",
    ...(r.headline === null ? {} : { headline: r.headline }),
    ...(r.words === null ? {} : { words: r.words }),
    ...(r.reason === null ? {} : { reason: r.reason }),
    ...(r.until_ms === null ? {} : { untilMs: r.until_ms }),
    ...(r.also_covers === null ? {} : { alsoCovers: r.also_covers }),
    ...undone,
  };
}

/**
 * The newest analysis of each thread for a version. The correlated max reads the same index as the
 * outer scan, so the list costs the number of threads analysed, not the size of the mailbox.
 */
export const LATEST_ANALYSES_SQL = `
  SELECT a.* FROM agent_analyses a INDEXED BY agent_analyses_latest
   WHERE a.analyzer_version = ?
     AND a.last_message_key = (
       SELECT max(b.last_message_key) FROM agent_analyses b INDEXED BY agent_analyses_latest
        WHERE b.analyzer_version = a.analyzer_version AND b.thread_id = a.thread_id)`;

export class SqliteAgentInsightStore implements AgentInsightStorePort {
  private readonly db: Database;
  private readonly selectOne;
  private readonly upsertAnalysis;
  private readonly selectLatest;
  private readonly selectLatestOf;
  private readonly selectBundleRead;
  private readonly upsertBundleRead;
  private readonly upsertPrepared;
  private readonly selectPrepared;
  private readonly insertFeedback;
  private readonly selectFeedback;
  private readonly deleteLatestFeedback;
  private readonly insertLedger;
  private readonly selectLedger;
  private readonly insertJournal;
  private readonly markUndone;
  private readonly selectJournal;
  private readonly selectActiveRule;
  private readonly insertRule;
  private readonly insertRuleJournal;
  private readonly deactivateRule;
  private readonly markRuleUndone;
  private readonly selectRules;
  private readonly selectActiveInstruction;
  private readonly insertInstruction;
  private readonly insertInstructionJournal;
  private readonly deactivateInstruction;
  private readonly markInstructionUndone;
  private readonly selectInstructions;
  private readonly insertTalk;
  private readonly selectTalk;
  private readonly selectTalkAll;
  private readonly selectTalkOne;
  private readonly touchTalk;
  private readonly selectTalks;
  private readonly selectTalkById;

  constructor(db: Database) {
    this.db = db;
    this.selectOne = db.prepare(
      `SELECT * FROM agent_analyses
        WHERE thread_id = ? AND last_message_key = ? AND analyzer_version = ?`,
    );
    this.upsertAnalysis = db.prepare(`
      INSERT INTO agent_analyses (thread_id, last_message_key, analyzer_version, state, headline,
                                  facts_json, stakes, confidence, analyzed_at_ms, consequence,
                                  case_name, anchors_json, intent, reading_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (thread_id, last_message_key, analyzer_version) DO UPDATE SET
        state = excluded.state, headline = excluded.headline, facts_json = excluded.facts_json,
        stakes = excluded.stakes, confidence = excluded.confidence,
        analyzed_at_ms = excluded.analyzed_at_ms, consequence = excluded.consequence,
        case_name = excluded.case_name, anchors_json = excluded.anchors_json,
        intent = excluded.intent, reading_json = excluded.reading_json`);
    this.selectLatest = db.prepare(LATEST_ANALYSES_SQL);
    this.selectLatestOf = db.prepare(
      `${LATEST_ANALYSES_SQL} AND a.thread_id IN (SELECT value FROM json_each(?))`,
    );
    this.upsertPrepared = db.prepare(`
      INSERT INTO agent_prepared (thread_id, last_message_key, work_json, prepared_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (thread_id, last_message_key) DO UPDATE SET
        work_json = excluded.work_json, prepared_at_ms = excluded.prepared_at_ms`);
    this.selectBundleRead = db.prepare(
      "SELECT edges_json FROM agent_bundle_reads WHERE signature = ?",
    );
    this.upsertBundleRead = db.prepare(`
      INSERT INTO agent_bundle_reads (signature, edges_json, read_at_ms) VALUES (?, ?, ?)
      ON CONFLICT (signature) DO UPDATE SET
        edges_json = excluded.edges_json, read_at_ms = excluded.read_at_ms`);
    this.selectPrepared = db.prepare(
      "SELECT * FROM agent_prepared WHERE thread_id = ? AND last_message_key = ?",
    );
    this.insertFeedback = db.prepare(`
      INSERT INTO agent_feedback (thread_id, last_message_key, sender_address, kind, at_ms, until_ms, reason,
                                  outcome, case_key, amount_value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.selectFeedback = db.prepare("SELECT * FROM agent_feedback ORDER BY id");
    this.deleteLatestFeedback = db.prepare(`
      DELETE FROM agent_feedback WHERE id = (
        SELECT id FROM agent_feedback WHERE thread_id = ? AND kind = ? ORDER BY id DESC LIMIT 1)`);
    this.insertLedger = db.prepare(`
      INSERT INTO agent_ledger (at_ms, runtime_id, account_id, purpose, threads)
      VALUES (?, ?, ?, ?, ?)`);
    this.insertTalk = db.prepare(`
      INSERT INTO agent_talk (thread_id, at_ms, role, kind, text, quotes_json, runtime_name, model, threads, query, hits_json, carry_json, loop_json, talk_id, offers_json, facts_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.selectTalk = db.prepare(`
      SELECT * FROM (SELECT * FROM agent_talk WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT ?)
       ORDER BY id`);
    this.selectTalkAll = db.prepare(`
      SELECT * FROM (SELECT * FROM agent_talk WHERE thread_id IS NULL AND id < ? ORDER BY id DESC LIMIT ?)
       ORDER BY id`);
    this.selectTalkOne = db.prepare(`
      SELECT * FROM (SELECT * FROM agent_talk
                      WHERE thread_id IS NULL AND talk_id = ? AND id < ? ORDER BY id DESC LIMIT ?)
       ORDER BY id`);
    this.touchTalk = db.prepare(
      "UPDATE agent_talks SET last_at_ms = MAX(last_at_ms, ?) WHERE id = ?",
    );
    this.selectTalks = db.prepare(`${TALKS_SELECT} ORDER BY t.last_at_ms DESC, t.id DESC`);
    this.selectTalkById = db.prepare(`${TALKS_SELECT} WHERE t.id = ?`);
    this.selectLedger = db.prepare(
      "SELECT * FROM agent_ledger ORDER BY at_ms DESC, id DESC LIMIT ?",
    );
    this.insertJournal = db.prepare(`
      INSERT INTO agent_journal (at_ms, action, actor, thread_id, last_message_key, sender_address,
                                 headline, words, reason, until_ms, also_covers)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.markUndone = db.prepare(`
      UPDATE agent_journal SET undone_at_ms = ? WHERE id = (
        SELECT id FROM agent_journal
         WHERE thread_id = ? AND action = ? AND undone_at_ms IS NULL ORDER BY id DESC LIMIT 1)`);
    this.selectJournal = db.prepare(`
      SELECT j.*, r.scope AS rule_scope, i.scope AS instruction_scope, i.text AS instruction_text
        FROM agent_journal j
        LEFT JOIN agent_rules r ON r.id = j.rule_id
        LEFT JOIN agent_instructions i ON i.id = j.instruction_id
       ORDER BY j.id DESC LIMIT ?`);
    this.selectActiveRule = db.prepare(
      "SELECT * FROM agent_rules WHERE scope = ? AND subject = ? AND removed_at_ms IS NULL",
    );
    this.insertRule = db.prepare(
      "INSERT INTO agent_rules (scope, subject, action, actor, words, at_ms) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.insertRuleJournal = db.prepare(`
      INSERT INTO agent_journal (at_ms, action, actor, words, rule_id, subject)
      VALUES (?, 'ruleAdded', ?, ?, ?, ?)`);
    this.deactivateRule = db.prepare(
      "UPDATE agent_rules SET removed_at_ms = ? WHERE id = ? AND removed_at_ms IS NULL",
    );
    this.markRuleUndone = db.prepare(
      "UPDATE agent_journal SET undone_at_ms = ? WHERE rule_id = ? AND undone_at_ms IS NULL",
    );
    this.selectRules = db.prepare(
      "SELECT * FROM agent_rules WHERE removed_at_ms IS NULL ORDER BY id",
    );
    this.selectActiveInstruction = db.prepare(`
      SELECT * FROM agent_instructions
       WHERE scope = ? AND ifnull(thread_id, '') = ? AND text = ? AND removed_at_ms IS NULL`);
    this.insertInstruction = db.prepare(`
      INSERT INTO agent_instructions (scope, text, thread_id, actor, words, at_ms)
      VALUES (?, ?, ?, ?, ?, ?)`);
    this.insertInstructionJournal = db.prepare(`
      INSERT INTO agent_journal (at_ms, action, actor, thread_id, words, instruction_id)
      VALUES (?, 'instructionAdded', ?, ?, ?, ?)`);
    this.deactivateInstruction = db.prepare(
      "UPDATE agent_instructions SET removed_at_ms = ? WHERE id = ? AND removed_at_ms IS NULL",
    );
    this.markInstructionUndone = db.prepare(
      "UPDATE agent_journal SET undone_at_ms = ? WHERE instruction_id = ? AND undone_at_ms IS NULL",
    );
    this.selectInstructions = db.prepare(
      "SELECT * FROM agent_instructions WHERE removed_at_ms IS NULL ORDER BY id",
    );
  }

  async getAnalysis(threadId: string, lastMessageKey: number, analyzerVersion: number) {
    const row = this.selectOne.get(threadId, lastMessageKey, analyzerVersion) as
      | AnalysisRow
      | undefined;
    return row === undefined ? null : toAnalysis(row);
  }

  async putAnalysis(analyses: readonly ThreadAnalysis[]): Promise<void> {
    if (analyses.length === 0) return;
    await write(this.db, () => {
      for (const a of analyses) {
        this.upsertAnalysis.run(
          a.threadId,
          a.lastMessageKey,
          a.analyzerVersion,
          a.state,
          a.headline,
          JSON.stringify(a.facts.map(storedFact)),
          a.stakes,
          a.confidence,
          a.analyzedAtMs,
          a.consequence ?? null,
          a.caseName ?? null,
          a.anchors === undefined ? null : JSON.stringify(a.anchors),
          a.intent ?? null,
          readingJson(a),
        );
      }
    });
  }

  async listAnalyses(analyzerVersion: number, threadIds?: readonly string[]) {
    const rows =
      threadIds === undefined
        ? this.selectLatest.all(analyzerVersion)
        : threadIds.length === 0
          ? []
          : this.selectLatestOf.all(analyzerVersion, JSON.stringify(threadIds));
    return (rows as unknown as AnalysisRow[]).map(toAnalysis);
  }

  async putPrepared(records: readonly PreparedRecord[]): Promise<void> {
    if (records.length === 0) return;
    await write(this.db, () => {
      for (const r of records) {
        this.upsertPrepared.run(
          r.threadId,
          r.lastMessageKey,
          JSON.stringify(r.work),
          r.preparedAtMs,
        );
      }
    });
  }

  async getBundleRead(signature: string): Promise<readonly ThingEdge[] | null> {
    const row = this.selectBundleRead.get(signature) as { edges_json: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.edges_json) as ThingEdge[]);
  }

  async putBundleRead(signature: string, edges: readonly ThingEdge[], atMs: number): Promise<void> {
    await write(this.db, () => {
      this.upsertBundleRead.run(signature, JSON.stringify(edges), atMs);
    });
  }

  async getPrepared(threadId: string, lastMessageKey: number) {
    const row = this.selectPrepared.get(threadId, lastMessageKey) as
      | { work_json: string; prepared_at_ms: number }
      | undefined;
    if (row === undefined) return null;
    return {
      threadId,
      lastMessageKey,
      work: JSON.parse(row.work_json) as PreparedWork,
      preparedAtMs: row.prepared_at_ms,
    };
  }

  async recordFeedback(f: ThingFeedback, memo?: JournalMemo): Promise<void> {
    // The feedback and its journal line are one write: they cannot disagree.
    await write(this.db, () => {
      this.insertFeedback.run(
        f.threadId,
        f.lastMessageKey,
        f.senderAddress,
        f.kind,
        f.atMs,
        f.untilMs ?? null,
        f.reason ?? null,
        f.outcome ?? null,
        f.caseKey ?? null,
        f.amountValue ?? null,
      );
      this.insertJournal.run(
        f.atMs,
        f.kind,
        memo?.actor ?? "person",
        f.threadId,
        f.lastMessageKey,
        f.senderAddress,
        memo?.headline ?? null,
        memo?.words ?? null,
        f.reason ?? null,
        f.untilMs ?? null,
        memo?.alsoCovers ?? null,
      );
    });
  }

  async withdrawFeedback(
    threadId: string,
    kind: ThingFeedback["kind"],
    atMs: number = Date.now(),
  ): Promise<void> {
    await write(this.db, () => {
      this.deleteLatestFeedback.run(threadId, kind);
      this.markUndone.run(atMs, threadId, kind);
    });
  }

  async listJournal(limit: number): Promise<readonly JournalEntry[]> {
    const n = Math.max(0, Math.trunc(limit));
    if (n === 0) return [];
    return (this.selectJournal.all(n) as unknown as JournalRow[]).map(toJournalEntry);
  }

  async addRule(input: AgentRuleInput, atMs: number): Promise<AgentRule> {
    // The rule and its journal line are one write; a second add of an active rule writes nothing.
    return write(this.db, () => {
      const active = this.selectActiveRule.get(input.scope, input.subject) as RuleRow | undefined;
      if (active !== undefined) return toRule(active);
      const res = this.insertRule.run(
        input.scope,
        input.subject,
        input.action,
        input.actor,
        input.words ?? null,
        atMs,
      );
      const id = Number(res.lastInsertRowid);
      this.insertRuleJournal.run(atMs, input.actor, input.words ?? null, id, input.subject);
      return {
        id,
        scope: input.scope,
        subject: input.subject,
        action: input.action,
        actor: input.actor,
        atMs,
        ...(input.words === undefined ? {} : { words: input.words }),
      };
    });
  }

  async removeRule(id: number, atMs: number): Promise<void> {
    await write(this.db, () => {
      this.deactivateRule.run(atMs, id);
      this.markRuleUndone.run(atMs, id);
    });
  }

  async listRules(): Promise<readonly AgentRule[]> {
    return (this.selectRules.all() as unknown as RuleRow[]).map(toRule);
  }

  async addInstruction(input: AgentInstructionInput, atMs: number): Promise<AgentInstruction> {
    // The instruction and its journal line are one write; a second add of an active one writes nothing.
    return write(this.db, () => {
      const threadId = input.scope === "thread" ? (input.threadId ?? null) : null;
      const active = this.selectActiveInstruction.get(input.scope, threadId ?? "", input.text) as
        | InstructionRow
        | undefined;
      if (active !== undefined) return toInstruction(active);
      const res = this.insertInstruction.run(
        input.scope,
        input.text,
        threadId,
        input.actor,
        input.words ?? null,
        atMs,
      );
      const id = Number(res.lastInsertRowid);
      this.insertInstructionJournal.run(atMs, input.actor, threadId, input.words ?? null, id);
      return {
        id,
        scope: input.scope,
        text: input.text,
        ...(threadId === null ? {} : { threadId }),
        actor: input.actor,
        ...(input.words === undefined ? {} : { words: input.words }),
        atMs,
      };
    });
  }

  async removeInstruction(id: number, atMs: number): Promise<void> {
    await write(this.db, () => {
      this.deactivateInstruction.run(atMs, id);
      this.markInstructionUndone.run(atMs, id);
    });
  }

  async listInstructions(): Promise<readonly AgentInstruction[]> {
    return (this.selectInstructions.all() as unknown as InstructionRow[]).map(toInstruction);
  }

  async listFeedback(): Promise<readonly ThingFeedback[]> {
    return (this.selectFeedback.all() as unknown as FeedbackRow[]).map((r) => {
      // An outcome this build does not know (a newer one wrote it) reads as absent.
      const outcome = known<FeedbackOutcome>(r.outcome, FEEDBACK_OUTCOMES);
      return {
        threadId: r.thread_id,
        lastMessageKey: r.last_message_key,
        senderAddress: r.sender_address,
        kind: r.kind,
        atMs: r.at_ms,
        ...(r.until_ms === null ? {} : { untilMs: r.until_ms }),
        ...(r.reason === null ? {} : { reason: r.reason }),
        ...(outcome === undefined ? {} : { outcome }),
        ...(r.case_key === null ? {} : { caseKey: r.case_key }),
        ...(r.amount_value === null ? {} : { amountValue: r.amount_value }),
      };
    });
  }

  async appendLedger(entries: readonly LedgerEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await write(this.db, () => {
      for (const e of entries) {
        this.insertLedger.run(e.atMs, e.runtimeId, e.accountId, e.purpose, e.threads);
      }
    });
  }

  async appendTalk(entries: readonly NewTalkEntry[]): Promise<readonly TalkEntry[]> {
    if (entries.length === 0) return [];
    return write(this.db, () =>
      entries.map((e): TalkEntry => {
        const { lastInsertRowid } =
          e.role === "you"
            ? this.insertTalk.run(
                e.threadId,
                e.atMs,
                "you",
                null,
                e.text,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                e.threadId === null ? (e.talkId ?? null) : null,
                null,
                null,
              )
            : this.insertTalk.run(
                e.threadId,
                e.atMs,
                "agent",
                e.kind,
                e.text,
                JSON.stringify(e.quotes.map(storedQuote)),
                e.runtimeName,
                e.model,
                e.threads,
                e.kind === "found" ? (e.query ?? "") : null,
                e.kind === "found" ? JSON.stringify((e.hits ?? []).map(storedHit)) : null,
                e.kind === "found" && e.carry !== undefined
                  ? JSON.stringify(storedCarry(e.carry))
                  : null,
                e.kind === "found" && e.loop !== undefined
                  ? JSON.stringify(storedLoop(e.loop))
                  : null,
                e.threadId === null ? (e.talkId ?? null) : null,
                e.kind === "found" && e.offers !== undefined && e.offers.length > 0
                  ? JSON.stringify(e.offers.map(storedOffer))
                  : null,
                e.kind === "found" && e.facts !== undefined && e.facts.length > 0
                  ? JSON.stringify(e.facts.map(storedTalkFact))
                  : null,
              );
        if (e.threadId === null && e.talkId !== undefined) this.touchTalk.run(e.atMs, e.talkId);
        return { ...e, id: Number(lastInsertRowid) } as TalkEntry;
      }),
    );
  }

  async listTalk(
    threadId: string | null,
    limit: number,
    options?: { readonly talkId?: number; readonly beforeId?: number },
  ): Promise<readonly TalkEntry[]> {
    const n = Math.max(0, Math.trunc(limit));
    if (n === 0) return [];
    const before = options?.beforeId ?? Number.MAX_SAFE_INTEGER;
    const talkId = options?.talkId;
    const rows = (threadId !== null
      ? this.selectTalk.all(threadId, before, n)
      : talkId === undefined
        ? this.selectTalkAll.all(before, n)
        : this.selectTalkOne.all(talkId, before, n)) as unknown as TalkRow[];
    return rows.map(toTalkEntry);
  }

  async createTalk(atMs: number): Promise<TalkSummary> {
    return write(this.db, () => {
      this.db
        .prepare(
          "DELETE FROM agent_talks WHERE NOT EXISTS (SELECT 1 FROM agent_talk e WHERE e.talk_id = agent_talks.id)",
        )
        .run();
      const id = Number(
        this.db
          .prepare("INSERT INTO agent_talks (started_at_ms, last_at_ms) VALUES (?, ?)")
          .run(atMs, atMs).lastInsertRowid,
      );
      return toTalkSummary(this.selectTalkById.get(id) as unknown as TalksRow);
    });
  }

  async getTalk(id: number): Promise<TalkSummary | null> {
    const row = this.selectTalkById.get(id) as unknown as TalksRow | undefined;
    return row === undefined ? null : toTalkSummary(row);
  }

  async listTalks(): Promise<readonly TalkSummary[]> {
    return (this.selectTalks.all() as unknown as TalksRow[]).map(toTalkSummary);
  }

  async nameTalk(id: number, title: string, by: TalkTitleBy): Promise<boolean> {
    const name = cutTitle(title);
    if (name === "" && by === "model") return false;
    return write(this.db, () => {
      const { changes } =
        by === "person"
          ? name === ""
            ? this.db
                .prepare("UPDATE agent_talks SET title = NULL, title_by = NULL WHERE id = ?")
                .run(id)
            : this.db
                .prepare("UPDATE agent_talks SET title = ?, title_by = 'person' WHERE id = ?")
                .run(name, id)
          : this.db
              .prepare(
                "UPDATE agent_talks SET title = ?, title_by = 'model' WHERE id = ? AND (title_by IS NULL OR title_by <> 'person')",
              )
              .run(name, id);
      return Number(changes) > 0;
    });
  }

  async deleteTalk(id: number): Promise<void> {
    await write(this.db, () => {
      this.db.prepare("DELETE FROM agent_talk WHERE thread_id IS NULL AND talk_id = ?").run(id);
      this.db.prepare("DELETE FROM agent_talks WHERE id = ?").run(id);
    });
  }

  async deleteAllTalks(): Promise<number> {
    return write(this.db, () => {
      const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM agent_talks").get() as {
        n: number;
      };
      this.db.prepare("DELETE FROM agent_talk WHERE thread_id IS NULL").run();
      this.db.prepare("DELETE FROM agent_talks").run();
      return n;
    });
  }

  async removeForThreads(threadIds: readonly string[]): Promise<void> {
    if (threadIds.length === 0) return;
    const json = JSON.stringify(threadIds);
    await write(this.db, () => {
      // Journal lines of a thread's instructions carry the thread id, so they go with the rest.
      for (const table of [
        "agent_analyses",
        "agent_prepared",
        "agent_feedback",
        "agent_journal",
        "agent_instructions",
        "agent_talk",
        "agent_prompt_verdicts",
      ]) {
        this.db
          .prepare(`DELETE FROM ${table} WHERE thread_id IN (SELECT value FROM json_each(?))`)
          .run(json);
      }
      this.dropFromTalkAll(new Set(threadIds));
      this.dropFromPromptSearches(new Set(threadIds));
    });
  }

  /** A kept search of a prompt (ADR 0116, rule 4) no longer names these threads. */
  private dropFromPromptSearches(gone: ReadonlySet<string>): void {
    const rows = this.db
      .prepare("SELECT prompt_key, filters, threads_json FROM agent_prompt_searches")
      .all() as unknown as { prompt_key: string; filters: string; threads_json: string }[];
    const update = this.db.prepare(
      "UPDATE agent_prompt_searches SET threads_json = ? WHERE prompt_key = ? AND filters = ?",
    );
    for (const row of rows) {
      const ids = JSON.parse(row.threads_json) as string[];
      const kept = ids.filter((id) => !gone.has(id));
      if (kept.length !== ids.length) update.run(JSON.stringify(kept), row.prompt_key, row.filters);
    }
  }

  /** The talk of all mail keeps its words and answers, but not the hits and quotes of these threads. */
  private dropFromTalkAll(gone: ReadonlySet<string>): void {
    const rows = this.db
      .prepare(
        "SELECT id, quotes_json, hits_json, carry_json FROM agent_talk WHERE thread_id IS NULL AND (hits_json IS NOT NULL OR quotes_json IS NOT NULL OR carry_json IS NOT NULL)",
      )
      .all() as unknown as {
      id: number;
      quotes_json: string | null;
      hits_json: string | null;
      carry_json: string | null;
    }[];
    const update = this.db.prepare(
      "UPDATE agent_talk SET quotes_json = ?, hits_json = ?, carry_json = ? WHERE id = ?",
    );
    for (const row of rows) {
      const quotes = row.quotes_json === null ? null : (JSON.parse(row.quotes_json) as TalkQuote[]);
      const hits = row.hits_json === null ? null : (JSON.parse(row.hits_json) as TalkHit[]);
      const keptQuotes = quotes?.filter((q) => q.threadId === undefined || !gone.has(q.threadId));
      const keptHits = hits?.filter((h) => !gone.has(h.threadId));
      const carry = row.carry_json === null ? null : (JSON.parse(row.carry_json) as TalkCarry);
      const keptCarry =
        carry === null
          ? null
          : { ...carry, threadIds: carry.threadIds.filter((t) => !gone.has(t)) };
      if (
        keptQuotes?.length === quotes?.length &&
        keptHits?.length === hits?.length &&
        keptCarry?.threadIds.length === carry?.threadIds.length
      ) {
        continue;
      }
      update.run(
        keptQuotes === undefined ? null : JSON.stringify(keptQuotes),
        keptHits === undefined ? null : JSON.stringify(keptHits),
        keptCarry === null ? null : JSON.stringify(keptCarry),
        row.id,
      );
    }
  }

  async listLedger(limit: number): Promise<readonly LedgerEntry[]> {
    const n = Math.max(0, Math.trunc(limit));
    if (n === 0) return [];
    const rows = this.selectLedger.all(n) as unknown as {
      at_ms: number;
      runtime_id: string;
      account_id: string;
      purpose: LedgerEntry["purpose"];
      threads: number;
    }[];
    return rows.map((r) => ({
      atMs: r.at_ms,
      runtimeId: r.runtime_id,
      accountId: r.account_id,
      purpose: r.purpose,
      threads: r.threads,
    }));
  }

  // --- A prompt is a filter (ADR 0116) ---

  async putPromptVerdicts(verdicts: readonly PromptVerdict[]): Promise<void> {
    if (verdicts.length === 0) return;
    await write(this.db, () => {
      // The primary key is the prompt and the thread: a newer verdict replaces the older one.
      const put = this.db.prepare(`
        INSERT OR REPLACE INTO agent_prompt_verdicts
          (prompt_key, thread_id, last_message_key, version, fit, why, quote, quote_key, at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const v of verdicts) {
        put.run(
          v.promptKey,
          v.threadId,
          v.lastMessageKey,
          v.version,
          v.fit,
          v.why,
          v.quote?.text ?? null,
          v.quote?.messageKey ?? null,
          v.atMs,
        );
      }
    });
  }

  async getPromptVerdicts(
    promptKey: string,
    version: number,
    threads: readonly { readonly threadId: string; readonly lastMessageKey: number }[],
  ): Promise<readonly PromptVerdict[]> {
    if (threads.length === 0) return [];
    const at = new Map(threads.map((t) => [t.threadId, t.lastMessageKey]));
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_prompt_verdicts
          WHERE prompt_key = ? AND version = ? AND thread_id IN (SELECT value FROM json_each(?))`,
      )
      .all(promptKey, version, JSON.stringify([...at.keys()])) as unknown as PromptVerdictRow[];
    return rows.filter((r) => at.get(r.thread_id) === r.last_message_key).map(verdictFromRow);
  }

  async prunePromptVerdicts(keep: readonly string[], beforeMs: number): Promise<number> {
    return write(this.db, () => {
      const result = this.db
        .prepare(
          `DELETE FROM agent_prompt_verdicts
            WHERE prompt_key NOT IN (SELECT value FROM json_each(?))
              AND prompt_key IN (SELECT prompt_key FROM agent_prompt_verdicts
                                  GROUP BY prompt_key HAVING max(at_ms) < ?)`,
        )
        .run(JSON.stringify(keep), beforeMs);
      // A search goes once its prompt has no verdict left and it is as old (rule 12).
      this.db
        .prepare(
          `DELETE FROM agent_prompt_searches
            WHERE prompt_key NOT IN (SELECT value FROM json_each(?))
              AND at_ms < ?
              AND prompt_key NOT IN (SELECT prompt_key FROM agent_prompt_verdicts)`,
        )
        .run(JSON.stringify(keep), beforeMs);
      return Number(result.changes);
    });
  }

  async putPromptSearch(search: PromptSearch): Promise<void> {
    await write(this.db, () => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO agent_prompt_searches
             (prompt_key, filters, queries_json, threads_json, at_ms, whole, read_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          search.promptKey,
          search.filters,
          JSON.stringify(search.queries),
          JSON.stringify(search.threadIds),
          search.atMs,
          search.whole === true ? 1 : 0,
          search.readAtMs ?? null,
        );
    });
  }

  async getPromptSearch(promptKey: string, filters: string): Promise<PromptSearch | null> {
    const row = this.db
      .prepare("SELECT * FROM agent_prompt_searches WHERE prompt_key = ? AND filters = ?")
      .get(promptKey, filters) as
      | {
          queries_json: string;
          threads_json: string;
          at_ms: number;
          whole: number;
          read_at_ms: number | null;
        }
      | undefined;
    if (row === undefined) return null;
    const strings = (json: string): string[] => {
      const v = JSON.parse(json) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    };
    return {
      promptKey,
      filters,
      queries: strings(row.queries_json),
      threadIds: strings(row.threads_json),
      atMs: row.at_ms,
      ...(row.whole === 1 ? { whole: true } : {}),
      ...(row.read_at_ms === null ? {} : { readAtMs: row.read_at_ms }),
    };
  }
}

interface PromptVerdictRow {
  prompt_key: string;
  thread_id: string;
  last_message_key: number;
  version: number;
  fit: number;
  why: string;
  quote: string | null;
  quote_key: number | null;
  at_ms: number;
}

/** A fit this build does not know (a newer build wrote it) reads as 0: it is not shown. */
function verdictFromRow(r: PromptVerdictRow): PromptVerdict {
  const fit: PromptFit = r.fit === 1 || r.fit === 2 || r.fit === 3 ? r.fit : 0;
  return {
    promptKey: r.prompt_key,
    threadId: r.thread_id,
    lastMessageKey: r.last_message_key,
    version: r.version,
    fit,
    why: r.why,
    ...(fit > 0 && r.quote !== null && r.quote_key !== null
      ? { quote: { text: r.quote, messageKey: r.quote_key } }
      : {}),
    atMs: r.at_ms,
  };
}

// --- Settings and consent ---

type Patch = Parameters<AgentSettingsPort["update"]>[0];

/** The stored JSON, defended against a value this build does not know (a newer one wrote it). */
function readSettings(json: string | undefined): AgentSettings {
  if (json === undefined) return DEFAULT_AGENT_SETTINGS;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
  if (typeof raw !== "object" || raw === null) return DEFAULT_AGENT_SETTINGS;
  const stored = raw as Partial<AgentSettings>;
  // A kind of work added later (ADR 0086: `titles`) keeps its default under models stored before.
  const models =
    typeof stored.models === "object" && stored.models !== null
      ? { ...DEFAULT_AGENT_SETTINGS.models, ...stored.models }
      : DEFAULT_AGENT_SETTINGS.models;
  return { ...DEFAULT_AGENT_SETTINGS, ...stored, models };
}

export class SqliteAgentSettings implements AgentSettingsPort {
  private readonly db: Database;
  private readonly selectSettings;
  private readonly upsertSettings;
  private readonly insertConsent;
  private readonly deleteConsent;
  private readonly deleteAccountConsents;
  private readonly selectConsents;
  private readonly selectRecord;
  private readonly upsertRecord;

  constructor(db: Database) {
    this.db = db;
    this.selectSettings = db.prepare("SELECT json FROM agent_settings WHERE id = 1");
    this.upsertSettings = db.prepare(
      "INSERT INTO agent_settings (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json",
    );
    this.insertConsent = db.prepare(
      "INSERT OR IGNORE INTO agent_consents (account_id, runtime_id, granted_at_ms) VALUES (?, ?, ?)",
    );
    this.deleteConsent = db.prepare(
      "DELETE FROM agent_consents WHERE account_id = ? AND runtime_id = ?",
    );
    this.deleteAccountConsents = db.prepare("DELETE FROM agent_consents WHERE account_id = ?");
    this.selectConsents = db.prepare(
      "SELECT account_id, runtime_id, granted_at_ms FROM agent_consents ORDER BY account_id, runtime_id",
    );
    this.selectRecord = db.prepare("SELECT * FROM agent_runtime_records WHERE runtime_id = ?");
    this.upsertRecord = db.prepare(`
      INSERT INTO agent_runtime_records (runtime_id, status, plan, problem, tested_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (runtime_id) DO UPDATE SET status = excluded.status, plan = excluded.plan,
        problem = excluded.problem, tested_at_ms = excluded.tested_at_ms`);
  }

  private current(): AgentSettings {
    const row = this.selectSettings.get() as { json: string } | undefined;
    return readSettings(row?.json);
  }

  async get(): Promise<AgentSettings> {
    return this.current();
  }

  async update(patch: Patch): Promise<AgentSettings> {
    let next = DEFAULT_AGENT_SETTINGS;
    await write(this.db, () => {
      const { limits, usedWeekResetsAtMs, ...rest } = patch;
      const merged: Record<string, unknown> = { ...this.current() };
      for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined) merged[key] = value;
      }
      if (limits === null) delete merged.limits;
      else if (limits !== undefined) merged.limits = limits satisfies PlanLimits;
      if (usedWeekResetsAtMs === null) delete merged.usedWeekResetsAtMs;
      else if (usedWeekResetsAtMs !== undefined) merged.usedWeekResetsAtMs = usedWeekResetsAtMs;
      this.upsertSettings.run(JSON.stringify(merged));
      next = merged as unknown as AgentSettings;
    });
    return next;
  }

  async grantConsent(accountId: string, runtimeId: string, atMs: number): Promise<void> {
    await exclusive(this.db, () => this.insertConsent.run(accountId, runtimeId, atMs));
  }

  async revokeConsent(accountId: string, runtimeId?: string): Promise<void> {
    await exclusive(this.db, () => {
      if (runtimeId === undefined) this.deleteAccountConsents.run(accountId);
      else this.deleteConsent.run(accountId, runtimeId);
    });
  }

  async listConsents(): Promise<readonly AgentConsent[]> {
    return (
      this.selectConsents.all() as unknown as {
        account_id: string;
        runtime_id: string;
        granted_at_ms: number;
      }[]
    ).map((r) => ({
      accountId: r.account_id,
      runtimeId: r.runtime_id,
      grantedAtMs: r.granted_at_ms,
    }));
  }

  async getRuntimeRecord(runtimeId: string): Promise<AgentRuntimeRecord | null> {
    const r = this.selectRecord.get(runtimeId) as
      | {
          runtime_id: string;
          status: AgentRuntimeRecord["status"];
          plan: string | null;
          problem: string | null;
          tested_at_ms: number;
        }
      | undefined;
    if (r === undefined) return null;
    return {
      runtimeId: r.runtime_id,
      status: r.status,
      ...(r.plan === null ? {} : { plan: r.plan }),
      ...(r.problem === null ? {} : { problem: r.problem }),
      testedAtMs: r.tested_at_ms,
    };
  }

  async putRuntimeRecord(record: AgentRuntimeRecord): Promise<void> {
    await exclusive(this.db, () =>
      this.upsertRecord.run(
        record.runtimeId,
        record.status,
        record.plan ?? null,
        record.problem ?? null,
        record.testedAtMs,
      ),
    );
  }
}
