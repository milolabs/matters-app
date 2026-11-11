// Run: bun run bench (Electron-as-node, SQLite 3.53 with FTS5). Not part of `test`.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { constants, zstdCompressSync } from "node:zlib";
import type { Message, MessageDocument, Participant, SyncedDocument } from "@matters/core";
import {
  applySyncBatch,
  countMatches,
  messageKey,
  moveThread,
  parseQuery,
  reapplyPendingMoves,
  searchMessages,
  undoMove,
} from "@matters/core";
import {
  createSqliteStorage,
  NEWEST_VISIBLE_SQL,
  openDatabase,
  SqliteSearchIndex,
} from "../src/index.ts";
import { DEFAULT_DRIVER_LIMITS, type SearchPlan } from "../src/searchPlan.ts";

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").replace(/ł/g, "l");

const MESSAGES = Number(process.env.BENCH_MESSAGES ?? 100_000);
const BATCH = 5_000;
const RUNS = 30;
const VOCAB = 20_000;
/** Distinct people, drawn with a Zipf law: a few write a lot, most write once or twice. */
const SENDERS = 60_000;
const THREAD_SIZE = 10;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261103);
// Flags, labels and attachments come from their own stream, so the text stays comparable.
const flagRand = mulberry32(20261104);
// Which messages are in Trash or Spam (ADR 0044): a stream of its own as well, so adding them
// moves nothing else.
const placeRand = mulberry32(20261105);

const SYLLABLES = [
  "ka",
  "to",
  "mi",
  "ra",
  "ne",
  "lo",
  "wa",
  "ste",
  "pro",
  "dzi",
  "ła",
  "żó",
  "ść",
  "się",
  "zą",
  "bę",
  "ód",
  "gą",
  "ćwi",
  "źre",
  "ńs",
  "kie",
  "cza",
  "szy",
  "rze",
  "wie",
  "nia",
  "ski",
  "cki",
];
const POLISH = [
  "żółć",
  "łódź",
  "źródło",
  "zażółć",
  "gęślą",
  "jaźń",
  "przysłał",
  "faktura",
  "spotkanie",
  "zamówienie",
  "płatność",
  "potwierdzenie",
  "załącznik",
  "dziękuję",
  "pozdrawiam",
  "wiadomość",
  "ogłoszenie",
  "oferta",
  "umowa",
  "rozliczenie",
  "przesyłka",
  "dostawa",
  "łączę",
  "więc",
  "żądanie",
  "śledzenie",
  "ćwiczenie",
  "ręcznie",
  "ósmy",
  "łatwo",
  "zażalenie",
  "pożyczka",
  "kłopot",
  "mięso",
  "szczęście",
  "wąż",
  "żyrafa",
  "gdańsk",
  "kraków",
  "wrocław",
];

function buildVocabulary(): string[] {
  const words: string[] = [];
  for (let i = 0; i < VOCAB; i++) {
    let n = i + 1;
    let w = "";
    do {
      w += SYLLABLES[n % SYLLABLES.length];
      n = Math.floor(n / SYLLABLES.length);
    } while (n > 0);
    words.push(w);
  }
  // Real Polish words at a spread of ranks: some frequent, many mid, a few rare.
  POLISH.forEach((w, i) => {
    words[3 + i * i * 7] = w;
  });
  return words;
}
const vocab = buildVocabulary();

const cdf = new Float64Array(VOCAB);
{
  let sum = 0;
  for (let i = 0; i < VOCAB; i++) {
    sum += 1 / (i + 1);
    cdf[i] = sum;
  }
  for (let i = 0; i < VOCAB; i++) cdf[i] = (cdf[i] as number) / sum;
}
function zipfRank(): number {
  const r = rand();
  let lo = 0;
  let hi = VOCAB - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cdf[mid] as number) < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
const words = (n: number): string[] => Array.from({ length: n }, () => vocab[zipfRank()] as string);

const FIRST_NAMES = [
  "jan",
  "anna",
  "piotr",
  "maria",
  "krzysztof",
  "katarzyna",
  "andrzej",
  "małgorzata",
  "tomasz",
  "agnieszka",
  "paweł",
  "barbara",
  "michał",
  "ewa",
  "marcin",
  "elżbieta",
  "marek",
  "zofia",
  "grzegorz",
  "teresa",
  "józef",
  "magdalena",
  "łukasz",
  "joanna",
  "adam",
  "janina",
  "jakub",
  "monika",
  "stanisław",
  "danuta",
  "rafał",
  "iwona",
  "robert",
  "karolina",
  "mateusz",
  "alicja",
  "john",
  "mary",
  "james",
  "sarah",
  "david",
  "emma",
  "michael",
  "laura",
  "daniel",
  "julia",
  "thomas",
  "sophie",
  "peter",
  "helen",
  "mark",
  "alice",
  "paul",
  "claire",
  "simon",
  "nina",
  "oliver",
  "ruth",
  "henry",
  "grace",
];
const senders: Participant[] = Array.from({ length: SENDERS }, (_, i) => {
  const first = FIRST_NAMES[(i * 7 + (i >> 6)) % FIRST_NAMES.length] as string;
  const last = vocab[(i * 13 + 100) % VOCAB] as string;
  // Some people send without a display name, as machines and mailing lists do.
  const name = i % 9 === 0 ? undefined : `${first} ${last}`;
  const address = `${fold(first)}.${fold(last)}${i}@example${i % 300}.${i % 2 ? "com" : "pl"}`;
  return name === undefined ? { address } : { name, address };
});
const senderCdf = new Float64Array(SENDERS);
{
  let sum = 0;
  for (let i = 0; i < SENDERS; i++) {
    sum += 1 / (i + 1);
    senderCdf[i] = sum;
  }
  for (let i = 0; i < SENDERS; i++) senderCdf[i] = (senderCdf[i] as number) / sum;
}
function pickSender(): Participant {
  const r = rand();
  let lo = 0;
  let hi = SENDERS - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((senderCdf[mid] as number) < r) lo = mid + 1;
    else hi = mid;
  }
  return senders[lo] as Participant;
}

const LABELS = ["inbox", "sent", "work", "news", "archive", "rare"];
function pickLabels(): string[] {
  const labels = [flagRand() < 0.6 ? "inbox" : flagRand() < 0.5 ? "archive" : "sent"];
  if (flagRand() < 0.2) labels.push("work");
  if (flagRand() < 0.1) labels.push("news");
  if (flagRand() < 0.005) labels.push("rare");
  // About one message in twelve is in Trash or Spam, a mailbox that is not kept tidy.
  const place = placeRand();
  if (place < 0.05) labels.push("trash");
  else if (place < 0.083) labels.push("spam");
  return labels;
}

const STARRED = 40;
/** A mailbox as people keep it: little unread, mostly among the newest, a few dozen starred. */
function pickFlags(i: number, starred: ReadonlySet<number>): Message["flags"] {
  const newest = i >= MESSAGES * 0.99;
  return {
    seen: flagRand() >= (newest ? 0.8 : 0.005),
    flagged: starred.has(i),
    answered: flagRand() < 0.2,
    draft: false,
  };
}

function generate(): MessageDocument[] {
  const start = Date.UTC(2023, 0, 1);
  const spanMinutes = 3 * 365 * 24 * 60;
  const minutes = Array.from({ length: MESSAGES }, () => Math.floor(rand() * spanMinutes)).sort(
    (a, b) => a - b,
  );
  const seqInMinute = new Map<number, number>();
  const starred = new Set<number>();
  while (starred.size < Math.min(STARRED, MESSAGES)) starred.add(Math.floor(flagRand() * MESSAGES));
  return minutes.map((minute, i) => {
    const seq = seqInMinute.get(minute) ?? 0;
    seqInMinute.set(minute, seq + 1);
    const dateMs = start + minute * 60_000;
    const from = pickSender();
    const message: Message = {
      key: messageKey(dateMs, seq),
      accountId: "acc1",
      providerId: `uid-${i}`,
      threadId: `t-${Math.floor(i / THREAD_SIZE)}`,
      messageIdHeader: `<${i}@example.com>`,
      dateMs,
      from,
      to: [{ name: "Me", address: "me@example.com" }],
      cc: rand() < 0.1 ? [pickSender()] : [],
      subject: words(3 + Math.floor(rand() * 6)).join(" "),
      snippet: words(14).join(" "),
      flags: pickFlags(i, starred),
      labelIds: pickLabels(),
      hasAttachments: flagRand() < 0.08,
      senderAuth: "unknown",
    };
    return { message, bodyText: words(30 + Math.floor(rand() * 60)).join(" ") };
  });
}

const wrap = (ws: string[], width = 72): string => {
  const lines: string[] = [];
  let line = "";
  for (const w of ws) {
    if (line.length + w.length + 1 > width && line) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.join("\n");
};

/**
 * Plain text bodies for the body store: a reply quotes the whole previous message of its thread
 * (`> ` lines, nesting as in real mail) and ends with a signature. Threads are THREAD_SIZE
 * consecutive documents. The search index keeps the shorter `bodyText` above, so the search
 * rows stay comparable with earlier runs.
 */
function replyBodies(docs: MessageDocument[]): string[] {
  const out: string[] = [];
  let previous = "";
  docs.forEach((d, i) => {
    const sender = d.message.from.name ?? "";
    const fresh = [
      "Dzień dobry,",
      wrap(words(40 + Math.floor(rand() * 60))),
      wrap(words(20 + Math.floor(rand() * 40))),
      "Pozdrawiam,",
      `-- \n${sender}\ntel. +48 ${500 + (i % 400)} 123 456`,
    ].join("\n\n");
    const body =
      i % THREAD_SIZE === 0
        ? fresh
        : `${fresh}\n\nW dniu 2024-01-01 12:00 ${sender} napisał(a):\n${previous
            .split("\n")
            .map((l) => (l ? `> ${l}` : ">"))
            .join("\n")}`;
    out.push(body);
    previous = body;
  });
  return out;
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
}

interface Row {
  name: string;
  median: number;
  p95: number;
  hits: number;
  /** The three slowest runs as `run:ms`; run i uses word i % n, so low numbers are first uses. */
  slowest: string;
  /** The untimed warm-up run (run 0), which is also the first use of its words. */
  warmup: number;
}
const rows: Row[] = [];
type SuggestFn = (prefix: string, limit: number) => Promise<readonly unknown[]>;

async function measure(name: string, runs: (i: number) => Promise<number>, count = RUNS) {
  const w0 = performance.now();
  await runs(0);
  const warmup = performance.now() - w0;
  const times: number[] = [];
  let hits = 0;
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    hits += await runs(i);
    times.push(performance.now() - t0);
  }
  const slowest = times
    .map((ms, i) => ({ ms, i }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3)
    .map((x) => `${x.i}:${x.ms.toFixed(1)}`)
    .join(" ");
  times.sort((a, b) => a - b);
  rows.push({
    name,
    median: quantile(times, 0.5),
    p95: quantile(times, 0.95),
    hits: hits / count,
    slowest,
    warmup,
  });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "matters-bench-"));
  const path = join(dir, "bench.db");
  try {
    console.log(`generating ${MESSAGES} messages...`);
    const docs = generate();
    const storage = createSqliteStorage(path);
    const { store, index } = storage;

    let storeMs = 0;
    let indexMs = 0;
    let bodyMs = 0;
    let bodyRawBytes = 0;
    // Per-message zstd on a sample of threads, to compare with the per-thread blocks.
    let perMessagePacked = 0;
    let perMessageRaw = 0;
    const t0 = performance.now();
    for (let i = 0; i < docs.length; i += BATCH) {
      const batch = docs.slice(i, i + BATCH);
      let t = performance.now();
      const { keys } = await store.upsertMessages(batch.map((d) => d.message));
      storeMs += performance.now() - t;
      t = performance.now();
      await index.indexMessages(
        batch.map((d, j) => ({ ...d, message: { ...d.message, key: keys[j] as number } })),
      );
      indexMs += performance.now() - t;

      const texts = replyBodies(batch);
      t = performance.now();
      await storage.bodies.putBodies(
        batch.map((d, j) => ({
          key: keys[j] as number,
          threadId: d.message.threadId,
          text: texts[j] as string,
        })),
      );
      bodyMs += performance.now() - t;
      for (const text of texts) bodyRawBytes += Buffer.byteLength(text);
      if (i % (BATCH * 10) === 0) {
        for (const text of texts) {
          const raw = Buffer.from(text);
          perMessageRaw += raw.length;
          perMessagePacked += zstdCompressSync(raw, {
            params: { [constants.ZSTD_c_compressionLevel]: 3 },
          }).length;
        }
      }
    }
    const bodyStats = storage.bodyStats();
    const insertMs = performance.now() - t0;
    storage.close();

    const reopened = createSqliteStorage(path);
    // Reads go through the reader connection, as in the app; writes through the writer.
    const s = reopened.read.store;
    const bodies = reopened.read.bodies;
    // BENCH_MATCH_BUDGET tries another driver budget (searchPlan.ts, MATCH_DRIVER_BUDGET).
    const budget = Number(process.env.BENCH_MATCH_BUDGET ?? 0);
    const tuned = budget > 0 ? new DatabaseSync(path, { readOnly: true }) : null;
    const ix =
      tuned === null
        ? reopened.read.index
        : new SqliteSearchIndex(tuned, { ...DEFAULT_DRIVER_LIMITS, matchBudget: budget });
    const size = statSync(path).size;

    const freq = [vocab[0], vocab[1], vocab[2], vocab[3], vocab[4]] as string[];
    const mid = Array.from({ length: 30 }, (_, i) => vocab[900 + i * 37] as string);
    const prefixes = mid.map((w) => fold(w).slice(0, 4));
    const polish = POLISH.map(fold);
    const fromNames = Array.from({ length: 30 }, (_, i) =>
      fold(vocab[((50 + i * 37) * 13 + 100) % VOCAB] as string),
    );
    const q = (text: string) => parseQuery(text);
    const search = async (text: string) => (await ix.search(q(text), { limit: 50 })).length;
    const firstChunk = async (text: string) =>
      (await ix.searchChunk(q(text), { limit: 50 })).keys.length;

    await measure("listNewest(50)", async () => (await s.listNewest({ limit: 50 })).length);
    await measure(
      "listNewest(50, label)",
      async () => (await s.listNewest({ limit: 50, labelId: "work" })).length,
    );
    // ADR 0044: the same queries without the check that leaves out Trash and Spam, on the same
    // data, to see what the check costs. `plan` is private; the bench reaches in for it.
    const unchecked = (index: SqliteSearchIndex): SqliteSearchIndex => {
      const inner = index as unknown as { plan(root: unknown): SearchPlan };
      const plan = inner.plan.bind(index);
      inner.plan = (root) => ({ ...plan(root), visibleOnly: false });
      return index;
    };
    const rawDb = new DatabaseSync(path, { readOnly: true });
    const ixOff = unchecked(new SqliteSearchIndex(rawDb));
    const searchOff = async (text: string) => (await ixOff.search(q(text), { limit: 50 })).length;
    const oldNewest = rawDb.prepare(
      NEWEST_VISIBLE_SQL.replace("INDEXED BY messages_visible", "").replace(
        /WHERE m\.mailboxes & \d+ = 0 AND m\.key < \?/,
        "WHERE m.key < ?",
      ),
    );
    const newNewest = rawDb.prepare(NEWEST_VISIBLE_SQL);
    const aKey = (docs[Math.floor(MESSAGES * 0.5)] as MessageDocument).message.key;
    await measure(
      "listNewest(50): all rows, before ADR 0044",
      async () => oldNewest.all(Number.MAX_SAFE_INTEGER, 50).length,
    );
    await measure(
      "listNewest(50): All mail, from the visible index",
      async () => newNewest.all(Number.MAX_SAFE_INTEGER, 50).length,
    );
    await measure(
      "listNewest(50, beforeKey): page in the middle, before ADR 0044",
      async () => oldNewest.all(aKey, 50).length,
    );
    await measure(
      "listNewest(50, beforeKey): page in the middle, All mail",
      async () => newNewest.all(aKey, 50).length,
    );
    await measure("search: frequent word, without the visibility check", (i) =>
      searchOff(fold(freq[i % freq.length] as string)),
    );
    await measure("search: mid-frequency word, without the visibility check", (i) =>
      searchOff(fold(mid[i % mid.length] as string)),
    );
    await measure("search: is:unread, without the visibility check", () => searchOff("is:unread"));
    await measure("search: frequent word + label:work, without the visibility check", (i) =>
      searchOff(`${fold(freq[i % freq.length] as string)} label:work`),
    );
    await measure("search: in:inbox", () => search("in:inbox"));
    await measure("search: in:inbox is:unread (the Inbox tab)", () => search("in:inbox is:unread"));
    await measure("search: in:trash", () => search("in:trash"));
    await measure("search: frequent word in:inbox", (i) =>
      search(`${fold(freq[i % freq.length] as string)} in:inbox`),
    );
    await measure("search: frequent word", (i) => search(fold(freq[i % freq.length] as string)));
    await measure("search: mid-frequency word", (i) => search(fold(mid[i % mid.length] as string)));
    await measure("search: two words (AND)", (i) =>
      search(`${fold(freq[i % freq.length] as string)} ${fold(mid[i % mid.length] as string)}`),
    );
    await measure("search: two frequent words", (i) =>
      search(`${fold(freq[i % 3] as string)} ${fold(freq[3 + (i % 2)] as string)}`),
    );
    await measure("search: prefix (4 chars)", (i) =>
      search(prefixes[i % prefixes.length] as string),
    );
    await measure("search: from: filter", (i) => search(`from:${fromNames[i % fromNames.length]}`));
    await measure("search: Polish word, no diacritics", (i) =>
      search(polish[i % polish.length] as string),
    );
    await measure("search: frequent word + label:work", (i) =>
      search(`${fold(freq[i % freq.length] as string)} label:work`),
    );
    await measure("search: frequent word + has:attachment + after:", (i) =>
      search(`${fold(freq[i % freq.length] as string)} has:attachment after:2024-06-01`),
    );
    await measure("end to end: searchMessages (keys + hydrate 50)", async (i) => {
      const r = await searchMessages(
        { index: ix, store: s, accounts: reopened.read.accounts },
        fold(mid[i % mid.length] as string),
        { limit: 50 },
      );
      return r.messages.length;
    });

    // ADR 0025 plan shapes. Page = `search` (exact 50), chunk = one `searchChunk` window.
    const f = (i: number) => fold(freq[i % freq.length] as string);
    const m = (i: number) => fold(mid[i % mid.length] as string);
    await measure("query: label:rare", () => search("label:rare"));
    // A real word of 4+ letters in about half the mailbox (rank 10 of the vocabulary), as
    // opposed to the two-letter prefixes above that match nearly everything.
    const full = fold(vocab[10] as string);
    await measure("query: full word", () => search(full));
    await measure("query: full word is:starred (first chunk)", () =>
      firstChunk(`${full} is:starred`),
    );
    await measure("query: full word is:starred (search, 50)", () => search(`${full} is:starred`));
    await measure("query: full word label:rare (first chunk)", () =>
      firstChunk(`${full} label:rare`),
    );
    await measure("query: full word label:rare (search, 50)", () => search(`${full} label:rare`));
    await measure("query: full word, narrow old date window", () =>
      search(`${full} after:2023-03-06 before:2023-03-13`),
    );
    await measure("query: full word -mid", (i) => search(`${full} -${m(i)}`));
    await measure("query: full word full word", () => search(`${full} ${full}`));
    await measure("query: full word OR is:starred (first chunk)", () =>
      firstChunk(`${full} OR is:starred`),
    );
    await measure("query: full word OR is:starred (search, 50)", () =>
      search(`${full} OR is:starred`),
    );
    await measure("query: f (first keystroke)", () => search("f"));
    await measure("query: f (first chunk)", () => firstChunk("f"));
    await measure("query: frequent label:rare", (i) => search(`${f(i)} label:rare`));
    await measure("query: frequent, narrow old date window", (i) =>
      search(`${f(i)} after:2023-03-06 before:2023-03-13`),
    );
    await measure("query: is:starred", () => search("is:starred"));
    await measure("query: frequent is:starred", (i) => search(`${f(i)} is:starred`));
    await measure("query: is:unread", () => search("is:unread"));
    await measure("query: frequent is:unread", (i) => search(`${f(i)} is:unread`));
    await measure("query: frequent OR frequent", (i) => search(`${f(i)} OR ${f(i + 1)}`));
    await measure("query: frequent -mid", (i) => search(`${f(i)} -${m(i)}`));
    await measure("query: -frequent (first chunk)", (i) => firstChunk(`-${f(i)}`));
    await measure("query: -frequent (search, 50)", (i) => search(`-${f(i)}`));
    await measure("query: frequent OR is:starred (first chunk)", (i) =>
      firstChunk(`${f(i)} OR is:starred`),
    );
    await measure("query: frequent OR is:starred (search, 50)", (i) =>
      search(`${f(i)} OR is:starred`),
    );
    await measure("query: rare mid OR is:starred (search, 50)", (i) =>
      search(`${m(i)} OR is:starred`),
    );

    // ADR 0116, rule 4b: the same shapes walked oldest first. Windows grow from the oldest
    // message, as they grow back from the newest; `sort:oldest` alone lists all mail.
    if (process.env.BENCH_OLDEST !== "0") {
      const oldest = { limit: 50, order: "oldest" as const };
      const searchUp = async (text: string) => (await ix.search(q(text), oldest)).length;
      const chunkUp = async (text: string) => (await ix.searchChunk(q(text), oldest)).keys.length;
      await measure("oldest: full word", () => searchUp(full));
      await measure("oldest: full word is:starred (search, 50)", () =>
        searchUp(`${full} is:starred`),
      );
      await measure("oldest: full word label:rare (search, 50)", () =>
        searchUp(`${full} label:rare`),
      );
      await measure("oldest: full word OR is:starred (first chunk)", () =>
        chunkUp(`${full} OR is:starred`),
      );
      await measure("oldest: full word OR is:starred (search, 50)", () =>
        searchUp(`${full} OR is:starred`),
      );
      await measure("oldest: frequent label:rare", (i) => searchUp(`${f(i)} label:rare`));
      await measure("oldest: is:unread", () => searchUp("is:unread"));
      await measure("oldest: frequent -mid", (i) => searchUp(`${f(i)} -${m(i)}`));
      await measure("oldest: -frequent (search, 50)", (i) => searchUp(`-${f(i)}`));
      await measure("oldest: all mail (search, 50)", () => searchUp("is:read OR is:unread"));
      await measure("oldest: end to end searchMessages sort:oldest (50)", async (i) => {
        const r = await searchMessages(
          { index: ix, store: s, accounts: reopened.read.accounts },
          `${fold(mid[i % mid.length] as string)} sort:oldest`,
          { limit: 50 },
        );
        return r.messages.length;
      });
    }

    const threadCount = Math.floor(MESSAGES / THREAD_SIZE);
    // A stride coprime with the thread count walks the whole mailbox, not just recent threads.
    await measure("open thread of 10 (getThread + getBodies)", async (i) => {
      const view = await s.getThread(`t-${(i * 7919) % threadCount}`);
      if (!view) return 0;
      const texts = await bodies.getBodies(view.messages.map((m) => m.key));
      return texts.size;
    });
    await measure("body store: append a reply to a 10-message thread", async (i) => {
      const thread = `t-${(i * 104729 + 3) % threadCount}`;
      await reopened.bodies.putBodies([
        { key: 9_000_000_000_000_000 + i, threadId: thread, text: wrap(words(60)) },
      ]);
      return 1;
    });

    // ADR 0028: people for the query bar, on the reader connection, once per keystroke.
    // `longestSuggest` is the slowest single request, which is what can stand in front of one.
    const longestSuggest = new Map<string, number>();
    const suggest = reopened.read.people as { suggest?: SuggestFn } | undefined;
    if (typeof suggest?.suggest === "function") {
      const people = reopened.read.people;
      const rank = (k: number) => senders[Math.min(SENDERS - 1, k)] as Participant;
      const twoLetters = ["ja", "an", "ma", "pi", "ka", "ew", "jo", "ja", "mi", "ad", "da", "lu"];
      const fourLetters = FIRST_NAMES.slice(0, 40).map((n) => fold(n).slice(0, 4));
      // Names of people from the head, the middle and the tail of the Zipf order.
      const specific = Array.from({ length: 60 }, (_, i) => {
        const who = rank(1 + ((i * 997) % SENDERS)).name ?? "x y";
        const [first = "", last = ""] = fold(who).split(" ");
        return `${first.slice(0, 3)} ${last.slice(0, 5)}`;
      });
      const nothing = ["qzx", "xqxq", "zzzzz", "qqj", "wxyz"];
      const run = async (name: string, prefixes: readonly string[]) => {
        await measure(
          name,
          async (i) => {
            const t = performance.now();
            const r = await people.suggest(prefixes[i % prefixes.length] as string, 8);
            longestSuggest.set(
              name,
              Math.max(longestSuggest.get(name) ?? 0, performance.now() - t),
            );
            return r.length;
          },
          300,
        );
      };
      await run("suggest: 2-letter prefix", twoLetters);
      await run("suggest: 4-letter prefix", fourLetters);
      await run("suggest: person-specific prefix", specific);
      await run("suggest: no match", nothing);
    }

    // One provider batch as sync will apply it: 500 new messages, 20 removals and the cursor,
    // in a single unit of work (upsert, index, bodies, removals, cursor).
    const SYNC_BATCH = 500;
    const syncStart = Date.UTC(2027, 0, 1);
    await measure("applySyncBatch: 500 new + 20 removed, one unit", async (i) => {
      const documents = Array.from({ length: SYNC_BATCH }, (_, j): SyncedDocument => {
        const n = i * SYNC_BATCH + j;
        const dateMs = syncStart + n * 60_000;
        const from = pickSender();
        const document: MessageDocument = {
          message: {
            key: messageKey(dateMs, 0),
            accountId: "acc1",
            providerId: `sync-${n}`,
            threadId: `sync-t-${Math.floor(n / THREAD_SIZE)}`,
            messageIdHeader: `<sync-${n}@example.com>`,
            dateMs,
            from,
            to: [{ name: "Me", address: "me@example.com" }],
            cc: [],
            subject: words(5).join(" "),
            snippet: words(14).join(" "),
            flags: { seen: false, flagged: false, answered: false, draft: false },
            labelIds: ["inbox"],
            hasAttachments: false,
            senderAuth: "unknown",
          },
          bodyText: wrap(words(80)),
        };
        return {
          document,
          location: { accountId: "acc1", folderId: "INBOX", uidValidity: "1", uid: n + 1 },
        };
      });
      // The generated mailbox has no locations, so the removals are of the previous runs' mail.
      const removedLocations = Array.from({ length: i === 0 ? 0 : 20 }, (_, j) => ({
        accountId: "acc1",
        folderId: "INBOX",
        uidValidity: "1",
        uid: (i - 1) * SYNC_BATCH + j + 1,
      }));
      const r = await applySyncBatch(reopened, {
        accountId: "acc1",
        folderId: "INBOX",
        batch: {
          documents,
          knownLocations: [],
          flagUpdates: [],
          removedLocations,
          cursor: { uidValidity: "1", lastUid: (i + 1) * SYNC_BATCH },
        },
      });
      return r.upserted.keys.length;
    });

    // ADR 0027 badges: `countMatches` as the renderer drives it. First chunk = one request of
    // cap 99; full count = chunks until 99 unread or the end. `longest` is the slowest single
    // request, which is what can stand in front of a keystroke.
    const countDeps = { index: ix, accounts: reopened.read.accounts };
    const longest = new Map<string, number>();
    const countChunk = async (text: string, name: string, full: boolean) => {
      let total = 0;
      let before: number | undefined;
      for (;;) {
        const t = performance.now();
        const r = await countMatches(countDeps, text, {
          cap: 99 - total,
          ...(before === undefined ? {} : { beforeKey: before }),
        });
        longest.set(name, Math.max(longest.get(name) ?? 0, performance.now() - t));
        total += r.count;
        if (!full || total >= 99 || r.nextBeforeKey === undefined) return total;
        before = r.nextBeforeKey;
      }
    };
    for (const [label, text] of [
      ["is:unread", "is:unread"],
      ["full word", full],
      ["full word label:rare", `${full} label:rare`],
    ] as const) {
      const first = `count: ${label} (first chunk, cap 99)`;
      const all = `count: ${label} (full, to 99)`;
      await measure(first, () => countChunk(text, first, false));
      await measure(all, () => countChunk(text, all, true));
    }

    // ADR 0044: the work around one move. `moveThread` writes the labels, the mailboxes and the
    // request in one unit; the reapply runs at the end of every sync batch, here with a few
    // hundred moves waiting.
    const folders = ["INBOX", "Archive", "Trash", "Junk", "Sent"].map((id, i) => ({
      id,
      accountId: "acc1",
      name: id,
      role: (["inbox", "archive", "trash", "spam", "sent"] as const)[i] as "inbox",
      exclusive: true,
    }));
    const movable = Array.from({ length: 400 }, (_, i) => `t-${(i * 211) % threadCount}`);
    const clockNow = Date.now();
    const moveDeps = {
      store: reopened.store,
      moveOps: reopened.moveOps,
      uow: reopened.uow,
      now: () => clockNow,
      newId: () => `bench-${Math.random()}`,
    };
    await reopened.store.setFolders("acc1", folders);
    await measure(
      "moveThread: archive a thread of 10 (labels, mailboxes, request, one unit)",
      async (i) => {
        const r = await moveThread(moveDeps, {
          threadId: movable[i % movable.length] as string,
          action: i % 2 === 0 ? "archive" : "delete",
          hidden: true,
        });
        return r.keys.length;
      },
    );
    const last = await moveThread(moveDeps, {
      threadId: movable[0] as string,
      action: "spam",
      hidden: true,
    });
    await measure("undoMove: take an action back", async () => {
      const r = await moveThread(moveDeps, {
        threadId: movable[1] as string,
        action: "move",
        target: { role: "inbox" },
        hidden: true,
      });
      if (r.operationId === null) return 0;
      return (await undoMove({ ...moveDeps, store: reopened.store }, r.operationId)).kind ===
        "undone"
        ? 1
        : 0;
    });
    void last;
    await measure(
      "reapplyPendingMoves: a sync batch with pending moves, nothing to put back",
      async () =>
        (await reapplyPendingMoves({ store: reopened.store, moveOps: reopened.moveOps }, "acc1"))
          .length,
    );
    await measure(
      "reapplyPendingMoves: no pending moves (the usual batch)",
      async () =>
        (
          await reapplyPendingMoves(
            { store: reopened.store, moveOps: { listPending: async () => [] } },
            "acc1",
          )
        ).length,
    );
    // The first sync after the migration changes what a folder is: one statement for the account.
    await measure(
      "setFolders: roles change, mailboxes set again for the account",
      async (i) => {
        const changed = await reopened.store.setFolders(
          "acc1",
          folders.map((f) =>
            f.id === "Junk"
              ? { ...f, role: i % 2 === 0 ? ("other" as const) : ("spam" as const) }
              : f,
          ),
        );
        return changed.length;
      },
      3,
    );
    rawDb.close();

    tuned?.close();
    reopened.close();

    console.log(`\n${MESSAGES} messages, vocabulary ${VOCAB}, ${LABELS.length} labels, file DB\n`);
    console.log(
      "| scenario | median ms | p95 ms | avg hits | warm-up ms | slowest runs (run:ms) |",
    );
    console.log("|---|---:|---:|---:|---:|---|");
    for (const r of rows) {
      console.log(
        `| ${r.name} | ${r.median.toFixed(3)} | ${r.p95.toFixed(3)} | ${r.hits.toFixed(0)} | ${r.warmup.toFixed(1)} | ${r.slowest} |`,
      );
    }
    if (longestSuggest.size > 0) {
      console.log("\nlongest single suggest request per scenario (ms):");
      for (const [name, ms] of longestSuggest) console.log(`  ${name}: ${ms.toFixed(2)}`);
    }
    console.log("\nlongest single countMatches request per scenario (ms):");
    for (const [name, ms] of longest) console.log(`  ${name}: ${ms.toFixed(2)}`);
    const raw = new DatabaseSync(path, { readOnly: true });
    const terms = raw
      .prepare("SELECT COUNT(*) AS n, SUM(LENGTH(term)) AS chars FROM message_terms")
      .get() as {
      n: number;
      chars: number;
    };
    let termPages = "n/a";
    try {
      const pages = raw
        .prepare(
          "SELECT SUM(pgsize) AS b FROM dbstat WHERE name IN ('message_terms', 'sqlite_autoindex_message_terms_1')",
        )
        .get() as { b: number | null };
      if (pages.b !== null) termPages = `${(pages.b / 1024 / 1024).toFixed(2)} MiB`;
    } catch {}
    const peopleRows = raw.prepare("SELECT COUNT(*) AS n FROM people").get() as { n: number };
    const wordRows = raw.prepare("SELECT COUNT(*) AS n FROM people_words").get() as { n: number };
    let peopleSize = "n/a";
    try {
      const sizes = Object.fromEntries(
        (
          raw
            .prepare(
              "SELECT name, SUM(pgsize) AS b FROM dbstat WHERE name IN ('people', 'people_words') GROUP BY name",
            )
            .all() as { name: string; b: number }[]
        ).map((r) => [r.name, `${(r.b / 1024 / 1024).toFixed(2)} MiB`]),
      );
      peopleSize = `people ${sizes.people}, people_words ${sizes.people_words}`;
    } catch {}
    raw.close();
    console.log(
      `\npeople: ${peopleRows.n} rows, people_words: ${wordRows.n} rows; on disk ${peopleSize}`,
    );
    // The v13 and v21 steps, as the first launch after an update would run them: copies of this
    // database without what each adds, migrated in a fresh process so the peak is its own.
    const without21 = `
      DROP TABLE IF EXISTS folders; DROP TABLE IF EXISTS move_operations;
      DROP INDEX IF EXISTS messages_visible; ALTER TABLE messages DROP COLUMN mailboxes;
      DELETE FROM saved_views WHERE id = 'starter-inbox';
      DELETE FROM schema_version WHERE version >= 21;`;
    const migrated = (file: string, variable: string, strip: string) => {
      copyFileSync(path, file);
      const copy = new DatabaseSync(file);
      copy.exec(`${strip} PRAGMA wal_checkpoint(TRUNCATE)`);
      copy.close();
      const child = spawnSync(process.execPath, [process.argv[1] as string], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", [variable]: file },
        encoding: "utf8",
      });
      console.log(child.stdout.trim() || child.stderr.trim());
    };
    migrated(
      join(dir, "v12.db"),
      "BENCH_MIGRATE",
      `DROP TABLE IF EXISTS people; DROP TABLE IF EXISTS people_words;
       DELETE FROM schema_version WHERE version >= 13; ${without21}`,
    );
    migrated(join(dir, "v20.db"), "BENCH_MIGRATE21", without21);
    console.log(
      `\nmessage_terms: ${terms.n} rows, ${terms.chars} characters of text, on disk ${termPages}`,
    );
    console.log(
      `\ninsert (store + index, batches of ${BATCH}): ${(MESSAGES / (insertMs / 1000)).toFixed(0)} msg/s ` +
        `(${(insertMs / 1000).toFixed(1)} s total; store ${(storeMs / 1000).toFixed(1)} s, index ${(indexMs / 1000).toFixed(1)} s)`,
    );
    const mib = (n: number) => (n / 1024 / 1024).toFixed(1);
    console.log(
      `bodies: ${bodyStats.messages} messages in ${bodyStats.blocks} blocks, ` +
        `${mib(bodyRawBytes)} MiB raw -> ${mib(bodyStats.compressedBytes)} MiB zstd-3 per thread block ` +
        `(${(bodyStats.rawBytes / bodyStats.compressedBytes).toFixed(1)}x); ` +
        `per-message zstd-3 on a sample: ${(perMessageRaw / perMessagePacked).toFixed(1)}x; ` +
        `body insert ${(MESSAGES / (bodyMs / 1000)).toFixed(0)} msg/s (${(bodyMs / 1000).toFixed(1)} s)`,
    );
    console.log(
      `db size: ${(size / 1024 / 1024).toFixed(1)} MiB (${(size / MESSAGES).toFixed(0)} B/msg)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.env.BENCH_MIGRATE) {
  const t = performance.now();
  const db = openDatabase(process.env.BENCH_MIGRATE);
  const ms = performance.now() - t;
  const n = (db.prepare("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n;
  db.close();
  console.log(
    `migration 13 backfill (${MESSAGES} messages): ${(ms / 1000).toFixed(2)} s, ${n} people, ` +
      `peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MiB`,
  );
} else if (process.env.BENCH_MIGRATE21) {
  const t = performance.now();
  const db = openDatabase(process.env.BENCH_MIGRATE21);
  const ms = performance.now() - t;
  const n = (
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE mailboxes != 0").get() as { n: number }
  ).n;
  db.close();
  console.log(
    `migration 21 (mailboxes from the labels, the visible index, the tables; ${MESSAGES} messages): ` +
      `${(ms / 1000).toFixed(2)} s, ${n} messages with a place, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MiB`,
  );
} else {
  await main();
}
