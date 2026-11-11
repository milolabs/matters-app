import type {
  FileHit,
  FilesPort,
  LabelRole,
  MessageDocument,
  ParsedQuery,
  Participant,
  PeoplePort,
  PersonStats,
  PersonSuggestion,
  QueryNode,
  RankedMessage,
  RankedSearchPort,
  SearchChunk,
  SearchIndexPort,
  SearchOptions,
} from "@matters/core";
import {
  fileHasWords,
  folderNamed,
  foldFileName,
  MAILBOX_BIT,
  MESSAGE_KEY_SEQ_LIMIT,
  plainGroups,
  tokenize,
} from "@matters/core";
import { type Database, write } from "./database.ts";
import { FileSearch } from "./fileIndex.ts";
import { PeopleTally, peopleWriter, personWords as personWordsOf } from "./people.ts";
import {
  buildRankedSql,
  buildSql,
  chooseRoute,
  countSql,
  DEFAULT_DRIVER_LIMITS,
  type DriverLimits,
  driverRows,
  KEY_MAX,
  KEY_MIN,
  MAX_EXPANSION,
  type Param,
  planQuery,
  type Route,
  type SearchPlan,
  termEntry,
} from "./searchPlan.ts";

const TEXT_COLUMNS = ["sender", "recipients", "cc", "subject", "body"] as const;
const STATEMENT_CACHE_LIMIT = 256;
/** Heavy plans look this many 30-day months back from the newest message, then the rest. */
const WINDOW_MONTHS = [1, 4, 16, 64] as const;
/** The agent's file-name matches (ADR 0080): words tried, hits per text, and what they count for. */
const FILE_GROUPS = 6;
const FILE_HITS = 20;
const FILE_SCAN = 100;
const FILE_WORD_RELEVANCE = 5;
const FILE_PHRASE_RELEVANCE = 9;
const MONTH_KEYS = 30 * 86_400_000 * MESSAGE_KEY_SEQ_LIMIT;

function folded(text: string): string {
  return tokenize(text).join(" ");
}

function people(ps: readonly Participant[]): string {
  return folded(ps.map((p) => `${p.name ?? ""} ${p.address}`).join(" "));
}

/** Word rows a prefix may have to be answered exactly, and ranked candidates looked at for mail. */
const PEOPLE_WORD_ROWS = 2000;
const PEOPLE_CANDIDATES = 120;
/** The most people a walk in rank order looks at. */
const PEOPLE_WALK = 4000;

interface PersonRow {
  address: string;
  name: string | null;
  count: number;
}

export class SqliteSearchIndex implements SearchIndexPort, RankedSearchPort, PeoplePort, FilesPort {
  private readonly fileSearch: FileSearch;
  private readonly peopleWriter;
  private readonly deleteDoc;
  private readonly insertDoc;
  private readonly insertTerm;
  private readonly cache = new Map<string, ReturnType<Database["prepare"]>>();

  private readonly db: Database;
  private readonly limits: DriverLimits;

  private readonly peopleRows: number;

  /**
   * `limits` only moves the driver thresholds (tests, benchmarks); results never depend on them.
   * `peopleRows` does the same for how common a prefix may be to be answered exactly.
   */
  constructor(
    db: Database,
    limits: DriverLimits = DEFAULT_DRIVER_LIMITS,
    peopleRows = PEOPLE_WORD_ROWS,
  ) {
    this.db = db;
    this.limits = limits;
    this.peopleRows = peopleRows;
    this.peopleWriter = peopleWriter(db);
    this.fileSearch = new FileSearch(db);
    this.deleteDoc = db.prepare("DELETE FROM message_fts WHERE rowid = ?");
    this.insertTerm = db.prepare("INSERT OR IGNORE INTO message_terms (term) VALUES (?)");
    this.insertDoc = db.prepare(
      `INSERT INTO message_fts (rowid, ${TEXT_COLUMNS.join(", ")}) VALUES (?, ?, ?, ?, ?, ?)`,
    );
  }

  async indexMessages(batch: readonly MessageDocument[]): Promise<void> {
    if (batch.length === 0) return;
    await write(this.db, () => {
      // Every token of 4 or more characters goes to `message_terms` in the same transaction, so
      // it always holds at least the words the index holds. Terms are never deleted.
      const terms = new Set<string>();
      const tally = new PeopleTally();
      const addTerms = (text: string): void => {
        for (const token of text.split(" ")) {
          const entry = termEntry(token);
          if (entry !== null) terms.add(entry);
        }
      };
      for (const { message: m, bodyText } of batch) {
        const columns = [
          people([m.from]),
          people(m.to),
          people(m.cc),
          folded(m.subject),
          folded(`${m.snippet} ${bodyText}`),
        ] as const;
        this.deleteDoc.run(m.key);
        this.insertDoc.run(m.key, ...columns);
        for (const column of columns) addTerms(column);
        tally.add(m.dateMs, [m.from, ...m.to, ...m.cc]);
      }
      this.peopleWriter.apply(tally);
      for (const term of terms) this.insertTerm.run(term);
    });
  }

  /**
   * ADR 0028. Candidates are ranked by count and latest date, and each one is kept only while
   * `message_fts` still holds mail naming the address. Removed mail leaves stale rows behind,
   * never on the screen.
   *
   * A prefix that few words start with is answered exactly: every person it finds, ranked. A
   * common one (two letters) would sort most of the table, so the people are walked in rank
   * order instead, and the first ones that fit are the best ones. Both read the person's
   * current words, so they agree.
   */
  async suggest(prefix: string, limit: number): Promise<readonly PersonSuggestion[]> {
    const words = tokenize(prefix);
    const want = Math.max(0, Math.trunc(limit));
    if (words.length === 0 || want === 0) return [];
    // The longest word narrows the range most; the others are checked on each candidate.
    const lead = words.reduce((a, b) => (b.length > a.length ? b : a));
    const hi = `${lead}\u{10FFFF}`;
    const inRange = (
      this.statement(
        "SELECT COUNT(*) AS n FROM (SELECT 1 FROM people_words WHERE word >= ? AND word < ? LIMIT ?)",
      ).get(lead, hi, this.peopleRows + 1) as { n: number }
    ).n;
    const exact = inRange <= this.peopleRows;
    const rows: Iterable<PersonRow> = exact
      ? (this.statement(
          `SELECT p.address, p.name, p.count FROM (
             SELECT DISTINCT address FROM people_words WHERE word >= ? AND word < ?) w
           JOIN people p ON p.address = w.address
           ORDER BY p.count DESC, p.last_ms DESC, p.address LIMIT ?`,
        ).all(lead, hi, PEOPLE_CANDIDATES) as unknown as PersonRow[])
      : (this.statement(
          "SELECT address, name, count FROM people INDEXED BY people_rank ORDER BY count DESC, last_ms DESC, address LIMIT ?",
        ).iterate(PEOPLE_WALK) as Iterable<PersonRow>);
    return this.people_(rows, words, want);
  }

  /** ADR 0078. One primary-key read, then the same "does mail still name them" check as `suggest`. */
  async person(address: string): Promise<PersonStats | undefined> {
    const row = this.statement(
      "SELECT address, name, count, last_ms FROM people WHERE address = ?",
    ).get(address.trim().toLowerCase()) as
      | { address: string; name: string | null; count: number; last_ms: number }
      | undefined;
    if (row === undefined || !this.hasMail(row.address)) return undefined;
    return {
      address: row.address,
      ...(row.name === null ? {} : { name: row.name }),
      count: row.count,
      lastMs: row.last_ms,
    };
  }

  /** ADR 0074. Read-only: the index of names is written with the files of a message. */
  async searchFiles(text: string, limit: number, accountId?: string): Promise<readonly FileHit[]> {
    return this.fileSearch.search(text, limit, accountId);
  }

  async frequent(limit: number): Promise<readonly PersonSuggestion[]> {
    const want = Math.max(0, Math.trunc(limit));
    if (want === 0) return [];
    const rows = this.statement(
      "SELECT address, name, count FROM people INDEXED BY people_rank ORDER BY count DESC, last_ms DESC, address LIMIT ?",
    ).iterate(PEOPLE_WALK) as Iterable<PersonRow>;
    return this.people_(rows, [], want);
  }

  /** The first `want` rows, in their order, that fit the words and still have mail. */
  private people_(
    rows: Iterable<PersonRow>,
    words: readonly string[],
    want: number,
  ): readonly PersonSuggestion[] {
    const out: PersonSuggestion[] = [];
    for (const row of rows) {
      const mine = personWordsOf(row.name ?? undefined, row.address);
      if (!words.every((w) => mine.some((m) => m.startsWith(w)))) continue;
      if (!this.hasMail(row.address)) continue;
      out.push({
        address: row.address,
        ...(row.name === null ? {} : { name: row.name }),
        count: row.count,
      });
      if (out.length >= want) break;
    }
    return out;
  }

  /** Whether any indexed message names the address; one phrase over sender, recipients, cc. */
  private hasMail(address: string): boolean {
    const tokens = tokenize(address);
    if (tokens.length === 0) return false;
    // Tokens are letters and digits only, so the quoted phrase carries no FTS syntax.
    const match = `{sender recipients cc} : "${tokens.join(" ")}"`;
    return (
      this.statement("SELECT 1 FROM message_fts WHERE message_fts MATCH ? LIMIT 1").get(match) !==
      undefined
    );
  }

  async removeMessages(keys: readonly number[]): Promise<void> {
    if (keys.length === 0) return;
    await write(this.db, () => {
      for (const key of keys) this.deleteDoc.run(key);
    });
  }

  async search(query: ParsedQuery, options: SearchOptions): Promise<readonly number[]> {
    const limit = Math.max(0, Math.trunc(options.limit));
    const plan = query.root === null ? null : this.plan(query.root);
    const keys: number[] = [];
    const oldest = options.order === "oldest";
    let cursor = oldest ? options.afterKey : options.beforeKey;
    while (plan !== null && keys.length < limit) {
      const chunk = this.run(plan, {
        ...options,
        limit: limit - keys.length,
        ...(cursor === undefined ? {} : oldest ? { afterKey: cursor } : { beforeKey: cursor }),
      });
      keys.push(...chunk.keys);
      cursor = oldest ? chunk.nextAfterKey : chunk.nextBeforeKey;
      if (cursor === undefined) break;
    }
    return keys;
  }

  async searchChunk(query: ParsedQuery, options: SearchOptions): Promise<SearchChunk> {
    return query.root === null ? { keys: [] } : this.run(this.plan(query.root), options);
  }

  /**
   * ADR 0080. The agent's search: bm25 over the fields with weights, the best `limit` messages
   * whatever their age (the caller weighs age), and the names of files that the plain words of
   * the query occur in. The person's own search does not come through here.
   */
  async searchRanked(
    query: ParsedQuery,
    options: {
      readonly limit: number;
      readonly accountIds?: readonly string[];
      readonly automatedPenalty?: number;
      readonly ownBoost?: number;
    },
  ): Promise<readonly RankedMessage[]> {
    const limit = Math.max(0, Math.trunc(options.limit));
    if (query.root === null || limit === 0) return [];
    const scoped = options.accountIds !== undefined;
    const root: QueryNode = scoped
      ? { kind: "and", children: [query.root, { kind: "account", ids: options.accountIds ?? [] }] }
      : query.root;
    const out: RankedMessage[] = [];
    const plan = this.plan(root);
    if (!plan.empty) {
      if (plan.match === null) {
        // Nothing to rank by (only filters): the newest, with no relevance to tell them apart.
        const keys = this.run(plan, { limit }).keys;
        if (keys.length > 0) {
          const rows = this.statement(
            "SELECT key, thread_id, account_id FROM messages WHERE key IN (SELECT value FROM json_each(?))",
          ).all(JSON.stringify(keys)) as { key: number; thread_id: string; account_id: string }[];
          for (const r of rows) {
            out.push({
              messageKey: r.key,
              threadId: r.thread_id,
              accountId: r.account_id,
              relevance: 0,
              via: "text",
            });
          }
        }
      } else {
        const { sql, params, named } = buildRankedSql(plan, limit, {
          ...(options.automatedPenalty === undefined
            ? {}
            : { automatedPenalty: options.automatedPenalty }),
          ...(options.ownBoost === undefined ? {} : { ownBoost: options.ownBoost }),
        });
        const stmt = this.statement(sql);
        const rows = (plan.nestedFts ? stmt.all(named, ...params) : stmt.all(...params)) as {
          key: number;
          thread_id: string;
          account_id: string;
          relevance: number;
        }[];
        for (const r of rows) {
          out.push({
            messageKey: r.key,
            threadId: r.thread_id,
            accountId: r.account_id,
            relevance: r.relevance,
            via: "text",
          });
        }
      }
    }
    out.push(...this.fileMatches(query.root, options.accountIds));
    return this.withSenders(out);
  }

  /**
   * Who each match came from (ADR 0081): the sender, whether it is the person's own Sent mail,
   * whether the headers say a program wrote it, and how many messages the people index holds for
   * the sender. Two statements over the keys, after the cut, so they cost the rows that came back.
   */
  private withSenders(found: readonly RankedMessage[]): RankedMessage[] {
    if (found.length === 0) return [];
    const keys = JSON.stringify([...new Set(found.map((m) => m.messageKey))]);
    const rows = this.statement(
      `SELECT key, lower(json_extract(from_json, '$.address')) AS sender,
              mailboxes & ${MAILBOX_BIT.sent} AS sent, automated, sender_auth,
              lower(json_extract(reply_to_json, '$[0].address')) AS reply_to
         FROM messages WHERE key IN (SELECT value FROM json_each(?))`,
    ).all(keys) as {
      key: number;
      sender: string | null;
      sent: number;
      automated: number | null;
      sender_auth: string;
      reply_to: string | null;
    }[];
    const by = new Map(rows.map((r) => [r.key, r]));
    const senders = JSON.stringify([
      ...new Set(rows.flatMap((r) => (r.sender === null || r.sender === "" ? [] : [r.sender]))),
    ]);
    const counts = new Map(
      (
        this.statement(
          "SELECT address, count FROM people WHERE address IN (SELECT value FROM json_each(?))",
        ).all(senders) as { address: string; count: number }[]
      ).map((r) => [r.address, r.count]),
    );
    return found.map((m) => {
      const r = by.get(m.messageKey);
      if (r === undefined) return m;
      const sender = r.sender ?? "";
      return {
        ...m,
        ...(sender === "" ? {} : { sender, senderMessages: counts.get(sender) ?? 0 }),
        fromMe: r.sent !== 0,
        ...(r.reply_to === null || r.reply_to === "" || r.reply_to === sender
          ? {}
          : { replyTo: r.reply_to }),
        ...(r.sender_auth === "pass" || r.sender_auth === "fail" || r.sender_auth === "unknown"
          ? { senderAuth: r.sender_auth }
          : {}),
        ...(r.automated === null ? {} : { automated: r.automated !== 0 }),
      };
    });
  }

  /**
   * Mail whose attached file names hold the plain words of a query (ADR 0080). A name holds
   * words when each occurs in it (as `fileNameMatches` says), whatever separates them, so "offer
   * letter" finds `Offer_letter (signed).pdf`: the file index is asked for the longest word and
   * the others are checked on the names it returns.
   */
  private fileMatches(root: QueryNode, accountIds: readonly string[] | undefined): RankedMessage[] {
    const groups = plainGroups(root);
    if (groups === null) return [];
    const allowed = accountIds === undefined ? null : new Set(accountIds);
    const out: RankedMessage[] = [];
    for (const words of groups.slice(0, FILE_GROUPS)) {
      const folded = words.map(foldFileName);
      const longest = folded.reduce((a, b) => (b.length > a.length ? b : a));
      for (const hit of this.fileSearch.search(
        longest,
        folded.length > 1 ? FILE_SCAN : FILE_HITS,
      )) {
        if (allowed !== null && !allowed.has(hit.accountId)) continue;
        if (!fileHasWords(foldFileName(hit.fileName), folded)) continue;
        out.push({
          messageKey: hit.messageKey,
          threadId: hit.threadId,
          accountId: hit.accountId,
          relevance: folded.length > 1 ? FILE_PHRASE_RELEVANCE : FILE_WORD_RELEVANCE,
          via: "file",
        });
      }
    }
    return out;
  }

  async matchesAmong(query: ParsedQuery, keys: readonly number[]): Promise<readonly number[]> {
    if (query.root === null || keys.length === 0) return [];
    const plan = this.plan(query.root);
    if (plan.empty) return [];
    const lower = Math.max(Math.min(...keys), plan.lowKey);
    const upper = Math.min(Math.max(...keys) + 1, plan.highKey);
    if (upper <= lower) return [];
    // One statement over the span of these keys: no driver and no windows, whatever the plan weighs.
    const { sql, params, named } = buildSql(
      plan,
      { driver: undefined, heavy: false },
      { lower, upper, limit: keys.length, within: JSON.stringify(keys) },
    );
    const stmt = this.statement(sql);
    const rows = (plan.nestedFts ? stmt.all(named, ...params) : stmt.all(...params)) as {
      key: number;
    }[];
    return rows.map((r) => r.key);
  }

  /**
   * One page for a light plan, one time window for a heavy one. `oldest` walks the key the other
   * way (ADR 0116, rule 4b): the windows grow forward from the oldest message, as they grow back
   * from the newest.
   */
  private run(plan: SearchPlan, options: SearchOptions): SearchChunk {
    const limit = Math.max(0, Math.trunc(options.limit));
    if (limit === 0 || plan.empty) return { keys: [] };
    const oldest = options.order === "oldest";
    const upperBound = Math.min(options.beforeKey ?? KEY_MAX, plan.highKey);
    const lowerBound = Math.max(
      options.afterKey === undefined ? KEY_MIN : options.afterKey + 1,
      plan.lowKey,
    );
    if (upperBound <= lowerBound) return { keys: [] };

    const route = this.route(plan);
    let lower = lowerBound;
    let upper = upperBound;
    let edge: number | undefined;
    if (route.heavy && !oldest) {
      const newest = (
        this.statement("SELECT MAX(key) AS k FROM messages").get() as { k: number | null }
      ).k;
      if (newest === null) return { keys: [] };
      if (options.beforeKey === undefined) upper = Math.min(upper, newest + 1);
      for (const months of WINDOW_MONTHS) {
        const candidate = newest - months * MONTH_KEYS;
        if (candidate < upper) {
          edge = candidate;
          break;
        }
      }
      if (edge !== undefined) lower = Math.max(lower, edge);
    } else if (route.heavy) {
      const first = (
        this.statement("SELECT MIN(key) AS k FROM messages").get() as { k: number | null }
      ).k;
      if (first === null) return { keys: [] };
      if (options.afterKey === undefined) lower = Math.max(lower, first);
      // From `after:` when it is later: the same for every window of the query, so they grow.
      const anchor = Math.max(first, plan.lowKey);
      for (const months of WINDOW_MONTHS) {
        const candidate = anchor + months * MONTH_KEYS;
        if (candidate > lower) {
          edge = candidate;
          break;
        }
      }
      if (edge !== undefined) upper = Math.min(upper, edge);
    }

    const { sql, params, named } = buildSql(plan, route, {
      lower,
      upper,
      limit,
      ...(oldest ? { order: "oldest" as const } : {}),
    });
    const stmt = this.statement(sql);
    const rows = (plan.nestedFts ? stmt.all(named, ...params) : stmt.all(...params)) as {
      key: number;
    }[];
    const keys = rows.map((r) => r.key);
    const last = keys[keys.length - 1];
    if (keys.length === limit && last !== undefined) {
      return oldest ? { keys, nextAfterKey: last } : { keys, nextBeforeKey: last };
    }
    // A short window may still have older (newer, for `oldest`) matches past its edge.
    if (route.heavy && edge !== undefined) {
      if (!oldest && edge > lowerBound) return { keys, nextBeforeKey: edge };
      if (oldest && edge < upperBound) return { keys, nextAfterKey: edge - 1 };
    }
    return { keys };
  }

  private plan(root: QueryNode): SearchPlan {
    return planQuery(
      root,
      this.limits.expand ? (prefix) => this.expandPrefix(prefix) : undefined,
      (label) => this.hiddenFolderRole(label),
    );
  }

  /**
   * The role of a Trash or Spam folder a `label:` value names (ADR 0044, rule 3), so that asking
   * for the folder by name is asking for the mail in it. The table is a handful of rows.
   */
  private hiddenFolderRole(folded: string): LabelRole | undefined {
    const rows = this.statement(
      "SELECT account_id, folder_id, name, role, exclusive FROM folders WHERE role IN ('trash', 'spam')",
    ).all() as {
      account_id: string;
      folder_id: string;
      name: string;
      role: LabelRole;
      exclusive: number;
    }[];
    const found = rows.find((r) =>
      folderNamed(
        {
          id: r.folder_id,
          accountId: r.account_id,
          name: r.name,
          role: r.role,
          exclusive: r.exclusive !== 0,
        },
        folded,
      ),
    );
    return found?.role;
  }

  /** The indexed terms that start with `prefix`, at most one more than the expansion cap. */
  private expandPrefix(prefix: string): readonly string[] {
    const rows = this.statement(
      "SELECT term FROM message_terms WHERE term >= ? AND term < ? LIMIT ?",
    ).all(prefix, `${prefix}\u{10FFFF}`, MAX_EXPANSION + 1) as { term: string }[];
    return rows.map((r) => r.term);
  }

  private route(plan: SearchPlan): Route {
    return chooseRoute(plan, this.countKeys(plan), this.limits);
  }

  /** How a query would run right now, for tests and the benchmark. */
  describeRoute(query: ParsedQuery): Route | null {
    if (query.root === null) return null;
    const plan = this.plan(query.root);
    return plan.empty ? null : this.route(plan);
  }

  /** Capped sizes of the indexed conjuncts; nothing to count means no probe at all. */
  private countKeys(plan: SearchPlan): Map<number, number> {
    const counts = new Map<number, number>();
    // No probe unless a driver could be afforded: even one row too many means nothing to measure.
    const rows = driverRows(plan, this.limits);
    if (rows <= 0) return counts;
    const cap = rows + 1;
    for (const [i, conj] of plan.conjs.entries()) {
      if (conj.keys === undefined) continue;
      const params: Param[] = [...conj.keys.params, cap];
      const row = this.statement(countSql(conj.keys)).get(...params) as { n: number };
      counts.set(i, row.n);
      if (row.n === 0) break;
    }
    return counts;
  }

  private statement(sql: string) {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      if (this.cache.size >= STATEMENT_CACHE_LIMIT) this.cache.clear();
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }
}
