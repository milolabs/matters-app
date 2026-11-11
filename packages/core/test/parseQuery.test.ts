import { describe, expect, it } from "vitest";
import {
  isEmptyQuery,
  MAX_QUERY_LIMIT,
  parseQuery,
  promptFilters,
  type QueryContext,
  type QueryNode,
  sortOf,
} from "../src/index.ts";

const prefix = (value: string, field = "any"): QueryNode =>
  ({ kind: "text", field, match: "prefix", value }) as QueryNode;
const phrase = (value: string, field = "any"): QueryNode =>
  ({ kind: "text", field, match: "phrase", value }) as QueryNode;
const and = (...children: QueryNode[]): QueryNode => ({ kind: "and", children });
const or = (...children: QueryNode[]): QueryNode => ({ kind: "or", children });
const not = (child: QueryNode): QueryNode => ({ kind: "not", child });

const root = (q: string, ctx?: QueryContext) => parseQuery(q, ctx).root;
const states = (q: string, ctx?: QueryContext) =>
  parseQuery(q, ctx).tokens.map((t) => [t.kind, t.state]);

const accounts = [
  { id: "a1", address: "jan@example.com", displayName: "Jan Kowalski" },
  { id: "a2", address: "work@acme.org", displayName: "Acme Work" },
];

describe("parseQuery terms", () => {
  it("turns free words into folded prefix nodes", () => {
    expect(root("Faktura Łódź")).toEqual(and(prefix("faktura"), prefix("lodz")));
    expect(root("faktura")).toEqual(prefix("faktura"));
  });

  it("parses quoted phrases", () => {
    expect(root('"Przesłane faktury" umowa')).toEqual(
      and(phrase("przeslane faktury"), prefix("umowa")),
    );
  });

  it("parses field filters", () => {
    expect(
      root('from:Jan to:anna cc:bob subject:"Żółw w Łodzi" label:Inbox has:attachment'),
    ).toEqual(
      and(
        prefix("jan", "from"),
        prefix("anna", "to"),
        prefix("bob", "cc"),
        phrase("zolw w lodzi", "subject"),
        { kind: "label", value: "inbox" },
        { kind: "attachment" },
      ),
    );
  });

  it("splits words of an unquoted value into ANDed prefixes, and keeps an address whole", () => {
    expect(root("subject:e-mail")).toEqual(and(prefix("e", "subject"), prefix("mail", "subject")));
    expect(root("from:jan@example.com")).toEqual(phrase("jan example com", "from"));
    expect(root("subject:jan@example.com")).toEqual(
      and(prefix("jan", "subject"), prefix("example", "subject"), prefix("com", "subject")),
    );
  });

  it("is case-insensitive about field names and treats unknown fields as words", () => {
    expect(root("FROM:Jan")).toEqual(prefix("jan", "from"));
    expect(root("foo:bar")).toEqual(and(prefix("foo"), prefix("bar")));
    expect(root("re:umowa")).toEqual(and(prefix("re"), prefix("umowa")));
  });

  it("accepts a quoted value right after the colon", () => {
    expect(root('from:"jan kowalski"')).toEqual(phrase("jan kowalski", "from"));
    expect(root('label:"My Label"')).toEqual({ kind: "label", value: "my label" });
  });

  it("limits labels to 256 characters", () => {
    const node = root(`label:${"x".repeat(1000)}`);
    expect(node).toEqual({ kind: "label", value: "x".repeat(256) });
  });
});

describe("parseQuery operators", () => {
  it("binds AND tighter than OR, and juxtaposition is AND", () => {
    expect(root("a OR b c")).toEqual(or(prefix("a"), and(prefix("b"), prefix("c"))));
    expect(root("a b OR c")).toEqual(or(and(prefix("a"), prefix("b")), prefix("c")));
    expect(root("a AND b")).toEqual(and(prefix("a"), prefix("b")));
    expect(root("a OR b OR c")).toEqual(or(prefix("a"), prefix("b"), prefix("c")));
  });

  it("makes only uppercase OR, AND and NOT operators", () => {
    expect(root("a or b")).toEqual(and(prefix("a"), prefix("or"), prefix("b")));
    expect(root('a "OR" b')).toEqual(and(prefix("a"), phrase("or"), prefix("b")));
    expect(root("not a")).toEqual(and(prefix("not"), prefix("a")));
  });

  it("groups with brackets", () => {
    expect(root("(a OR b) c")).toEqual(and(or(prefix("a"), prefix("b")), prefix("c")));
    expect(root("((a))")).toEqual(prefix("a"));
    expect(root("a (b (c OR d))")).toEqual(
      and(prefix("a"), prefix("b"), or(prefix("c"), prefix("d"))),
    );
  });

  it("negates with minus or NOT", () => {
    expect(root("-a")).toEqual(not(prefix("a")));
    expect(root("NOT a")).toEqual(not(prefix("a")));
    expect(root("a -b")).toEqual(and(prefix("a"), not(prefix("b"))));
    expect(root("-(a OR b)")).toEqual(not(or(prefix("a"), prefix("b"))));
    expect(root("--a")).toEqual(prefix("a"));
    expect(root("-from:jan")).toEqual(not(prefix("jan", "from")));
    expect(root('-"x y"')).toEqual(not(phrase("x y")));
  });

  it("negates only at the start of a token", () => {
    expect(root("e-mail")).toEqual(and(prefix("e"), prefix("mail")));
    expect(root("a- b")).toEqual(and(prefix("a"), prefix("b")));
  });

  it("lets a lone minus and dangling operators constrain nothing, quietly", () => {
    for (const q of ["-", " -- ", "OR", "NOT", "AND", "a OR", "OR a", "a NOT", "- ", "NOT OR"]) {
      const parsed = parseQuery(q);
      expect(parsed.diagnostics).toEqual([]);
      expect(isEmptyQuery(parsed), q).toBe(!(q === "a OR" || q === "OR a" || q === "a NOT"));
    }
    expect(root("a OR")).toEqual(prefix("a"));
    expect(root("OR a")).toEqual(prefix("a"));
    expect(root("a NOT")).toEqual(prefix("a"));
  });

  it("auto-closes missing brackets and drops stray ones with a diagnostic", () => {
    const open = parseQuery("(a OR (b");
    expect(open.root).toEqual(or(prefix("a"), prefix("b")));
    expect(open.diagnostics).toEqual([]);

    const stray = parseQuery("a ) b");
    expect(stray.root).toEqual(and(prefix("a"), prefix("b")));
    expect(stray.diagnostics).toEqual([
      { code: "stray-close", start: 2, end: 3, message: expect.any(String) },
    ]);
    expect(stray.tokens[1]).toMatchObject({ kind: "close", state: "invalid" });
  });
});

describe("parseQuery field groups", () => {
  it("applies the field to bare words and phrases inside", () => {
    expect(root("from:(jan OR anna)")).toEqual(or(prefix("jan", "from"), prefix("anna", "from")));
    expect(root('subject:(a "b c")')).toEqual(
      and(prefix("a", "subject"), phrase("b c", "subject")),
    );
    expect(root("label:(a OR b)")).toEqual(
      or({ kind: "label", value: "a" }, { kind: "label", value: "b" }),
    );
    expect(root("is:(unread starred)")).toEqual(
      and({ kind: "flag", flag: "unread" }, { kind: "flag", flag: "starred" }),
    );
  });

  it("lets an explicit field inside win", () => {
    expect(root("from:(jan to:anna)")).toEqual(and(prefix("jan", "from"), prefix("anna", "to")));
    expect(root("from:(to:(a))")).toEqual(prefix("a", "to"));
  });

  it("negates inside a field group", () => {
    expect(root("from:(jan -anna)")).toEqual(
      and(prefix("jan", "from"), not(prefix("anna", "from"))),
    );
  });

  it("treats an unknown field inside as words of the group's field", () => {
    expect(root("from:(foo:bar)")).toEqual(and(prefix("foo", "from"), prefix("bar", "from")));
  });

  it("constrains nothing for an empty group", () => {
    expect(isEmptyQuery(parseQuery("from:()"))).toBe(true);
    expect(isEmptyQuery(parseQuery("from:("))).toBe(true);
  });
});

describe("parseQuery tokens", () => {
  it("keeps spans of every token kind", () => {
    const q = 'from:jan -(a OR b) NOT "x y" AND c';
    const spans = parseQuery(q).tokens.map((t) => [t.kind, q.slice(t.start, t.end)]);
    expect(spans).toEqual([
      ["field", "from:jan"],
      ["minus", "-"],
      ["open", "("],
      ["word", "a"],
      ["or", "OR"],
      ["word", "b"],
      ["close", ")"],
      ["not", "NOT"],
      ["phrase", '"x y"'],
      ["and", "AND"],
      ["word", "c"],
    ]);
  });

  it("records the field and where its value starts", () => {
    const [tk] = parseQuery("From:jan").tokens;
    expect(tk).toMatchObject({ kind: "field", field: "from", valueStart: 5, state: "ok" });
    const [quoted] = parseQuery('from:"a b"').tokens;
    expect(quoted).toMatchObject({ start: 0, end: 10, valueStart: 5 });
  });

  it("runs an unbalanced quote to the end", () => {
    const q = parseQuery('"hello wor');
    expect(q.root).toEqual(phrase("hello wor"));
    expect(q.tokens[0]).toMatchObject({ kind: "phrase", start: 0, end: 10 });
  });

  it("marks states: ok, incomplete and invalid", () => {
    expect(states("from:jan")).toEqual([["field", "ok"]]);
    expect(states("from:")).toEqual([["field", "incomplete"]]);
    expect(states("from:***")).toEqual([["field", "incomplete"]]);
    expect(states("is:un")).toEqual([["field", "incomplete"]]);
    expect(states("is:unread")).toEqual([["field", "ok"]]);
    expect(states("is:bogus")).toEqual([["field", "invalid"]]);
    expect(states("after:2026-1")).toEqual([["field", "incomplete"]]);
    expect(states("after:2026-02-30")).toEqual([["field", "invalid"]]);
    expect(states("a OR")).toEqual([
      ["word", "ok"],
      ["or", "incomplete"],
    ]);
    expect(states("- ")).toEqual([["word", "ok"]]);
    expect(states("-a")).toEqual([
      ["minus", "ok"],
      ["word", "ok"],
    ]);
    expect(states("NOT")).toEqual([["not", "incomplete"]]);
    expect(states("a )")).toEqual([
      ["word", "ok"],
      ["close", "invalid"],
    ]);
  });
});

describe("parseQuery enums", () => {
  it("accepts known values, waits on prefixes, rejects the rest", () => {
    for (const flag of ["unread", "read", "starred", "replied", "draft"]) {
      expect(root(`is:${flag}`)).toEqual({ kind: "flag", flag });
    }
    expect(root("IS:Unread")).toEqual({ kind: "flag", flag: "unread" });
    expect(root("has:attachment")).toEqual({ kind: "attachment" });

    for (const q of ["is:", "is:un", "is:s", "has:att", "has:"]) {
      const p = parseQuery(q);
      expect(p.root, q).toBeNull();
      expect(p.diagnostics, q).toEqual([]);
    }
    const bad = parseQuery("is:foo");
    expect(bad.root).toBeNull();
    expect(bad.diagnostics).toEqual([
      { code: "unknown-value", start: 3, end: 6, message: expect.any(String) },
    ]);
    expect(parseQuery("has:photo").diagnostics[0]?.code).toBe("unknown-value");
  });
});

describe("parseQuery dates", () => {
  const ctx = { nowMs: new Date(2026, 10, 4, 15, 30).getTime() };

  it("reads absolute days as local midnight", () => {
    expect(root("after:2024-03-03")).toEqual({ kind: "after", ms: new Date(2024, 2, 3).getTime() });
    expect(root("before:2024-04-01")).toEqual({
      kind: "before",
      ms: new Date(2024, 3, 1).getTime(),
    });
    expect(root("after:2024-03-03 before:2024-04-01")).toEqual(
      and(
        { kind: "after", ms: new Date(2024, 2, 3).getTime() },
        { kind: "before", ms: new Date(2024, 3, 1).getTime() },
      ),
    );
  });

  it("computes relative days from the given now", () => {
    const day = (y: number, m: number, d: number) => new Date(y, m, d).getTime();
    const after = (v: string) => root(`after:${v}`, ctx);
    expect(after("today")).toEqual({ kind: "after", ms: day(2026, 10, 4) });
    expect(after("yesterday")).toEqual({ kind: "after", ms: day(2026, 10, 3) });
    expect(after("-7d")).toEqual({ kind: "after", ms: day(2026, 9, 28) });
    expect(after("-2w")).toEqual({ kind: "after", ms: day(2026, 9, 21) });
    expect(after("-3m")).toEqual({ kind: "after", ms: day(2026, 7, 4) });
    expect(after("-1y")).toEqual({ kind: "after", ms: day(2025, 10, 4) });
    expect(after("-0d")).toEqual({ kind: "after", ms: day(2026, 10, 4) });
  });

  it("clamps months to the last day of the month", () => {
    const now = new Date(2026, 2, 31, 9).getTime();
    expect(root("after:-1m", { nowMs: now })).toEqual({
      kind: "after",
      ms: new Date(2026, 1, 28).getTime(),
    });
    const leap = new Date(2028, 1, 29, 9).getTime();
    expect(root("before:-1y", { nowMs: leap })).toEqual({
      kind: "before",
      ms: new Date(2027, 1, 28).getTime(),
    });
  });

  it("waits on partial forms and rejects the rest", () => {
    for (const v of [
      "",
      "2026",
      "2026-",
      "2026-1",
      "2026-11-0",
      "-",
      "-7",
      "-w",
      "t",
      "tod",
      "yes",
    ]) {
      const p = parseQuery(`after:${v}`, ctx);
      expect(p.root, v).toBeNull();
      expect(p.diagnostics, v).toEqual([]);
    }
    for (const v of [
      "2024-02-30",
      "2024-13-01",
      "tomorrow",
      "24-1-1x",
      "-7x",
      "0000-01-01",
      "-99999999999d",
    ]) {
      const p = parseQuery(`before:${v}`, ctx);
      expect(p.root, v).toBeNull();
      expect(p.diagnostics[0], v).toMatchObject({ code: "invalid-date", start: 7 });
    }
  });
});

describe("parseQuery me and accounts", () => {
  it("expands me into the addresses of the accounts", () => {
    expect(root("from:me", { accounts })).toEqual(
      or(phrase("jan example com", "from"), phrase("work acme org", "from")),
    );
    expect(root("cc:ME", { accounts })).toEqual(
      or(phrase("jan example com", "cc"), phrase("work acme org", "cc")),
    );
    expect(root("-to:me", { accounts: [accounts[0] as (typeof accounts)[0]] })).toEqual(
      not(or(phrase("jan example com", "to"))),
    );
  });

  it("matches nothing without accounts, and leaves quoted me and other fields alone", () => {
    expect(root("from:me")).toEqual(or());
    expect(root('from:"me"')).toEqual(phrase("me", "from"));
    expect(root("subject:me")).toEqual(prefix("me", "subject"));
  });

  it("matches accounts by words of the name and address", () => {
    expect(root("account:jan", { accounts })).toEqual({ kind: "account", ids: ["a1"] });
    expect(root("account:kow ja", { accounts })).toEqual(
      and({ kind: "account", ids: ["a1"] }, prefix("ja")),
    );
    expect(root('account:"acme work"', { accounts })).toEqual({ kind: "account", ids: ["a2"] });
    expect(root("account:example", { accounts })).toEqual({ kind: "account", ids: ["a1"] });
    expect(root("account:(jan OR acme)", { accounts })).toEqual(
      or({ kind: "account", ids: ["a1"] }, { kind: "account", ids: ["a2"] }),
    );
  });

  it("reports an account that matches nothing", () => {
    const p = parseQuery("account:zzz", { accounts });
    expect(p.root).toEqual(or());
    expect(p.diagnostics).toEqual([
      { code: "unknown-value", start: 8, end: 11, message: expect.any(String) },
    ]);
    expect(p.tokens[0]?.state).toBe("invalid");
  });

  it("matches nothing without context accounts, without a diagnostic; waits on empty", () => {
    const p = parseQuery("account:jan");
    expect(p.root).toEqual(or());
    expect(p.diagnostics).toEqual([]);
    expect(parseQuery("account:", { accounts }).root).toBeNull();
    expect(states("account:", { accounts })).toEqual([["field", "incomplete"]]);
  });
});

describe("parseQuery limits", () => {
  it("reports empty queries", () => {
    expect(isEmptyQuery(parseQuery(""))).toBe(true);
    expect(isEmptyQuery(parseQuery('  "" -- ** '))).toBe(true);
    expect(isEmptyQuery(parseQuery("has:attachment"))).toBe(false);
    expect(isEmptyQuery(parseQuery("a"))).toBe(false);
    expect(isEmptyQuery(parseQuery("from:"))).toBe(true);
    expect(isEmptyQuery(parseQuery("is:un"))).toBe(true);
  });

  const countLeaves = (n: QueryNode | null): number =>
    n === null
      ? 0
      : n.kind === "and" || n.kind === "or"
        ? n.children.reduce((s, c) => s + countLeaves(c), 0)
        : n.kind === "not"
          ? countLeaves(n.child)
          : 1;

  it("bounds the number of terms and says so once", () => {
    const p = parseQuery("a ".repeat(50_000));
    expect(countLeaves(p.root)).toBe(32);
    expect(p.diagnostics.filter((d) => d.code === "too-many-terms")).toHaveLength(1);
    expect(p.tokens.filter((t) => t.state === "invalid").length).toBeGreaterThan(0);
    expect(
      countLeaves(
        parseQuery("a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y-z-0-1-2-3-4-5-6-7-8").root,
      ),
    ).toBe(32);
  });

  it("truncates the input to 1024 characters", () => {
    const p = parseQuery(`${"a".repeat(1020)} bbbbbbbbbb`);
    expect(p.tokens.at(-1)?.end).toBeLessThanOrEqual(1024);
  });

  it("allows 8 levels of brackets and drops deeper groups", () => {
    const eight = parseQuery(`${"(".repeat(8)}a${")".repeat(8)}`);
    expect(eight.root).toEqual(prefix("a"));
    expect(eight.diagnostics).toEqual([]);

    const nine = parseQuery(`b ${"(".repeat(9)}a${")".repeat(9)} c`);
    expect(nine.root).toEqual(and(prefix("b"), prefix("c")));
    expect(nine.diagnostics).toEqual([
      { code: "too-deep", start: 10, end: 13, message: expect.any(String) },
    ]);
  });

  it("survives very deep and very long hostile structures", () => {
    for (const q of [
      "(".repeat(100_000),
      ")".repeat(100_000),
      "-".repeat(100_000),
      "NOT ".repeat(100_000),
      "(a OR ".repeat(100_000),
      "from:(".repeat(1000),
    ]) {
      const p = parseQuery(q);
      expect(p.tokens.length).toBeLessThanOrEqual(1024);
    }
  });
});

describe("parseQuery with hostile input", () => {
  const hostile = [
    '"unbalanced',
    'foo" bar',
    '"',
    '""',
    "NEAR(a b, 2)",
    "a NEAR/3 b",
    "a AND b OR c NOT d",
    "NOT",
    "-foo",
    "foo*",
    "*",
    "^foo",
    "(((",
    "))) (a OR b)",
    ":::",
    "from:",
    "from:from:to:",
    "a:b:c:d",
    ':"',
    'subject:"',
    "has:",
    "before:",
    "label:",
    "{}[]\\/",
    "'; DROP TABLE messages;--",
    "\u0000​\ud800",
    "x".repeat(100_000),
    "a ".repeat(50_000),
  ];

  it.each(hostile.map((h) => [h.slice(0, 24), h]))("never throws on %j", (_name, input) => {
    expect(() => parseQuery(input as string)).not.toThrow();
  });

  it("emits only folded letters, digits and spaces in text nodes", () => {
    for (const input of hostile) {
      for (const text of collectText(parseQuery(input, { accounts }).root)) {
        expect(text).toMatch(/^[\p{L}\p{N}]+( [\p{L}\p{N}]+)*$/u);
      }
    }
  });

  it("keeps NEAR and operator-looking text as plain words", () => {
    expect(root("NEAR(a b, 2)")).toEqual(
      and(prefix("near"), prefix("a"), prefix("b"), prefix("2")),
    );
  });
});

function collectText(node: QueryNode | null): string[] {
  if (node === null) return [];
  if (node.kind === "and" || node.kind === "or") return node.children.flatMap(collectText);
  if (node.kind === "not") return collectText(node.child);
  return node.kind === "text" ? [node.value] : [];
}

describe("parseQuery fuzz", () => {
  // Seeded, so a failure reproduces.
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  const pieces = [
    "a",
    "bc",
    "Łódź",
    "from:",
    "to:",
    "cc:",
    "subject:",
    "label:",
    "is:",
    "has:",
    "account:",
    "after:",
    "before:",
    "unread",
    "attachment",
    "2026-01-02",
    "-7d",
    "today",
    "me",
    "@",
    ".",
    "OR",
    "AND",
    "NOT",
    "or",
    "-",
    "--",
    "(",
    ")",
    "((",
    "))",
    '"',
    '""',
    "'",
    "*",
    ":",
    "^",
    " ",
    "  ",
    "\t",
    "\n",
    "\u0000",
    "\ud800",
    "é",
    "😀",
    "12",
    "x@y.z",
    "prompt:",
    'prompt:"',
  ];

  it("never throws; spans stay inside the input and ascend; text stays clean", () => {
    const next = rng(20261104);
    for (let n = 0; n < 3000; n++) {
      let input = "";
      const parts = 1 + Math.floor(next() * 20);
      for (let i = 0; i < parts; i++) input += pieces[Math.floor(next() * pieces.length)] ?? "";
      const q = parseQuery(input, { accounts, nowMs: Date.UTC(2026, 10, 4) });
      let at = 0;
      for (const t of q.tokens) {
        expect(t.start, input).toBeGreaterThanOrEqual(at);
        expect(t.end, input).toBeGreaterThan(t.start);
        expect(t.end, input).toBeLessThanOrEqual(input.length);
        at = t.end;
      }
      for (const d of q.diagnostics) {
        expect(d.start, input).toBeGreaterThanOrEqual(0);
        expect(d.end, input).toBeGreaterThanOrEqual(d.start);
        expect(d.end, input).toBeLessThanOrEqual(input.length);
      }
      for (const text of collectText(q.root)) {
        expect(text, input).toMatch(/^[\p{L}\p{N}]+( [\p{L}\p{N}]+)*$/u);
      }
    }
  });
});

describe("parseQuery prompt (ADR 0116, rule 1)", () => {
  const codes = (q: string, ctx?: QueryContext) =>
    parseQuery(q, ctx).diagnostics.map((d) => d.code);

  it("takes a word or a quoted phrase out of the tree and returns it beside it", () => {
    const p = parseQuery('from:office prompt:"what needs my decision" after:2026-01-01');
    expect(p.prompt).toEqual({ text: "what needs my decision", start: 12, end: 43 });
    expect(p.root).toEqual(
      and(prefix("office", "from"), { kind: "after", ms: new Date(2026, 0, 1).getTime() }),
    );
    expect(p.diagnostics).toEqual([]);
    expect(parseQuery("prompt:invoices").prompt).toMatchObject({ text: "invoices" });
    // Unquoted, only the first word is the prompt; the rest are words of the mail filters.
    const loose = parseQuery("prompt:unpaid invoices");
    expect(loose.prompt?.text).toBe("unpaid");
    expect(loose.root).toEqual(prefix("invoices"));
  });

  it("leaves a query that is only a prompt with no tree, so it behaves like no filter", () => {
    const p = parseQuery('prompt:"what would I regret not seeing"');
    expect(p.root).toBeNull();
    expect(isEmptyQuery(p)).toBe(true);
    expect(p.prompt?.text).toBe("what would I regret not seeing");
    expect(p.tokens).toEqual([
      expect.objectContaining({ kind: "field", field: "prompt", state: "ok", start: 0 }),
    ]);
  });

  it("treats prompt: with no value as unfinished: it constrains nothing", () => {
    for (const q of ["prompt:", 'prompt:""', 'prompt:"  "']) {
      const p = parseQuery(q);
      expect(p.prompt, q).toBeUndefined();
      expect(p.root, q).toBeNull();
      expect(p.diagnostics, q).toEqual([]);
      expect(p.tokens[0]?.state, q).toBe("incomplete");
    }
    // A quote not closed yet is the prompt so far.
    expect(parseQuery('prompt:"what needs').prompt?.text).toBe("what needs");
  });

  it("keeps the first prompt and drops a second one with a diagnostic", () => {
    const p = parseQuery("prompt:first from:anna prompt:second");
    expect(p.prompt?.text).toBe("first");
    expect(p.root).toEqual(prefix("anna", "from"));
    expect(p.diagnostics).toEqual([
      { code: "prompt-twice", start: 23, end: 36, message: "Only one prompt per query" },
    ]);
    expect(p.tokens.at(-1)?.state).toBe("invalid");
  });

  it("drops a negated prompt, and keeps the rest of the query", () => {
    for (const q of ["-prompt:x from:anna", "NOT prompt:x from:anna", "-(prompt:x) from:anna"]) {
      const p = parseQuery(q);
      expect(p.prompt, q).toBeUndefined();
      expect(codes(q), q).toEqual(["prompt-negated"]);
      expect(p.root, q).toEqual(prefix("anna", "from"));
    }
    // Two negations cancel, as they do for any term.
    expect(parseQuery("NOT NOT prompt:x").prompt?.text).toBe("x");
  });

  it("drops a prompt under OR, at any depth", () => {
    for (const q of [
      "prompt:x OR from:anna",
      "from:anna OR (prompt:x subject:y)",
      "(a OR prompt:x) b",
    ]) {
      expect(parseQuery(q).prompt, q).toBeUndefined();
      expect(codes(q), q).toEqual(["prompt-or"]);
    }
    // Brackets alone are no OR.
    expect(parseQuery("(prompt:x from:anna) b").prompt?.text).toBe("x");
  });

  it("drops prompt:( … ) up to its closing bracket and parses what follows", () => {
    const p = parseQuery("prompt:(a OR (b c)) from:anna");
    expect(p.prompt).toBeUndefined();
    expect(p.root).toEqual(prefix("anna", "from"));
    expect(p.diagnostics).toEqual([
      {
        code: "prompt-group",
        start: 0,
        end: 19,
        message: "A prompt is a word or a quoted phrase, not a group",
      },
    ]);
    expect(states("prompt:(a) b")).toEqual([
      ["field", "invalid"],
      ["open", "invalid"],
      ["word", "invalid"],
      ["close", "invalid"],
      ["word", "ok"],
    ]);
  });

  it("reports a prompt while AI is off, and drops it (rule 11)", () => {
    const p = parseQuery("from:anna prompt:x", { promptOff: true });
    expect(p.prompt).toBeUndefined();
    expect(p.root).toEqual(prefix("anna", "from"));
    expect(p.diagnostics).toEqual([
      { code: "prompt-off", start: 10, end: 18, message: "AI is off, so the prompt does nothing" },
    ]);
  });

  it("spends no term of the budget", () => {
    const words = Array.from({ length: 32 }, (_, i) => `w${i}`).join(" ");
    const p = parseQuery(`${words} prompt:x`);
    expect(p.prompt?.text).toBe("x");
    expect(p.diagnostics).toEqual([]);
  });
});

describe("parseQuery limit (ADR 0116, rule 4a)", () => {
  const codes = (q: string) => parseQuery(q).diagnostics.map((d) => d.code);

  it("takes a whole number out of the tree and returns it beside it, with or without a prompt", () => {
    const p = parseQuery('from:office limit:50 prompt:"what needs my decision"');
    expect(p.limit).toEqual({ n: 50, start: 12, end: 20 });
    expect(p.prompt?.text).toBe("what needs my decision");
    expect(p.root).toEqual(prefix("office", "from"));
    expect(p.diagnostics).toEqual([]);
    const alone = parseQuery("limit:5");
    expect(alone.limit?.n).toBe(5);
    expect(alone.root).toBeNull();
    expect(alone.diagnostics).toEqual([]);
    expect(parseQuery("from:anna limit:007").limit?.n).toBe(7);
    expect(parseQuery(`limit:${MAX_QUERY_LIMIT * 10}`).limit?.n).toBe(MAX_QUERY_LIMIT);
  });

  it("reports a value that is not a whole number above 0, and constrains nothing", () => {
    for (const q of ["limit:0", "limit:-3", "limit:1.5", "limit:ten", 'limit:"5 6"']) {
      const p = parseQuery(`from:anna ${q}`);
      expect(p.limit, q).toBeUndefined();
      expect(codes(`from:anna ${q}`), q).toEqual(["invalid-limit"]);
      expect(p.root, q).toEqual(prefix("anna", "from"));
    }
    expect(parseQuery("limit:x").diagnostics[0]?.message).toBe('Not a whole number above 0: "x"');
  });

  it("treats limit: with no value as unfinished", () => {
    const p = parseQuery("limit:");
    expect(p.limit).toBeUndefined();
    expect(p.diagnostics).toEqual([]);
    expect(p.tokens[0]?.state).toBe("incomplete");
  });

  it("keeps one: a second, a negated one, one under OR and limit:( … ) are dropped and reported", () => {
    const twice = parseQuery("limit:5 from:anna limit:9");
    expect(twice.limit?.n).toBe(5);
    expect(twice.diagnostics.map((d) => d.code)).toEqual(["limit-twice"]);
    expect(twice.tokens.at(-1)?.state).toBe("invalid");
    for (const q of ["-limit:5 from:anna", "NOT limit:5 from:anna"]) {
      expect(parseQuery(q).limit, q).toBeUndefined();
      expect(codes(q), q).toEqual(["limit-negated"]);
    }
    for (const q of ["limit:5 OR from:anna", "from:anna OR (limit:5 b)"]) {
      expect(parseQuery(q).limit, q).toBeUndefined();
      expect(codes(q), q).toEqual(["limit-or"]);
    }
    const group = parseQuery("limit:(5) from:anna");
    expect(group.limit).toBeUndefined();
    expect(group.root).toEqual(prefix("anna", "from"));
    expect(group.diagnostics.map((d) => d.code)).toEqual(["limit-group"]);
  });

  it("spends no term of the budget", () => {
    const words = Array.from({ length: 32 }, (_, i) => `w${i}`).join(" ");
    expect(parseQuery(`${words} limit:3`).diagnostics).toEqual([]);
  });
});

describe("parseQuery sort (ADR 0116, rule 4b)", () => {
  const codes = (q: string, ctx: QueryContext = {}) =>
    parseQuery(q, ctx).diagnostics.map((d) => d.code);

  it("takes a known order out of the tree and returns it beside it", () => {
    const p = parseQuery("from:office sort:oldest limit:10");
    expect(p.sort).toEqual({ value: "oldest", start: 12, end: 23 });
    expect(p.root).toEqual(prefix("office", "from"));
    expect(p.limit?.n).toBe(10);
    expect(p.diagnostics).toEqual([]);
    expect(parseQuery("SORT:Newest").sort?.value).toBe("newest");
    const alone = parseQuery("sort:oldest");
    expect(alone.sort?.value).toBe("oldest");
    expect(alone.root).toBeNull();
    expect(isEmptyQuery(alone)).toBe(true);
    expect(parseQuery("invoice sort:relevance").sort?.value).toBe("relevance");
    expect(parseQuery('prompt:"x" sort:fit').sort?.value).toBe("fit");
  });

  it("defaults to newest without a prompt and to fit with one", () => {
    expect(sortOf(parseQuery("from:anna"))).toBe("newest");
    expect(sortOf(parseQuery('from:anna prompt:"x"'))).toBe("fit");
    expect(sortOf(parseQuery('prompt:"x" sort:oldest'))).toBe("oldest");
    expect(parseQuery("from:anna").sort).toBeUndefined();
  });

  it("reports an unknown value as any enum does, and treats a start of one as unfinished", () => {
    const bad = parseQuery("from:anna sort:sideways");
    expect(bad.sort).toBeUndefined();
    expect(codes("from:anna sort:sideways")).toEqual(["unknown-value"]);
    expect(bad.diagnostics[0]?.message).toBe('Unknown value "sideways"');
    expect(bad.tokens.at(-1)?.state).toBe("invalid");
    // `matters` is not an order: unknown, whether AI is on or off.
    for (const promptOff of [false, true]) {
      const matters = parseQuery("invoice sort:matters", { promptOff });
      expect(matters.sort).toBeUndefined();
      expect(matters.diagnostics).toEqual([
        { code: "unknown-value", start: 13, end: 20, message: 'Unknown value "matters"' },
      ]);
      expect(matters.tokens.at(-1)?.state).toBe("invalid");
    }
    for (const q of ["sort:", "sort:ol", "sort:r"]) {
      const p = parseQuery(q);
      expect(p.sort, q).toBeUndefined();
      expect(p.diagnostics, q).toEqual([]);
      expect(p.tokens[0]?.state, q).toBe("incomplete");
    }
  });

  it("keeps one at the top level: a second, a negated one, one under OR and sort:( … ) are dropped", () => {
    const twice = parseQuery("sort:oldest from:anna sort:newest");
    expect(twice.sort?.value).toBe("oldest");
    expect(twice.diagnostics.map((d) => d.code)).toEqual(["sort-twice"]);
    expect(twice.tokens.at(-1)?.state).toBe("invalid");
    for (const q of ["-sort:oldest from:anna", "NOT sort:oldest from:anna"]) {
      expect(parseQuery(q).sort, q).toBeUndefined();
      expect(codes(q), q).toEqual(["sort-negated"]);
    }
    for (const q of ["sort:oldest OR from:anna", "from:anna OR (sort:oldest b)"]) {
      expect(parseQuery(q).sort, q).toBeUndefined();
      expect(codes(q), q).toEqual(["sort-or"]);
    }
    const group = parseQuery("sort:(oldest) from:anna");
    expect(group.sort).toBeUndefined();
    expect(group.root).toEqual(prefix("anna", "from"));
    expect(codes("sort:(oldest) from:anna")).toEqual(["sort-group"]);
  });

  it("drops fit without a prompt, and relevance with no words", () => {
    const fit = parseQuery("from:anna sort:fit");
    expect(fit.sort).toBeUndefined();
    expect(codes("from:anna sort:fit")).toEqual(["sort-fit"]);
    expect(fit.tokens.at(-1)?.state).toBe("invalid");
    // A prompt dropped for AI off says so itself; the order goes with it.
    expect(codes('prompt:"x" sort:fit', { promptOff: true })).toEqual(["prompt-off"]);
    // Words to rank by: a text term that is not excluded.
    for (const q of ["is:unread has:attachment sort:relevance", "-invoice sort:relevance"]) {
      expect(parseQuery(q).sort, q).toBeUndefined();
      expect(codes(q), q).toEqual(["sort-no-words"]);
    }
    expect(parseQuery("sort:relevance").diagnostics[0]?.message).toBe(
      "No words to rank by, so the list stays by date",
    );
    expect(parseQuery("from:anna sort:relevance").sort?.value).toBe("relevance");
    expect(parseQuery("(invoice OR receipt) is:unread sort:relevance").sort?.value).toBe(
      "relevance",
    );
    // With a prompt the rank is the search's own: no words needed.
    expect(parseQuery('is:unread prompt:"x" sort:relevance').sort?.value).toBe("relevance");
    // AI off drops a prompt, not a ranked order without one.
    expect(parseQuery("invoice sort:relevance", { promptOff: true }).sort?.value).toBe("relevance");
  });

  it("spends no term of the budget, and is not part of a prompt's mail filters", () => {
    const words = Array.from({ length: 32 }, (_, i) => `w${i}`).join(" ");
    expect(parseQuery(`${words} sort:oldest`).diagnostics).toEqual([]);
    const q = 'from:office sort:oldest prompt:"x" limit:5';
    expect(promptFilters(q, parseQuery(q))).toBe("from:office");
    const r = 'sort:newest from:office prompt:"x"';
    expect(promptFilters(r, parseQuery(r))).toBe("from:office");
  });
});
