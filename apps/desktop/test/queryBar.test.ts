import { foldText, type PersonSuggestion, parseQuery } from "@matters/core";
import { describe, expect, it, vi } from "vitest";
import { createPeopleFeed } from "../src/renderer/peopleFeed.ts";
import { addField, addFilter, labelToken, senderToken } from "../src/renderer/queryEdits.ts";
import { querySegments } from "../src/renderer/querySegments.ts";
import {
  type Edit,
  matchesPerson,
  peoplePrefix,
  querySuggestions,
  type SuggestionSources,
} from "../src/renderer/querySuggestions.ts";

const sources: SuggestionSources = {
  labels: ["inbox", "invoices", "my label", "work"],
  accounts: [
    { id: "a1", address: "anna@work.example", displayName: "Anna Work" },
    { id: "a2", address: "anna@home.example", displayName: "Anna Home" },
    { id: "a3", address: "bob@mail.example", displayName: "" },
  ],
  people: [],
};

const apply = (text: string, e: Edit) => ({
  text: text.slice(0, e.start) + e.text + text.slice(e.end),
  caret: e.caret,
});

/** Suggestions at the caret marked `|` in `spec`. */
function suggest(spec: string) {
  const caret = spec.indexOf("|");
  const text = spec.replace("|", "");
  const groups = querySuggestions(text, caret, parseQuery(text), sources);
  return {
    text,
    groups,
    labels: groups.flatMap((g) => g.items.map((i) => i.label)),
    first: (label: string) => {
      const item = groups.flatMap((g) => g.items).find((i) => i.label === label);
      if (!item) throw new Error(`no item ${label}`);
      return apply(text, item.edit);
    },
  };
}

describe("querySegments", () => {
  const segs = (text: string) => querySegments(text, parseQuery(text));
  const show = (text: string) => segs(text).map((s) => `${s.kind}:${s.state}:${s.text}`);

  it("splits a field into key and value that share a pill", () => {
    const s = segs("hi from:anna");
    expect(show("hi from:anna")).toEqual([
      "plain:ok:hi",
      "plain:ok: ",
      "key:ok:from:",
      "value:ok:anna",
    ]);
    expect(s[2]?.pill).toBe(s[3]?.pill);
  });

  it("marks states, operators, phrases, groups and brackets", () => {
    expect(show("is:unre")[1]).toBe("value:incomplete:unre");
    expect(show("is:nope")[0]).toBe("key:invalid:is:");
    expect(show("after:2026-13-45")[1]).toBe("value:invalid:2026-13-45");
    expect(show("a OR -b")).toEqual([
      "plain:ok:a",
      "plain:ok: ",
      "op:ok:OR",
      "plain:ok: ",
      "op:ok:-",
      "plain:ok:b",
    ]);
    expect(show('"x y"')).toEqual(['phrase:ok:"x y"']);
    expect(show("from:(anna OR bob)")).toEqual([
      "key:ok:from:",
      "bracket:ok:(",
      "grouped:ok:anna",
      "plain:ok: ",
      "op:ok:OR",
      "plain:ok: ",
      "grouped:ok:bob",
      "bracket:ok:)",
    ]);
    expect(show("a )")[2]).toBe("bracket:invalid:)");
  });

  it("covers the text exactly for any input (seeded fuzz)", () => {
    let seed = 20261104;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const atoms = [
      "from:",
      "to:",
      "is:",
      "has:",
      "label:",
      "account:",
      "after:",
      "before:",
      "subject:",
      "unread",
      "attachment",
      "anna",
      "-7d",
      "2026-01-02",
      "OR",
      "AND",
      "NOT",
      "-",
      "(",
      ")",
      '"',
      " ",
      " ",
      "  ",
      "\t",
      "\n",
      "ł",
      "Żółw",
      "😀",
      "me",
      "@",
      ":",
      "x",
    ];
    for (let i = 0; i < 3000; i++) {
      const n = rand(i % 50 === 0 ? 700 : 25);
      let text = "";
      for (let j = 0; j < n; j++) text += atoms[rand(atoms.length)];
      const out = segs(text);
      expect(out.map((s) => s.text).join("")).toBe(text);
      expect(out.every((s) => s.text !== "")).toBe(true);
    }
  });
});

describe("querySuggestions", () => {
  it("offers every field for an empty query", () => {
    const s = suggest("|");
    expect(s.groups.map((g) => g.title)).toEqual(["Filters"]);
    expect(s.labels).toContain("from:");
    expect(s.labels).toHaveLength(11);
    expect(s.labels).toContain("in:");
    expect(s.first("is:")).toEqual({ text: "is:", caret: 3 });
  });

  it("filters fields by the word at the caret, and offers nothing for other words", () => {
    expect(suggest("fr|").labels).toEqual(["from:"]);
    expect(suggest("su|").labels).toEqual(["subject:"]);
    expect(suggest("anna|").labels).toEqual([]);
    expect(suggest("hello fr|").first("from:")).toEqual({ text: "hello from:", caret: 11 });
  });

  it("offers fields then Combine after a space", () => {
    const s = suggest("from:me |");
    expect(s.groups.map((g) => g.title)).toEqual(["Filters", "Combine"]);
    expect(s.first("OR")).toEqual({ text: "from:me OR ", caret: 11 });
    expect(s.first("-")).toEqual({ text: "from:me -", caret: 9 });
    expect(s.first("( )")).toEqual({ text: "from:me ()", caret: 9 });
    expect(suggest("(|").groups.map((g) => g.title)).toEqual(["Filters"]);
    expect(suggest("a)|").labels).toEqual([]);
    expect(suggest("|anna").labels).toEqual([]);
  });

  it("completes enum values and ends them with a space", () => {
    expect(suggest("is:|").labels).toEqual(["unread", "read", "starred", "replied", "draft"]);
    const s = suggest("x is:re|");
    expect(s.labels).toEqual(["read", "replied"]);
    expect(s.first("read")).toEqual({ text: "x is:read ", caret: 10 });
    expect(suggest("has:|").labels).toEqual(["attachment"]);
    expect(suggest("is:zzz|").labels).toEqual([]);
  });

  it("completes where mail is with in:, Trash and Spam among the places (ADR 0044, rule 3)", () => {
    expect(suggest("in:|").labels).toEqual(["inbox", "archive", "sent", "drafts", "trash", "spam"]);
    const s = suggest("x in:tr|");
    expect(s.labels).toEqual(["trash"]);
    expect(s.first("trash")).toEqual({ text: "x in:trash ", caret: 11 });
    expect(suggest("in:s|").labels).toEqual(["sent", "spam"]);
    expect(suggest("i|").labels).toEqual(expect.arrayContaining(["is:", "in:"]));
    expect(suggest("in:zzz|").labels).toEqual([]);
  });

  it("offers only me for people", () => {
    expect(suggest("from:|").labels).toEqual(["me"]);
    expect(suggest("to:m|").first("me")).toEqual({ text: "to:me ", caret: 6 });
    expect(suggest("cc:anna|").labels).toEqual([]);
  });

  it("offers labels, quoting those with spaces", () => {
    expect(suggest("label:i|").labels).toEqual(["inbox", "invoices"]);
    expect(suggest("label:my|").first("my label")).toEqual({
      text: 'label:"my label" ',
      caret: 17,
    });
  });

  it("offers words for accounts", () => {
    const s = suggest("account:|");
    expect(s.labels).toContain("bob@mail.example");
    expect(s.labels).toHaveLength(3);
    // Both Annas share a first name: their addresses tell them apart.
    expect(s.labels).toContain("anna@work.example");
    expect(suggest("account:wo|").labels).toEqual(["anna@work.example"]);
    expect(suggest("account:|").groups[0]?.items[0]?.hint).toBe("anna@work.example");
  });

  it("offers date presets", () => {
    expect(suggest("after:|").labels).toEqual(["today", "yesterday", "-7d", "-30d", "-1y"]);
    expect(suggest("before:-|").labels).toEqual(["-7d", "-30d", "-1y"]);
    expect(suggest("after:y|").first("yesterday")).toEqual({ text: "after:yesterday ", caret: 16 });
  });

  it("completes inside a field group", () => {
    const s = suggest("from:(anna OR m|)");
    expect(s.labels).toEqual(["me"]);
    expect(s.first("me")).toEqual({ text: "from:(anna OR me )", caret: 17 });
    expect(suggest("is:(unread OR st|)").labels).toEqual(["starred"]);
  });

  it("stays quiet in quoted values and before a group bracket", () => {
    expect(suggest('from:"an|').labels).toEqual([]);
    expect(suggest("from:|(a)").labels).toEqual([]);
  });

  it("is quick on a big label list", () => {
    const labels = Array.from({ length: 500 }, (_, i) => `label${i}`);
    const text = "label:l";
    const t = performance.now();
    for (let i = 0; i < 100; i++)
      querySuggestions(text, text.length, parseQuery(text), { labels, accounts: [], people: [] });
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe("writing filters into the text", () => {
  it("does not write a token that is already a top-level term", () => {
    expect(addFilter("is:unread", "is:unread")).toBe("is:unread");
    expect(addFilter("IS:Unread from:bob", "is:unread")).toBe("IS:Unread from:bob");
    expect(addFilter("(a OR b) is:unread", "is:unread")).toBe("(a OR b) is:unread");
  });

  it("writes it when it is only negated, grouped, or under an OR", () => {
    expect(addFilter("-is:unread", "is:unread")).toBe("-is:unread is:unread");
    expect(addFilter("(is:unread)", "is:unread")).toBe("(is:unread) is:unread");
    expect(addFilter("a OR is:unread", "is:unread")).toBe("(a OR is:unread) is:unread");
  });

  it("tidies spaces, wraps an OR and closes an open quote", () => {
    expect(addFilter("   ", "is:unread")).toBe("is:unread");
    expect(addFilter("anna  ", "is:unread")).toBe("anna is:unread");
    expect(addFilter("a OR b", "is:unread")).toBe("(a OR b) is:unread");
    expect(addFilter("a OR", "is:unread")).toBe("(a OR) is:unread");
    expect(addFilter('"abc', "is:unread")).toBe('"abc" is:unread');
  });
});

describe("recent searches", () => {
  const offered = (text: string, baseline: string, recent: readonly string[]) =>
    querySuggestions(text, text.length, parseQuery(text), { ...sources, recent, baseline })
      .filter((g) => g.title === "Recent")
      .flatMap((g) => g.items)
      .filter((i) => i.recent !== undefined);

  it("are offered while the bar holds what the view stands for", () => {
    expect(offered("", "", ["from:anna", "faktura"]).map((i) => i.label)).toEqual([
      "from:anna",
      "faktura",
    ]);
    expect(offered("is:unread", "is:unread", ["from:anna"]).map((i) => i.label)).toEqual([
      "from:anna",
    ]);
  });

  it("end with a row that clears them, only when there are some", () => {
    const groupOf = (recent: readonly string[]) =>
      querySuggestions("", 0, parseQuery(""), { ...sources, recent, baseline: "" }).find(
        (g) => g.title === "Recent",
      );
    expect(groupOf(["a", "b"])?.items.at(-1)).toMatchObject({
      label: "Clear all",
      clearsRecent: true,
    });
    expect(groupOf([])).toBeUndefined();
  });

  it("step aside once something is typed", () => {
    expect(offered("fak", "", ["faktura"])).toEqual([]);
    expect(offered("is:unread x", "is:unread", ["faktura"])).toEqual([]);
  });

  it("replace the whole text, and leave out the text already there", () => {
    const [item] = offered("is:unread", "is:unread", ["is:unread", "from:anna"]);
    expect(item?.edit).toEqual({ start: 0, end: 9, text: "from:anna", caret: 9 });
  });
});

describe("field handlers", () => {
  it("writes the field at the end, waiting for a value", () => {
    expect(addField("", "from")).toBe("from:");
    expect(addField("anna", "from")).toBe("anna from:");
    expect(addField("a OR b", "is")).toBe("(a OR b) is:");
    expect(addField('"abc', "is")).toBe('"abc" is:');
  });

  it("lets a field still waiting give way", () => {
    expect(addField("from:", "to")).toBe("to:");
    expect(addField("anna from:", "from")).toBe("anna from:");
    expect(addField("anna -from: ", "to")).toBe("anna to:");
  });

  it("adds to a field that has its value", () => {
    expect(addField("from:anna", "from")).toBe("from:anna from:");
    expect(addField("is:unread", "has")).toBe("is:unread has:");
  });

  it("leaves the caret where the panel offers the field's values", () => {
    const text = addField("anna", "is");
    const items = querySuggestions(text, text.length, parseQuery(text), sources).flatMap(
      (g) => g.items,
    );
    expect(items.map((i) => i.label)).toContain("unread");
  });
});

const person = (address: string, name?: string, count = 1): PersonSuggestion => ({
  address,
  ...(name === undefined ? {} : { name }),
  count,
});
const people = [
  person("jan@lodz.pl", "Jan Kowalski", 120),
  person("janina@example.com", "Janina Nowak", 40),
  person("jo@work.example", undefined, 7),
  person("zoe@example.com", "Zoë Łodź", 3),
];

/** Like `suggest`, with people. */
function withPeople(spec: string, list: readonly PersonSuggestion[] = people) {
  const caret = spec.indexOf("|");
  const text = spec.replace("|", "");
  const parsed = parseQuery(text);
  const groups = querySuggestions(text, caret, parsed, { ...sources, people: list });
  const items = groups.flatMap((g) => g.items);
  return {
    text,
    groups,
    items,
    prefix: peoplePrefix(text, caret, parsed),
    pick: (label: string) => {
      const item = items.find((i) => i.label === label);
      if (!item) throw new Error(`no item ${label}`);
      return apply(text, item.edit);
    },
  };
}

describe("people in suggestions (ADR 0028)", () => {
  it("offers me first, then people, in a from, to or cc value", () => {
    for (const field of ["from", "to", "cc"]) {
      const s = withPeople(`${field}:|m`.replace("|m", "j|"), [person("me.jo@x.pl", "Me Jo")]);
      expect(s.items.map((i) => i.label)).toEqual(["Me Jo"]);
    }
    const s = withPeople("from:m|", [person("mia@x.pl", "Mia Nowak", 5)]);
    expect(s.items.map((i) => i.label)).toEqual(["me", "Mia Nowak"]);
    expect(s.groups).toHaveLength(1);
  });

  it("shows the name with the address and the count, or the address alone", () => {
    const s = withPeople("from:j|");
    expect(s.items.map((i) => [i.label, i.hint, i.count])).toEqual([
      ["Jan Kowalski", "jan@lodz.pl", 120],
      ["Janina Nowak", "janina@example.com", 40],
      ["jo@work.example", "", 7],
    ]);
  });

  it("inserts the address and a space, whatever part of the name was typed", () => {
    expect(withPeople("from:kowal|").pick("Jan Kowalski")).toEqual({
      text: "from:jan@lodz.pl ",
      caret: 17,
    });
    expect(withPeople("x to:ja|").pick("Janina Nowak").text).toBe("x to:janina@example.com ");
  });

  it("completes inside a field group", () => {
    const s = withPeople("from:(anna OR kow|)");
    expect(s.prefix).toBe("kow");
    expect(s.pick("Jan Kowalski")).toEqual({
      text: "from:(anna OR jan@lodz.pl )",
      caret: 26,
    });
  });

  it("narrows an answer for an earlier prefix to what is typed now", () => {
    expect(withPeople("from:jani|").items.map((i) => i.label)).toEqual(["Janina Nowak"]);
    expect(withPeople("from:zzz|").items).toEqual([]);
    // folded, as the index folds
    expect(withPeople("from:lodz|").items.map((i) => i.label)).toEqual([
      "Jan Kowalski",
      "Zoë Łodź",
    ]);
    expect(withPeople("from:ŁÓD|").items.map((i) => i.label)).toEqual(["Jan Kowalski", "Zoë Łodź"]);
  });

  it("offers the frequent people, after me, with nothing typed in the value", () => {
    expect(withPeople("from:|").items.map((i) => i.label)).toEqual([
      "me",
      "Jan Kowalski",
      "Janina Nowak",
      "jo@work.example",
      "Zoë Łodź",
    ]);
    expect(withPeople("from:|").prefix).toBe("");
    expect(withPeople("cc:|").prefix).toBe("");
  });

  it("offers a People group before Filters for a plain word of 2+ characters", () => {
    const s = withPeople("ja|");
    expect(s.groups.map((g) => g.title)).toEqual(["People"]);
    expect(s.groups[0]?.items.map((i) => i.label)).toEqual(["Jan Kowalski", "Janina Nowak"]);
    const fr = withPeople("fr|", [person("fred@x.pl", "Fred")]);
    expect(fr.groups.map((g) => g.title)).toEqual(["People", "Filters"]);
    expect(s.pick("Jan Kowalski")).toEqual({ text: "from:jan@lodz.pl ", caret: 17 });
    expect(withPeople("hello -ja|").pick("Janina Nowak").text).toBe(
      "hello -from:janina@example.com ",
    );
    // the whole word is replaced, even with the caret inside it
    expect(withPeople("ja|n later").pick("Jan Kowalski").text).toBe("from:jan@lodz.pl  later");
  });

  it("offers no People for a single character, a quoted value or a field word", () => {
    expect(withPeople("i|").groups.map((g) => g.title)).toEqual(["Filters"]);
    expect(withPeople("i|").prefix).toBeNull();
    expect(withPeople('from:"jan|').items).toEqual([]);
    expect(withPeople("from:|(jan)").items).toEqual([]);
    expect(withPeople("is:un|").groups.map((g) => g.title)).toEqual(["State of the message"]);
    expect(withPeople("jan |").groups.map((g) => g.title)).toEqual(["Filters", "Combine"]);
    expect(withPeople("a)|").items).toEqual([]);
  });

  it("does not offer an address the parser could not read back", () => {
    const s = withPeople("from:b|", [person("b(c)@x.pl", "Bad"), person("bob@x.pl", "Bob")]);
    expect(s.items.map((i) => i.label)).toEqual(["Bob"]);
  });

  it("says which prefix the caret context wants people for", () => {
    const at = (spec: string) => withPeople(spec).prefix;
    expect(at("from:ja|")).toBe("ja");
    expect(at("from:ja|n")).toBe("ja");
    expect(at("to:Łu|")).toBe("Łu");
    expect(at("from:(a OR ja|)")).toBe("ja");
    expect(at("anna ja|")).toBe("ja");
    expect(at("-ja|")).toBe("ja");
    expect(at("(ja|")).toBe("ja");
    expect(at("from:@|")).toBeNull();
    expect(at("j|")).toBeNull();
    expect(at("ł|")).toBeNull();
    expect(at("|")).toBeNull();
    expect(at("jan |")).toBeNull();
    expect(at('"ja|')).toBeNull();
    expect(at('from:"ja|')).toBeNull();
    expect(at("subject:ja|")).toBeNull();
    expect(at("label:ja|")).toBeNull();
    expect(at("is:ja|")).toBeNull();
    expect(at("foo:ja|")).toBeNull();
  });

  it("matches a person like the index does", () => {
    const jan = person("jan@lodz.pl", "Jan Kowalski");
    expect(matchesPerson(jan, "Kow")).toBe(true);
    expect(matchesPerson(jan, "jan.kow")).toBe(true);
    expect(matchesPerson(jan, "lodz")).toBe(true);
    expect(matchesPerson(jan, "owal")).toBe(false);
    expect(matchesPerson(jan, "")).toBe(false);
    expect(matchesPerson(jan, "@@")).toBe(false);
  });

  it("is quick with a full list", () => {
    const list = Array.from({ length: 20 }, (_, i) => person(`p${i}@x.pl`, `Person ${i}`, i));
    const text = "from:pe";
    const t = performance.now();
    for (let i = 0; i < 200; i++) {
      querySuggestions(text, text.length, parseQuery(text), { ...sources, people: list });
    }
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("people feed", () => {
  function setup() {
    const calls: { prefix: string; resolve: (p: PersonSuggestion[]) => void; fail: () => void }[] =
      [];
    const backend = {
      suggestPeople: vi.fn(
        (prefix: string) =>
          new Promise<readonly PersonSuggestion[]>((resolve, reject) => {
            calls.push({ prefix, resolve, fail: () => reject(new Error("down")) });
          }),
      ),
    };
    const answers: (readonly PersonSuggestion[])[] = [];
    const feed = createPeopleFeed(backend, (p) => answers.push(p));
    return { calls, backend, answers, feed };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("delivers the latest answer and drops an older one that arrives late", async () => {
    const { calls, answers, feed } = setup();
    feed.ask("j");
    feed.ask("ja");
    feed.ask("jan");
    calls[2]?.resolve([person("jan@x.pl")]);
    await flush();
    calls[0]?.resolve([person("old@x.pl")]);
    calls[1]?.resolve([person("older@x.pl")]);
    await flush();
    expect(answers).toEqual([[person("jan@x.pl")]]);
  });

  it("drops an answer that arrives after the feed was stopped", async () => {
    const { calls, answers, feed } = setup();
    feed.ask("ja");
    feed.stop();
    calls[0]?.resolve([person("jan@x.pl")]);
    await flush();
    expect(answers).toEqual([]);
  });

  it("ignores a failed request and keeps working", async () => {
    const { calls, answers, feed } = setup();
    feed.ask("ja");
    calls[0]?.fail();
    await flush();
    feed.ask("jan");
    calls[1]?.resolve([person("jan@x.pl")]);
    await flush();
    expect(answers).toEqual([[person("jan@x.pl")]]);
  });
});

describe("filters written from the reader", () => {
  it("adds a token once: a top-level term is left alone", () => {
    expect(addFilter("", "from:a@b.c")).toBe("from:a@b.c");
    expect(addFilter("anna", "from:a@b.c")).toBe("anna from:a@b.c");
    expect(addFilter("anna from:a@b.c", "from:a@b.c")).toBe("anna from:a@b.c");
    expect(addFilter("FROM:A@b.c  ", "from:a@b.c")).toBe("FROM:A@b.c  ");
    expect(addFilter("x -from:a@b.c", "-from:a@b.c")).toBe("x -from:a@b.c");
    expect(addFilter("x -from:a@b.c", "from:a@b.c")).toBe("x -from:a@b.c from:a@b.c");
    expect(addFilter("x from:a@b.c", "-from:a@b.c")).toBe("x from:a@b.c -from:a@b.c");
  });

  it("brackets an OR root, and a dangling operator, before adding", () => {
    expect(addFilter("a OR b", "-from:a@b.c")).toBe("(a OR b) -from:a@b.c");
    expect(addFilter("from:a@b.c OR b", "from:a@b.c")).toBe("(from:a@b.c OR b) from:a@b.c");
    expect(addFilter("a OR", "label:work")).toBe("(a OR) label:work");
    expect(addFilter('"abc', "label:work")).toBe('"abc" label:work');
    const out = addFilter("a OR b", "label:work");
    expect(parseQuery(out).root?.kind).toBe("and");
  });

  it("writes sender tokens for plain addresses only", () => {
    expect(senderToken("Jan@Lodz.PL", false)).toBe("from:jan@lodz.pl");
    expect(senderToken(" jan@lodz.pl ", true)).toBe("-from:jan@lodz.pl");
    expect(senderToken("a b@x.pl", false)).toBeNull();
    expect(senderToken('a"b@x.pl', false)).toBeNull();
    expect(senderToken("", false)).toBeNull();
  });

  it("writes label tokens the parser reads back as the folded label id", () => {
    const ids = [
      "inbox",
      "INBOX",
      "INBOX.Sent",
      "Label_123",
      "Projects/2024",
      "Zażółć gęślą",
      "Łódź",
      "Faktury 2024",
      "Folder (old)",
      "a:b",
      "-lead",
      "work",
      "x".repeat(256),
    ];
    for (const id of ids) {
      const token = labelToken(id);
      expect(token, id).not.toBeNull();
      const root = parseQuery(token as string).root;
      expect(root, id).toEqual({ kind: "label", value: foldText(id).trim() });
    }
    expect(labelToken("")).toBeNull();
    expect(labelToken("   ")).toBeNull();
    expect(labelToken('say "hi"')).toBeNull();
    expect(labelToken("y".repeat(257))).toBeNull();
    expect(labelToken("Faktury 2024")).toBe('label:"faktury 2024"');
    expect(labelToken("Łódź")).toBe("label:lodz");
  });
});
