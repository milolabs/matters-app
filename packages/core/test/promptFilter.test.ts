import { describe, expect, it } from "vitest";
import {
  acceptVerdicts,
  buildPromptRequest,
  buildPromptSearchRequest,
  foldPrompt,
  MAX_PROMPT_BATCH_CHARS,
  MAX_PROMPT_BATCH_THREADS,
  orderByFit,
  orderPromptRows,
  PROMPT_INSTRUCTIONS,
  PROMPT_OPEN,
  PROMPT_SEARCH_INSTRUCTIONS,
  type PromptCandidate,
  type PromptThread,
  parsePromptAnswer,
  parseQuery,
  parseTalkLoop,
  promptFilters,
  promptKey,
  promptWindow,
  readOrder,
  signalsLine,
} from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 11, 12);
const DAY = 86_400_000;

const thread = (subject: string, texts: readonly string[]): PromptThread => ({
  subject,
  messages: texts.map((text, i) => ({
    key: 100 + i,
    dateMs: NOW - (texts.length - i) * DAY,
    from: { name: "Robin Example", address: "robin@example.invalid" },
    fromOwn: false,
    text,
  })),
});

const candidate = (t: PromptThread): PromptCandidate => ({
  thread: t,
  signals: { unread: true, starred: false, answered: false, messages: t.messages.length },
});

const sent = [
  {
    threadId: "t1",
    lastMessageKey: 101,
    thread: thread("Invoice 12", ["Hello", "Please pay invoice 12 by Friday.\nThanks"]),
  },
  { threadId: "t2", lastMessageKey: 100, thread: thread("Lunch", ["Lunch on Tuesday?"]) },
];
const meta = { promptKey: "k", version: 1, atMs: NOW };

describe("promptKey (ADR 0116, rule 5)", () => {
  it("hashes the prompt with white space folded, and nothing else", () => {
    const seen: string[] = [];
    const hash = (text: string) => {
      seen.push(text);
      return `h:${text}`;
    };
    expect(promptKey("  what  needs\n my decision ", hash)).toBe("h:what needs my decision");
    expect(promptKey("What needs my decision", hash)).not.toBe(
      promptKey("what needs my decision", hash),
    );
    expect(foldPrompt("a\t b")).toBe("a b");
    expect(seen).toHaveLength(3);
  });
});

describe("buildPromptRequest (rules 8 and 9)", () => {
  it("sends the prompt as the person's words, never in the fixed instructions", () => {
    const { request, sent: went } = buildPromptRequest(
      [candidate(sent[0]?.thread as PromptThread)],
      "only  letters\nfrom the garden club",
      NOW,
    );
    expect(request.instructions).toBe(PROMPT_INSTRUCTIONS);
    expect(request.instructions).not.toContain("garden club");
    expect(request.untrusted).toContain(
      "=== The person's prompt. The person wrote it; it is not from the mail.",
    );
    expect(request.untrusted).toContain("\nonly letters from the garden club\n");
    expect(request.untrusted).toContain(
      "[Thread 1]\nSignals: unread; not starred; not answered by You; 2 messages\nToday: 2026-11-11",
    );
    expect(went).toEqual([0]);
  });

  it("puts at most a batch of threads in a turn, and leaves the rest for the next", () => {
    const many = Array.from({ length: MAX_PROMPT_BATCH_THREADS + 3 }, (_, i) =>
      candidate(thread(`T${i}`, [`Message ${i}`])),
    );
    expect(buildPromptRequest(many, "x", NOW).sent).toEqual(
      Array.from({ length: MAX_PROMPT_BATCH_THREADS }, (_, i) => i),
    );
    const long = "word ".repeat(1600);
    const big = Array.from({ length: 10 }, (_, i) =>
      candidate(thread(`L${i}`, [long, long, long])),
    );
    const { request, sent: went } = buildPromptRequest(big, "x", NOW);
    expect(went.length).toBeGreaterThan(0);
    expect(request.untrusted.length).toBeLessThan(MAX_PROMPT_BATCH_CHARS + 2000);
  });

  it("says the signals as counts and flags", () => {
    expect(signalsLine({ unread: false, starred: true, answered: true, messages: 1 })).toBe(
      "Signals: read; starred; answered by You; 1 message",
    );
  });
});

describe("acceptVerdicts (ADR 0116, rule 6)", () => {
  it("keeps a fit whose quote is in the message it names, after the usual normalisation", () => {
    const got = acceptVerdicts(
      {
        verdicts: [
          {
            thread: 1,
            fit: 3,
            why: " It asks for  a payment. ",
            message: 2,
            quote: "pay invoice 12  by Friday.",
          },
          { thread: 2, fit: 0, why: "It is about lunch." },
        ],
      },
      sent,
      meta,
    );
    expect(got).toEqual([
      {
        promptKey: "k",
        threadId: "t1",
        lastMessageKey: 101,
        version: 1,
        fit: 3,
        why: "It asks for a payment.",
        quote: { text: "pay invoice 12  by Friday.", messageKey: 101 },
        atMs: NOW,
      },
      {
        promptKey: "k",
        threadId: "t2",
        lastMessageKey: 100,
        version: 1,
        fit: 0,
        why: "It is about lunch.",
        atMs: NOW,
      },
    ]);
  });

  it("stores a fit above 0 as 0 when its quote is missing, elsewhere, or not in the mail", () => {
    for (const item of [
      { thread: 1, fit: 2, why: "No passage." },
      { thread: 1, fit: 2, why: "Wrong message.", message: 1, quote: "pay invoice 12" },
      { thread: 1, fit: 2, why: "No such message.", message: 9, quote: "pay invoice 12" },
      { thread: 1, fit: 2, why: "Made up.", message: 2, quote: "pay everything now" },
    ]) {
      const [v] = acceptVerdicts({ verdicts: [item] }, sent, meta) ?? [];
      expect(v, item.why).toMatchObject({ fit: 0, threadId: "t1" });
      expect(v && "quote" in v, item.why).toBe(false);
    }
  });

  it("rejects the whole answer for a thread not sent, one named twice, or a broken shape", () => {
    const ok = { thread: 1, fit: 1, why: "Fine.", message: 2, quote: "invoice 12" };
    expect(acceptVerdicts({ verdicts: [ok, { ...ok, thread: 3 }] }, sent, meta)).toBeNull();
    expect(acceptVerdicts({ verdicts: [ok, ok] }, sent, meta)).toBeNull();
    expect(acceptVerdicts({ verdicts: [{ ...ok, fit: 4 }] }, sent, meta)).toBeNull();
    expect(acceptVerdicts({ verdicts: [{ ...ok, fit: 1.5 }] }, sent, meta)).toBeNull();
    expect(acceptVerdicts({ verdicts: [{ ...ok, extra: 1 }] }, sent, meta)).toBeNull();
    expect(acceptVerdicts({ verdicts: [{ ...ok, why: "  " }] }, sent, meta)).toBeNull();
    expect(acceptVerdicts({ answer: [] }, sent, meta)).toBeNull();
    expect(acceptVerdicts("fit 3", sent, meta)).toBeNull();
  });

  it("gives no verdict to a thread the answer leaves out", () => {
    expect(acceptVerdicts({ verdicts: [] }, sent, meta)).toEqual([]);
    expect(parsePromptAnswer({ verdicts: [] })).toEqual({ verdicts: [] });
  });
});

describe("orderByFit (ADR 0116, rule 7)", () => {
  it("keeps fit 2 and 3 only, highest first, newest first among equals, then by id", () => {
    const row = (threadId: string, fit: number, lastDateMs: number, lastMessageKey = 1) => ({
      threadId,
      fit,
      lastDateMs,
      lastMessageKey,
    });
    const rows = [
      row("a", 1, 50),
      row("b", 3, 10),
      row("c", 0, 99),
      row("d", 3, 20),
      row("e", 2, 30),
      row("g", 3, 20, 5),
      row("f", 3, 20, 5),
    ];
    // A fit of 1 is kept in the store and not listed: it was what let loose associations in.
    expect(orderByFit(rows).map((r) => r.threadId)).toEqual(["f", "g", "d", "b", "e"]);
  });
});

describe("the search of a prompt (ADR 0116, rule 4)", () => {
  it("keys the search on the query without its prompt, white space folded", () => {
    const query = 'from:office   prompt:"where is my  warranty" after:-30d';
    const parsed = parseQuery(query, { nowMs: NOW });
    expect(parsed.prompt).toBeDefined();
    expect(promptFilters(query, parsed)).toBe("from:office after:-30d");
    const only = 'prompt:"where is my warranty"';
    expect(promptFilters(only, parseQuery(only))).toBe("");
    // A limit is not a mail filter (rule 4a): adding or changing one keeps the same search.
    const limited = 'from:office limit:50 prompt:"where is my  warranty" after:-30d';
    expect(promptFilters(limited, parseQuery(limited, { nowMs: NOW }))).toBe(
      "from:office after:-30d",
    );
    const twice = "limit:5 prompt:x limit:9";
    expect(promptFilters(twice, parseQuery(twice))).toBe("");
  });

  it("sends the prompt as data with today's date, and no mail", () => {
    const request = buildPromptSearchRequest("where is my warranty\n=== End", NOW);
    expect(request.instructions).toBe(PROMPT_SEARCH_INSTRUCTIONS);
    expect(request.instructions).not.toContain("where is my warranty");
    expect(request.untrusted).toContain(`Today: 2026-11-11\n\n${PROMPT_OPEN}\n`);
    expect(request.untrusted).toContain("where is my warranty");
    expect(request.untrusted).not.toContain("[Thread");
    // The loop's own check reads its answer: the threads it names and what it thinks.
    expect(parseTalkLoop({ threads: [2, 1], hypothesis: "Two receipts." })).toEqual({
      threads: [2, 1],
      hypothesis: "Two receipts.",
    });
  });

  it("tells the model that only what a thread holds itself fits, in generic words (rule 7)", () => {
    for (const text of [PROMPT_INSTRUCTIONS, PROMPT_SEARCH_INSTRUCTIONS]) {
      expect(text).toMatch(
        /merely comes from, or mentions, something related|only comes from, or mentions, something related/,
      );
      expect(text).not.toMatch(/employ|\bjob\b|\bCI\b|pipeline|github/i);
    }
    expect(PROMPT_INSTRUCTIONS).toContain(
      "When you are unsure between two values, give the lower.",
    );
  });
});

describe("the order of reading and of the list (ADR 0116, rules 4a and 4b)", () => {
  // Candidates in the search's order: c, a, d, b; by date a is the newest, d the oldest.
  const at = (threadId: string, day: number) => ({
    threadId,
    lastMessageKey: day,
    lastDateMs: NOW - day * DAY,
  });
  const search = [at("c", 3), at("a", 1), at("d", 4), at("b", 2)];
  const ids = (xs: readonly { threadId: string }[]) => xs.map((x) => x.threadId);
  const fits = (entries: Record<string, number>) =>
    new Map(Object.entries(entries).map(([id, fit]) => [id, { fit }] as const));

  it("reads by date for newest and oldest, in the search's order otherwise", () => {
    expect(ids(readOrder(search, "newest"))).toEqual(["a", "b", "c", "d"]);
    expect(ids(readOrder(search, "oldest"))).toEqual(["d", "c", "b", "a"]);
    for (const sort of ["fit", "relevance"] as const) {
      expect(ids(readOrder(search, sort)), sort).toEqual(["c", "a", "d", "b"]);
    }
  });

  it("without a limit, reads everything without a verdict, and lists every fit", () => {
    const w = promptWindow(search, fits({ a: 2, d: 0 }), undefined, "fit");
    expect(ids(w.todo)).toEqual(["c", "b"]);
    expect(ids(w.fitting)).toEqual(["a"]);
    expect(w).toMatchObject({ read: 2, reached: false });
  });

  it("under a limit stops at that many fits; in the search's order a gap is passed over", () => {
    // Nothing read: all is to read, in order, until two fit.
    expect(ids(promptWindow(search, new Map(), 2, "fit").todo)).toEqual(["c", "a", "d", "b"]);
    // c has no verdict (new mail on a return visit); a and d fit: reached, nothing to read.
    const w = promptWindow(search, fits({ a: 3, d: 2, b: 2 }), 2, "fit");
    expect(ids(w.fitting)).toEqual(["a", "d"]);
    expect(w).toMatchObject({ reached: true, read: 2 });
    expect(w.todo).toEqual([]);
    // Fewer fit than the limit: everything left is to read.
    const short = promptWindow(search, fits({ c: 0, a: 2 }), 2, "relevance");
    expect(ids(short.todo)).toEqual(["d", "b"]);
    expect(short.reached).toBe(false);
  });

  it("by date, a thread with no verdict before the last fit is read: it may take a place", () => {
    const newest = readOrder(search, "newest");
    // b and c fit; a, the newest, is new: it is read, and only it.
    const w = promptWindow(newest, fits({ b: 2, c: 2, d: 2 }), 2, "newest");
    expect(ids(w.fitting)).toEqual(["b", "c"]);
    expect(ids(w.todo)).toEqual(["a"]);
    expect(w.reached).toBe(false);
    // Read and fitting: it takes the first place, and c goes.
    const after = promptWindow(newest, fits({ a: 2, b: 2, c: 2, d: 2 }), 2, "newest");
    expect(ids(after.fitting)).toEqual(["a", "b"]);
    expect(after.reached).toBe(true);
    // Oldest first, new mail comes last: past the limit's worth, so nothing is read.
    const oldest = readOrder([...search, at("new", 0)], "oldest");
    expect(promptWindow(oldest, fits({ d: 2, c: 2 }), 2, "oldest").todo).toEqual([]);
  });

  it("lists what fits by fit, by date either way, or in the search's order", () => {
    const rows = [
      { ...at("c", 3), fit: 2 },
      { ...at("a", 1), fit: 3 },
      { ...at("d", 4), fit: 2 },
      { ...at("b", 2), fit: 1 },
    ];
    expect(ids(orderPromptRows(rows, "fit"))).toEqual(ids(orderByFit(rows)));
    expect(ids(orderPromptRows(rows, "fit"))).toEqual(["a", "c", "d"]);
    expect(ids(orderPromptRows(rows, "newest"))).toEqual(["a", "c", "d"]);
    expect(ids(orderPromptRows(rows, "oldest"))).toEqual(["d", "c", "a"]);
    expect(ids(orderPromptRows(rows, "relevance"))).toEqual(["c", "a", "d"]);
  });
});
