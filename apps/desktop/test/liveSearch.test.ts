import type { FileHit, Message, PersonSuggestion } from "@matters/core";
import { parseQuery } from "@matters/core";
import { makeMessage } from "@matters/testkit";
import { describe, expect, it, vi } from "vitest";
import {
  liveCount,
  noThreadMatches,
  type PanelInput,
  panelGroups,
  personEdit,
  pills,
  togglePill,
} from "../src/renderer/livePanel.ts";
import {
  askLive,
  createCoalescer,
  freeWords,
  type LiveAnswer,
  peopleRows,
  queryHitWords,
  threadRows,
  wantsLive,
} from "../src/renderer/liveSearch.ts";
import { removeField, removeFilter } from "../src/renderer/queryEdits.ts";
import { querySuggestions } from "../src/renderer/querySuggestions.ts";

const msg = (key: number, over: Partial<Message> = {}): Message =>
  makeMessage({ key, providerId: `p${key}`, threadId: `t${key}`, dateMs: key * 1000, ...over });

const words = (text: string) => freeWords(text, parseQuery(text));

describe("freeWords", () => {
  it("takes plain words and phrases, not fields, negated words or field groups", () => {
    expect(words("faktura from:anna")).toEqual(["faktura"]);
    expect(words('"umowa najmu" -stary is:unread')).toEqual(["umowa najmu"]);
    expect(words("from:(anna bob) kraków")).toEqual(["kraków"]);
    expect(words("from:")).toEqual([]);
    expect(words("")).toEqual([]);
  });

  it("wants live results from one real word", () => {
    expect(wantsLive(words("f"))).toBe(false);
    expect(wantsLive(words("fa"))).toBe(true);
    expect(wantsLive(words("from:a"))).toBe(false);
  });
});

describe("queryHitWords", () => {
  it("is the free words, folded and longest first", () => {
    expect(queryHitWords("Faktura from:anna has:attachment label:work")).toEqual(["faktura"]);
    expect(queryHitWords("zażółć fak")).toEqual(["zazolc", "fak"]);
  });

  it("leaves out operators, negation and the value of any field", () => {
    expect(queryHitWords("faktura OR umowa")).toEqual(["faktura", "umowa"]);
    expect(queryHitWords("faktura -stary")).toEqual(["faktura"]);
    expect(queryHitWords("faktura NOT stary")).toEqual(["faktura"]);
    expect(queryHitWords("(faktura umowa) from:(anna bob)")).toEqual(["faktura", "umowa"]);
    expect(queryHitWords("faktura -(stary nowy) listopad")).toEqual(["listopad", "faktura"]);
    expect(queryHitWords("is:unread after:2026-01-01 subject:umowa")).toEqual([]);
  });

  it("keeps a quoted phrase as one phrase", () => {
    expect(queryHitWords('"umowa najmu" -stary')).toEqual(["najmu", "umowa"]);
    expect(freeWords('"umowa najmu" faktura', parseQuery('"umowa najmu" faktura'))).toEqual([
      "umowa najmu",
      "faktura",
    ]);
  });

  it("is empty for nothing to find", () => {
    expect(queryHitWords("")).toEqual([]);
    expect(queryHitWords("   ")).toEqual([]);
    expect(queryHitWords("from:")).toEqual([]);
    expect(queryHitWords("--")).toEqual([]);
  });
});

describe("threadRows", () => {
  it("gives one row per thread, newest first, at most four", () => {
    const rows = threadRows([
      msg(10, { threadId: "a" }),
      msg(30, { threadId: "a" }),
      msg(20, { threadId: "b" }),
      msg(5, { threadId: "c" }),
      msg(4, { threadId: "d" }),
      msg(3, { threadId: "e" }),
    ]);
    expect(rows.map((r) => [r.threadId, r.message.key])).toEqual([
      ["a", 30],
      ["b", 20],
      ["c", 5],
      ["d", 4],
    ]);
  });
});

describe("peopleRows", () => {
  const anna: PersonSuggestion = { name: "Anna Nowak", address: "anna@x.pl", count: 12 };
  const own = new Set(["me@x.pl"]);

  it("lists who matches the words, then the senders of the threads, never the reader", () => {
    const threads = threadRows([
      msg(3, { threadId: "a", from: { name: "Bob", address: "bob@x.pl" } }),
      msg(2, { threadId: "b", from: { address: "me@x.pl" } }),
      msg(1, { threadId: "c", from: { name: "Anna Nowak", address: "ANNA@x.pl" } }),
    ]);
    const rows = peopleRows([anna, { address: "me@x.pl", count: 9 }], threads, ["anna"], own, 5);
    expect(rows.map((r) => r.address)).toEqual(["anna@x.pl", "bob@x.pl"]);
    expect(rows[0]).toMatchObject({ messages: 12, threads: 1 });
    expect(rows[1]).toMatchObject({ threads: 1 });
  });

  it("drops a suggested person the words do not name, and caps at two", () => {
    const rows = peopleRows(
      [anna, { name: "Carol", address: "carol@x.pl", count: 1 }],
      threadRows([
        msg(3, { threadId: "a", from: { address: "b@x.pl" } }),
        msg(2, { threadId: "b", from: { address: "c@x.pl" } }),
      ]),
      ["anna"],
      own,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.address)).toEqual(["anna@x.pl", "b@x.pl"]);
  });
});

function input(text: string, over: Partial<PanelInput> = {}): PanelInput {
  const parsed = parseQuery(text);
  const w = wantsLive(freeWords(text, parsed)) ? freeWords(text, parsed) : [];
  return {
    text,
    parsed,
    groups: querySuggestions(text, text.length, parsed, {
      labels: [],
      accounts: [],
      people: [],
    }),
    live: null,
    words: w,
    own: new Set(),
    canAsk: true,
    ...over,
  };
}

const answer = (text: string, over: Partial<LiveAnswer> = {}): LiveAnswer => ({
  text,
  words: freeWords(text, parseQuery(text)),
  threads: threadRows([msg(3), msg(2)]),
  people: [{ name: "Faktury Sp.", address: "faktury@x.pl", count: 4 }],
  files: [
    {
      messageKey: 3,
      partId: "2",
      fileName: "Faktura_1.pdf",
      sizeBytes: 1200,
      contentType: "application/pdf",
      threadId: "t3",
      accountId: "a",
      sender: { address: "faktury@x.pl" },
      dateMs: 3000,
    } satisfies FileHit,
  ],
  ...over,
});

describe("panelGroups", () => {
  it("puts Threads, People, Files and the ask row first, then the suggestions of syntax", () => {
    const text = "faktura";
    const g = panelGroups(input(text, { live: answer(text) }));
    expect(g.map((x) => x.title)).toEqual(["Threads", "People", "Files", "Ask"]);
    expect(g.filter((x) => x.live).map((x) => x.title)).toEqual([
      "Threads",
      "People",
      "Files",
      "Ask",
    ]);
    const ask = g.find((x) => x.title === "Ask")?.items[0];
    expect(ask).toEqual({ kind: "ask", text: "faktura" });
    expect(liveCount(g)).toBe(2 + 1 + 1);
  });

  it("leaves out the ask row without AI, and the live groups for an answer to older text", () => {
    const text = "faktura";
    const noAi = panelGroups(input(text, { live: answer(text), canAsk: false }));
    expect(noAi.map((x) => x.title)).not.toContain("Ask");
    const stale = panelGroups(input("faktura 2", { live: answer("faktura") }));
    expect(stale.map((x) => x.title)).toEqual(["Ask"]);
  });

  it("is today's panel for an empty bar and for a field being typed", () => {
    expect(panelGroups(input("")).every((x) => !x.live)).toBe(true);
    const field = panelGroups(input("from:an"));
    expect(field.every((x) => !x.live)).toBe(true);
    expect(field.map((x) => x.title)).not.toContain("Ask");
  });

  it("says no thread matches only for the answer to this text", () => {
    const text = "zzzz";
    const none = answer(text, { threads: [], people: [], files: [] });
    expect(noThreadMatches(input(text, { live: none }))).toBe(true);
    expect(noThreadMatches(input(text, { live: answer("zzz", { threads: [] }) }))).toBe(false);
    expect(noThreadMatches(input(""))).toBe(false);
    expect(panelGroups(input(text, { live: none })).map((x) => x.title)).toEqual(["Ask"]);
  });

  it("replaces the people suggested for the word with the live people", () => {
    const text = "anna";
    const g = panelGroups(
      input(text, {
        live: answer(text),
        groups: [
          { title: "People", items: [] },
          { title: "Filters", items: [] },
        ],
      }),
    );
    expect(g.filter((x) => x.title === "People")).toHaveLength(1);
  });
});

describe("personEdit", () => {
  const row = { name: "Anna Nowak", address: "anna@x.pl" };

  it("replaces the words that only found the person with from:", () => {
    const text = "anna";
    const e = personEdit(text, parseQuery(text), row, words(text));
    expect(e?.text).toBe("from:anna@x.pl");
    expect(e).toMatchObject({ start: 0, end: 4, caret: 14 });
  });

  it("keeps the other words and adds the token", () => {
    const text = "anna faktura";
    expect(personEdit(text, parseQuery(text), row, words(text))?.text).toBe(
      "anna faktura from:anna@x.pl",
    );
  });

  it("is null for an address that cannot be a token", () => {
    expect(personEdit("a", parseQuery("a"), { address: 'x"y' }, ["a"])).toBeNull();
  });
});

describe("pills", () => {
  it("shows Account only with more than one account", () => {
    expect(pills("faktura", 1).map((p) => p.label)).toEqual([
      "From…",
      "Has attachment",
      "Unread",
      "Any time",
    ]);
    expect(pills("faktura", 2).map((p) => p.id)).toContain("account");
  });

  it("is on when its token is a top-level term", () => {
    const on = (text: string) =>
      pills(text, 2)
        .filter((p) => p.on)
        .map((p) => p.id);
    expect(on("faktura")).toEqual([]);
    expect(on("faktura has:attachment is:unread")).toEqual(["attachment", "unread"]);
    expect(on("faktura from:anna after:-7d account:work")).toEqual(["from", "account", "date"]);
    expect(on("faktura OR has:attachment")).toEqual([]);
  });

  it("toggles the token in and out of the text", () => {
    expect(togglePill("faktura", "attachment", false)).toBe("faktura has:attachment");
    expect(togglePill("faktura has:attachment", "attachment", true)).toBe("faktura");
    expect(togglePill("is:unread faktura", "unread", true)).toBe("faktura");
    expect(togglePill("faktura", "from", false)).toBe("faktura from:");
    expect(togglePill("faktura from:anna", "from", true)).toBe("faktura");
    expect(togglePill("faktura", "date", false)).toBe("faktura after:");
    expect(togglePill("a after:-7d before:today b", "date", true)).toBe("a b");
  });
});

describe("removeFilter and removeField", () => {
  it("take out top-level terms only", () => {
    expect(removeFilter("a has:attachment", "has:attachment")).toBe("a");
    expect(removeFilter("a -has:attachment", "-has:attachment")).toBe("a");
    expect(removeFilter("a -has:attachment", "has:attachment")).toBe("a -has:attachment");
    expect(removeFilter("(a OR has:attachment)", "has:attachment")).toBe("(a OR has:attachment)");
    expect(removeField("from:a x from:b", ["from"])).toBe("x");
    expect(removeField("x", ["from"])).toBe("x");
  });
});

describe("askLive", () => {
  it("asks for the threads with the whole query, and for people and files with the words", async () => {
    const backend = {
      search: vi.fn().mockResolvedValue({ messages: [msg(1), msg(2)] }),
      suggestPeople: vi.fn().mockResolvedValue([]),
      searchFiles: vi.fn().mockResolvedValue([]),
    };
    const a = await askLive(backend as never, "faktura is:unread", ["faktura"]);
    expect(backend.search).toHaveBeenCalledWith({ query: "faktura is:unread", limit: 24 });
    expect(backend.suggestPeople).toHaveBeenCalledWith("faktura", 6);
    expect(backend.searchFiles).toHaveBeenCalledWith("faktura", 3);
    expect(a.threads).toHaveLength(2);
  });

  it("treats a failed read as an empty one", async () => {
    const backend = {
      search: vi.fn().mockRejectedValue(new Error("x")),
      suggestPeople: vi.fn().mockRejectedValue(new Error("x")),
      searchFiles: vi.fn().mockRejectedValue(new Error("x")),
    };
    const a = await askLive(backend as never, "faktura", ["faktura"]);
    expect([a.threads, a.people, a.files].map((x) => x.length)).toEqual([0, 0, 0]);
  });
});

describe("createCoalescer", () => {
  function setup() {
    const calls: { text: string; resolve: (v: string) => void }[] = [];
    const answers: string[] = [];
    const c = createCoalescer<string>(
      (text) => new Promise<string>((resolve) => calls.push({ text, resolve })),
      (text, a) => answers.push(`${text}=${a}`),
    );
    return { c, calls, answers };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("sends one request at a time and only the latest ask after it", async () => {
    const { c, calls, answers } = setup();
    c.ask("f");
    c.ask("fa");
    c.ask("fak");
    c.ask("fakt");
    expect(calls.map((x) => x.text)).toEqual(["f"]);
    calls[0]?.resolve("one");
    await tick();
    // "f" is stale by now: dropped. Only the latest ask went out behind it.
    expect(answers).toEqual([]);
    expect(calls.map((x) => x.text)).toEqual(["f", "fakt"]);
    calls[1]?.resolve("two");
    await tick();
    expect(answers).toEqual(["fakt=two"]);
  });

  it("shows the answer when nothing newer was asked", async () => {
    const { c, calls, answers } = setup();
    c.ask("fa");
    calls[0]?.resolve("ok");
    await tick();
    expect(answers).toEqual(["fa=ok"]);
  });

  it("does not ask twice for the same text", async () => {
    const { c, calls } = setup();
    c.ask("fa");
    c.ask("fa");
    calls[0]?.resolve("x");
    await tick();
    c.ask("fa");
    expect(calls).toHaveLength(1);
  });

  it("drops what is in flight and waiting once stopped, and asks again afterwards", async () => {
    const { c, calls, answers } = setup();
    c.ask("fa");
    c.ask("fak");
    c.stop();
    calls[0]?.resolve("late");
    await tick();
    expect(answers).toEqual([]);
    expect(calls).toHaveLength(1);
    c.ask("fa");
    calls[1]?.resolve("again");
    await tick();
    expect(answers).toEqual(["fa=again"]);
  });

  it("goes on after a failed request", async () => {
    const answers: string[] = [];
    let n = 0;
    const c = createCoalescer<string>(
      (text) => (n++ === 0 ? Promise.reject(new Error("x")) : Promise.resolve(text)),
      (text) => answers.push(text),
    );
    c.ask("fa");
    await tick();
    c.ask("fak");
    await tick();
    expect(answers).toEqual(["fak"]);
  });
});
