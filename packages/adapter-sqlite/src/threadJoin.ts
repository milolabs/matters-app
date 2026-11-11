import type { DatabaseSync as Database } from "node:sqlite";
import {
  chooseThread,
  isLocalThread,
  isReplySubject,
  LOCAL_THREAD,
  localThreadRootOf,
  MAILBOX_BIT,
  normalizeSubject,
  SUBJECT_JOIN_WINDOW_MS,
  type SubjectJoinCandidate,
  type SubjectJoinMessage,
  subjectToJoinBy,
  threadBySubject,
} from "@matters/core";

// ADR 0091. A message on a local thread joins the threads it touches: the ones of the messages
// it points to, of the messages that point to it, and of its copies. The oldest thread keeps its
// id and the others are merged into it, with everything they own.

/** What the store knows of a message when it decides its thread. */
export interface JoinInput {
  readonly accountId: string;
  /** The thread its headers name. */
  readonly threadId: string;
  readonly messageIdHeader: string;
  /** `References`, then `In-Reply-To`; absent when not read. */
  readonly parentIds?: readonly string[];
  /** For a join by subject (ADR 0104); without them a message is joined by its ids alone. */
  readonly subject?: string;
  readonly from?: { readonly address: string };
  readonly dateMs?: number;
}

const LOCAL = `${LOCAL_THREAD}%`;

/**
 * The ids a message is stored as pointing to. Without its headers, the root its thread id names
 * stands for them (ADR 0091, rule 6).
 */
export function refsOf(m: JoinInput): string[] {
  const ids = m.parentIds ?? [localThreadRootOf(m.threadId, m.accountId)];
  return [...new Set(ids.filter((id) => id !== "" && id !== m.messageIdHeader))];
}

/**
 * Moves every message and everything else `losers` own into `winner` (ADR 0091, rule 4). The
 * agent's readings of all of them go, so the merged thread is read again. Returns how many
 * messages moved.
 */
export function mergeThreads(
  db: Database,
  winner: string,
  losers: readonly string[],
  changeSeq: number,
): number {
  const gone = losers.filter((t) => t !== winner);
  if (gone.length === 0) return 0;
  const list = JSON.stringify(gone);
  const all = JSON.stringify([winner, ...gone]);
  const moved = db
    .prepare(
      "UPDATE messages SET thread_id = ?, change_seq = ? WHERE thread_id IN (SELECT value FROM json_each(?))",
    )
    .run(winner, changeSeq, list);
  for (const table of ["drafts", "agent_feedback", "agent_journal", "agent_talk"]) {
    db.prepare(
      `UPDATE ${table} SET thread_id = ? WHERE thread_id IN (SELECT value FROM json_each(?))`,
    ).run(winner, list);
  }
  // An instruction the winner already has would break its unique index: that copy goes.
  db.prepare(
    "UPDATE OR IGNORE agent_instructions SET thread_id = ? WHERE thread_id IN (SELECT value FROM json_each(?))",
  ).run(winner, list);
  db.prepare(
    "DELETE FROM agent_instructions WHERE thread_id IN (SELECT value FROM json_each(?))",
  ).run(list);
  for (const table of ["agent_analyses", "agent_prepared"]) {
    db.prepare(`DELETE FROM ${table} WHERE thread_id IN (SELECT value FROM json_each(?))`).run(all);
  }
  return Number(moved.changes);
}

/**
 * The statements of a join by subject (ADR 0104). The window is read on `messages_account_date`
 * (account, date), so it costs the account's mail of 30 days, not the table.
 */
function prepareSubjectLookup(db: Database) {
  return {
    ownAddresses: db.prepare("SELECT lower(trim(address)) AS address FROM accounts"),
    window: db.prepare(`
      SELECT thread_id, subject FROM messages
       WHERE account_id = ? AND date_ms >= ? AND date_ms < ? AND thread_id LIKE '${LOCAL}'`),
    members: db.prepare(`
      SELECT thread_id, date_ms, subject, mailboxes, to_json, cc_json,
             lower(trim(json_extract(from_json, '$.address'))) AS sender
        FROM messages
       WHERE thread_id IN (SELECT value FROM json_each(?)) AND date_ms < ?`),
    firstDate: db.prepare("SELECT MIN(date_ms) AS first FROM messages WHERE thread_id = ?"),
  };
}
type SubjectLookup = ReturnType<typeof prepareSubjectLookup>;

/** The addresses of the person: those of the accounts, lower case. */
function ownAddresses(q: SubjectLookup): Set<string> {
  return new Set((q.ownAddresses.all() as { address: string }[]).map((r) => r.address));
}

/**
 * The local threads of an account that hold a message dated in the 30 days before `beforeMs`
 * with this normalised subject.
 */
function threadsWithSubject(
  q: SubjectLookup,
  accountId: string,
  subject: string,
  beforeMs: number,
): string[] {
  const out = new Set<string>();
  for (const row of q.window.all(accountId, beforeMs - SUBJECT_JOIN_WINDOW_MS, beforeMs)) {
    const r = row as { thread_id: string; subject: string };
    if (normalizeSubject(r.subject) === subject) out.add(r.thread_id);
  }
  return [...out];
}

function addresses(json: string): string[] {
  try {
    const list = JSON.parse(json) as { address?: unknown }[];
    return Array.isArray(list)
      ? list.map((p) => (typeof p?.address === "string" ? p.address.trim().toLowerCase() : ""))
      : [];
  } catch {
    return [];
  }
}

/**
 * The messages dated before `beforeMs` of these stored threads, as the rule reads them. `threadOf`
 * names the thread a stored thread counts as (the planner's merges not written yet).
 */
function candidatesOf(
  q: SubjectLookup,
  threads: readonly string[],
  beforeMs: number,
  own: ReadonlySet<string>,
  threadOf: (stored: string) => string,
): SubjectJoinCandidate[] {
  return (
    q.members.all(JSON.stringify(threads), beforeMs) as {
      thread_id: string;
      date_ms: number;
      subject: string;
      mailboxes: number;
      to_json: string;
      cc_json: string;
      sender: string | null;
    }[]
  ).map((r) => ({
    threadId: threadOf(r.thread_id),
    dateMs: r.date_ms,
    subject: r.subject,
    byPerson: (r.mailboxes & MAILBOX_BIT.sent) !== 0 || own.has(r.sender ?? ""),
    recipients: [...addresses(r.to_json), ...addresses(r.cc_json)],
  }));
}

function prepareJoin(db: Database) {
  return {
    byMessageIds: db.prepare(`
      SELECT DISTINCT thread_id FROM messages
       WHERE account_id = ? AND message_id_header IN (SELECT value FROM json_each(?))
         AND thread_id LIKE '${LOCAL}'`),
    byChildren: db.prepare(`
      SELECT DISTINCT m.thread_id FROM message_refs r JOIN messages m ON m.key = r.key
       WHERE r.account_id = ? AND r.ref_id = ? AND m.thread_id LIKE '${LOCAL}'`),
    firstDates: db.prepare(`
      SELECT thread_id, MIN(date_ms) AS first FROM messages
       WHERE thread_id IN (SELECT value FROM json_each(?)) GROUP BY thread_id`),
    ...prepareSubjectLookup(db),
    deleteRefs: db.prepare("DELETE FROM message_refs WHERE key = ?"),
    insertRef: db.prepare(
      "INSERT OR IGNORE INTO message_refs (key, account_id, ref_id) VALUES (?, ?, ?)",
    ),
  };
}

/** The thread decisions of one store, with its statements prepared once. */
export class ThreadJoiner {
  private readonly db: Database;
  private prepared: ReturnType<typeof prepareJoin> | undefined;

  constructor(db: Database) {
    this.db = db;
  }

  /** Prepared on first use: a store built on an older schema in a test never needs them. */
  private get q(): ReturnType<typeof prepareJoin> {
    this.prepared ??= prepareJoin(this.db);
    return this.prepared;
  }

  /**
   * The thread a message is stored in (ADR 0091, rules 2, 3 and 5). `current` is the thread it is
   * in now, when it is already stored. Merges the threads it joins; a provider thread is kept.
   */
  join(m: JoinInput, current: string | undefined, changeSeq: number, mailboxes = 0): string {
    if (!isLocalThread(m.threadId)) return m.threadId;
    const found = new Set<string>([m.threadId]);
    if (current !== undefined && isLocalThread(current)) found.add(current);
    const ids = refsOf(m);
    if (m.messageIdHeader !== "") ids.push(m.messageIdHeader);
    for (const row of this.q.byMessageIds.all(m.accountId, JSON.stringify(ids))) {
      found.add((row as { thread_id: string }).thread_id);
    }
    if (m.messageIdHeader !== "") {
      for (const row of this.q.byChildren.all(m.accountId, m.messageIdHeader)) {
        found.add((row as { thread_id: string }).thread_id);
      }
    }
    if (found.size === 1) return this.joinBySubject(m, mailboxes, changeSeq) ?? m.threadId;
    return this.merge([...found], changeSeq);
  }

  /** Merges `threads` into the one that keeps its id (ADR 0091, rule 3) and returns it. */
  private merge(threads: readonly string[], changeSeq: number): string {
    const first = new Map<string, number>();
    for (const row of this.q.firstDates.all(JSON.stringify(threads))) {
      const r = row as { thread_id: string; first: number };
      first.set(r.thread_id, r.first);
    }
    const winner = chooseThread(
      threads.map((threadId) => ({ threadId, firstDateMs: first.get(threadId) ?? null })),
    );
    mergeThreads(this.db, winner, threads, changeSeq);
    return winner;
  }

  /**
   * ADR 0104: a reply the ids found no thread for joins, by its subject, the thread in which the
   * person wrote to its sender. The lookup runs only for a message that passes rules 1 to 3.
   */
  private joinBySubject(m: JoinInput, mailboxes: number, changeSeq: number): string | undefined {
    if (m.subject === undefined || m.from === undefined || m.dateMs === undefined) return undefined;
    if (m.parentIds === undefined || m.parentIds.length > 0 || !isReplySubject(m.subject)) {
      return undefined;
    }
    const own = ownAddresses(this.q);
    const sender = m.from.address.trim().toLowerCase();
    const reply: SubjectJoinMessage = {
      messageId: m.messageIdHeader,
      parentIds: m.parentIds,
      subject: m.subject,
      sender,
      dateMs: m.dateMs,
      byPerson: (mailboxes & MAILBOX_BIT.sent) !== 0 || own.has(sender),
    };
    const subject = subjectToJoinBy(reply);
    if (subject === "") return undefined;
    const threads = threadsWithSubject(this.q, m.accountId, subject, m.dateMs);
    if (threads.length === 0) return undefined;
    const candidates = candidatesOf(this.q, threads, m.dateMs, own, (t) => t);
    const target = threadBySubject(reply, [m.threadId], candidates);
    return target === undefined ? undefined : this.merge([m.threadId, target], changeSeq);
  }

  /** Stores what a message on a local thread points to, in place of what it pointed to before. */
  writeRefs(key: number, m: JoinInput): void {
    if (!isLocalThread(m.threadId)) return;
    this.q.deleteRefs.run(key);
    for (const id of refsOf(m)) this.q.insertRef.run(key, m.accountId, id);
  }
}

/**
 * The once-only pass over mail stored before ADR 0091 (rule 6): every message on a local thread
 * points to the root its thread names, and threads that meet through those roots or through one
 * `Message-ID` are merged. Returns the number of threads merged away.
 */
export function rethreadStoredMail(db: Database): number {
  const rows = db
    .prepare(
      `SELECT key, account_id, thread_id, message_id_header, date_ms FROM messages
        WHERE thread_id LIKE '${LOCAL}'`,
    )
    .all() as {
    key: number;
    account_id: string;
    thread_id: string;
    message_id_header: string;
    date_ms: number;
  }[];
  const insertRef = db.prepare(
    "INSERT OR IGNORE INTO message_refs (key, account_id, ref_id) VALUES (?, ?, ?)",
  );
  const threadsOfId = new Map<string, Set<string>>();
  const accountOf = new Map<string, string>();
  const firstOf = new Map<string, number>();
  for (const r of rows) {
    accountOf.set(r.thread_id, r.account_id);
    const first = firstOf.get(r.thread_id);
    if (first === undefined || r.date_ms < first) firstOf.set(r.thread_id, r.date_ms);
    if (r.message_id_header !== "") {
      const at = `${r.account_id}\u0000${r.message_id_header}`;
      const set = threadsOfId.get(at) ?? new Set<string>();
      set.add(r.thread_id);
      threadsOfId.set(at, set);
    }
    for (const id of refsOf({
      accountId: r.account_id,
      threadId: r.thread_id,
      messageIdHeader: r.message_id_header,
    })) {
      insertRef.run(r.key, r.account_id, id);
    }
  }

  const parent = new Map<string, string>();
  const find = (t: string): string => {
    let x = t;
    while (parent.has(x)) x = parent.get(x) as string;
    let y = t;
    while (parent.has(y)) {
      const next = parent.get(y) as string;
      parent.set(y, x);
      y = next;
    }
    return x;
  };
  const union = (a: string, b: string) => {
    const x = find(a);
    const y = find(b);
    if (x !== y) parent.set(x, y);
  };
  for (const [thread, account] of accountOf) {
    const root = localThreadRootOf(thread, account);
    for (const other of threadsOfId.get(`${account}\u0000${root}`) ?? []) union(thread, other);
  }
  for (const set of threadsOfId.values()) {
    const [head, ...rest] = [...set];
    for (const t of rest) union(head as string, t);
  }

  const groups = new Map<string, string[]>();
  for (const thread of accountOf.keys()) {
    const root = find(thread);
    const group = groups.get(root) ?? [];
    group.push(thread);
    groups.set(root, group);
  }
  const seqRow = db.prepare("SELECT value FROM counters WHERE name = 'change_seq'").get() as
    | { value: number }
    | undefined;
  const seq = (seqRow?.value ?? 0) + 1;
  let merged = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const winner = chooseThread(
      group.map((threadId) => ({ threadId, firstDateMs: firstOf.get(threadId) ?? null })),
    );
    mergeThreads(db, winner, group, seq);
    merged += group.length - 1;
  }
  if (merged > 0) db.prepare("UPDATE counters SET value = ? WHERE name = 'change_seq'").run(seq);
  return merged;
}

/** A message of the stored mail that joins a thread by its subject (ADR 0104). */
export interface PlannedSubjectJoin {
  readonly key: number;
  /** The thread it is in, after the joins planned before it. */
  readonly from: string;
  /** The thread it answers, after the joins planned before it. */
  readonly to: string;
}

/**
 * Which messages stored before ADR 0104 join a thread by their subject, oldest first, so that a
 * chain of such replies collapses into one thread. Writes nothing and works on a database opened
 * read-only (it is fastest with `messages_account_date`, from schema 48). A stored message points
 * to nothing when it has no row in `message_refs` and its thread is named by its own non-blank
 * `Message-ID`; the person's messages are those in a Sent mailbox or from an account's address.
 */
export function planSubjectJoins(db: Database): PlannedSubjectJoin[] {
  const q = prepareSubjectLookup(db);
  const own = ownAddresses(q);
  const rows = db
    .prepare(
      `SELECT m.key, m.account_id, m.thread_id, m.message_id_header, m.date_ms, m.subject,
              lower(trim(json_extract(m.from_json, '$.address'))) AS sender
         FROM messages m
        WHERE m.thread_id LIKE '${LOCAL}' AND m.mailboxes & ${MAILBOX_BIT.sent} = 0
          AND trim(m.message_id_header) NOT IN ('', '<>')
          AND NOT EXISTS (SELECT 1 FROM message_refs r WHERE r.key = m.key)
        ORDER BY m.date_ms, m.key`,
    )
    .all() as {
    key: number;
    account_id: string;
    thread_id: string;
    message_id_header: string;
    date_ms: number;
    subject: string;
    sender: string | null;
  }[];

  // The merges planned so far: the stored threads each planned thread holds, and the reverse.
  const groupOf = new Map<string, string>();
  const membersOf = new Map<string, string[]>();
  const firstOf = new Map<string, number | null>();
  const threadOf = (stored: string) => groupOf.get(stored) ?? stored;
  const storedOf = (thread: string) => membersOf.get(thread) ?? [thread];
  const first = (thread: string): number | null => {
    if (!firstOf.has(thread)) {
      const row = q.firstDate.get(thread) as { first: number | null } | undefined;
      firstOf.set(thread, row?.first ?? null);
    }
    return firstOf.get(thread) ?? null;
  };

  const plan: PlannedSubjectJoin[] = [];
  for (const r of rows) {
    if (localThreadRootOf(r.thread_id, r.account_id) !== r.message_id_header) continue;
    const sender = r.sender ?? "";
    const reply: SubjectJoinMessage = {
      messageId: r.message_id_header,
      parentIds: [],
      subject: r.subject,
      sender,
      dateMs: r.date_ms,
      byPerson: own.has(sender),
    };
    const subject = subjectToJoinBy(reply);
    if (subject === "") continue;
    const from = threadOf(r.thread_id);
    const found = new Set(threadsWithSubject(q, r.account_id, subject, r.date_ms).map(threadOf));
    found.delete(from);
    if (found.size === 0) continue;
    const stored = [...found].flatMap(storedOf);
    const candidates = candidatesOf(q, stored, r.date_ms, own, threadOf);
    const to = threadBySubject(reply, [from], candidates);
    if (to === undefined) continue;
    plan.push({ key: r.key, from, to });
    const winner = chooseThread([
      { threadId: from, firstDateMs: first(from) },
      { threadId: to, firstDateMs: first(to) },
    ]);
    const a = first(from);
    const b = first(to);
    firstOf.set(winner, a === null ? b : b === null ? a : Math.min(a, b));
    const merged = [...storedOf(from), ...storedOf(to)];
    for (const t of [from, to]) if (t !== winner) membersOf.delete(t);
    membersOf.set(winner, merged);
    for (const t of merged) groupOf.set(t, winner);
  }
  return plan;
}

/**
 * Writes a plan of `planSubjectJoins`, in its order: each message's thread and the thread it
 * answers are merged, the oldest keeping its id (ADR 0091, rules 3 and 4). Returns the number of
 * threads merged away.
 */
export function applySubjectJoins(db: Database, plan: readonly PlannedSubjectJoin[]): number {
  if (plan.length === 0) return 0;
  const firstDate = db.prepare("SELECT MIN(date_ms) AS first FROM messages WHERE thread_id = ?");
  const seqRow = db.prepare("SELECT value FROM counters WHERE name = 'change_seq'").get() as
    | { value: number }
    | undefined;
  const seq = (seqRow?.value ?? 0) + 1;
  let merged = 0;
  for (const step of plan) {
    const threads = [step.from, step.to];
    const winner = chooseThread(
      threads.map((threadId) => ({
        threadId,
        firstDateMs: (firstDate.get(threadId) as { first: number | null }).first,
      })),
    );
    mergeThreads(db, winner, threads, seq);
    merged += 1;
  }
  db.prepare("UPDATE counters SET value = ? WHERE name = 'change_seq'").run(seq);
  return merged;
}

/** The once-only pass of ADR 0104 over mail stored before it. Returns the threads merged away. */
export function joinStoredRepliesBySubject(db: Database): number {
  return applySubjectJoins(db, planSubjectJoins(db));
}
