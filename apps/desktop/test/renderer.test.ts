import type { AccountInfo, ChangesEvent } from "@matters/contracts";
import type { Message, SyncStatus } from "@matters/core";
import { makeMessage } from "@matters/testkit";
import { describe, expect, it, vi } from "vitest";
import { linkify, splitSignature } from "../src/renderer/body.ts";
import { type Backend, BackendError } from "../src/renderer/client.ts";
import { explainFailure } from "../src/renderer/explain.ts";
import {
  cssStringContent,
  isOpenable,
  misleadingHost,
  type TextNode,
  visibleLinkText,
  withoutInvisible,
} from "../src/renderer/links.ts";
import { mergeMessages } from "../src/renderer/merge.ts";
import { describeStatus, summarize } from "../src/renderer/status.ts";
import { createMailStore, PAGE_SIZE } from "../src/renderer/store.ts";

const msg = (key: number, overrides: Partial<Message> = {}): Message =>
  makeMessage({ key, providerId: `p${key}`, threadId: `t${key}`, ...overrides });

describe("mergeMessages", () => {
  const list = [msg(50), msg(40), msg(30)];

  it("inserts new mail by key, keeps untouched rows as they are, replaces changed ones", () => {
    const seen = msg(40, { subject: "changed" });
    const out = mergeMessages(list, [msg(60), seen, msg(45)], new Set(), false);
    expect(out.map((m) => m.key)).toEqual([60, 50, 45, 40, 30]);
    expect(out[1]).toBe(list[0]);
    expect(out[3]).toBe(seen);
  });

  it("drops removed keys and returns the same array when nothing changed", () => {
    expect(mergeMessages(list, [], new Set([40]), false).map((m) => m.key)).toEqual([50, 30]);
    expect(mergeMessages(list, [], new Set(), false)).toBe(list);
    expect(mergeMessages(list, [list[1] as Message], new Set(), false)).toEqual(list);
  });

  it("leaves out mail older than a page that has more behind it, takes it when all is loaded", () => {
    const older = msg(10);
    expect(mergeMessages(list, [older], new Set(), false)).toBe(list);
    expect(mergeMessages(list, [older], new Set(), true).map((m) => m.key)).toEqual([
      50, 40, 30, 10,
    ]);
    expect(mergeMessages([], [msg(5), msg(9)], new Set(), true).map((m) => m.key)).toEqual([9, 5]);
  });

  it("does not add a message that is both changed and removed", () => {
    expect(mergeMessages(list, [msg(70)], new Set([70]), true)).toBe(list);
  });
});

describe("status text", () => {
  const syncing = (over: Partial<Extract<SyncStatus, { state: "syncing" }>> = {}): SyncStatus => ({
    state: "syncing",
    folder: "INBOX",
    done: 120,
    total: 5000,
    ...over,
  });

  it("describes what is happening in a few words", () => {
    expect(describeStatus(syncing())).toEqual({ tone: "busy", text: "Syncing INBOX 120 / 5000" });
    expect(describeStatus(syncing({ total: undefined }))).toEqual({
      tone: "busy",
      text: "Syncing INBOX 120",
    });
    expect(describeStatus(syncing({ folder: "", done: 0 })).text).toBe("Connecting…");
    expect(describeStatus({ state: "idle" })).toEqual({ tone: "idle", text: "Up to date" });
    expect(
      describeStatus({ state: "idle", lastSyncMs: Date.UTC(2026, 10, 3, 14, 5) }).text,
    ).toMatch(/^Synced \d\d:\d\d$/);
    expect(describeStatus({ state: "error", kind: "auth", message: "x" }).text).toBe(
      "Password rejected",
    );
    expect(describeStatus({ state: "error", kind: "other", message: "boom" })).toEqual({
      tone: "error",
      text: "Sync failed: boom",
    });
  });

  it("puts errors before work before rest when several accounts report", () => {
    const account = (id: string): AccountInfo => ({
      id,
      address: `${id}@example.com`,
      displayName: id,
      host: "h",
      port: 993,
      security: "tls",
      username: id,
      canSend: true,
      status: { state: "idle" },
    });
    const accounts = [account("a"), account("b")];
    const error: SyncStatus = { state: "error", kind: "unreachable", message: "m" };
    expect(summarize([], {}).text).toBe("No account");
    expect(summarize(accounts, { a: syncing(), b: error }).tone).toBe("error");
    expect(summarize(accounts, { a: syncing() }).tone).toBe("busy");
    expect(summarize(accounts, {}).tone).toBe("idle");
  });
});

describe("explainFailure", () => {
  const at = { host: "imap.x.pl", port: 993, smtpHost: "smtp.x.pl" };

  it("is specific per failure and never repeats the password it was never given", () => {
    expect(explainFailure(new BackendError("authFailed", "x"), at)).toMatch(/app password/);
    expect(explainFailure(new BackendError("tlsFailed", "certificate has expired"), at)).toBe(
      "Could not make a secure connection to imap.x.pl:993. The secure handshake failed.",
    );
    expect(explainFailure(new BackendError("unreachable", "x"), { ...at, port: 143 })).toMatch(
      /imap\.x\.pl:143/,
    );
    expect(explainFailure(new BackendError("credentialsUnavailable", "No keyring"), at)).toMatch(
      /No keyring/,
    );
    expect(explainFailure(new BackendError("accountExists", "x"), at)).toMatch(/already added/);
    expect(explainFailure(new Error("x"), at)).toBe("Something went wrong. Try again.");
  });

  it("says that receiving works when only the outgoing server failed", () => {
    expect(explainFailure(new BackendError("outgoingAuthFailed", "x"), at)).toMatch(
      /Receiving works, but smtp\.x\.pl refused/,
    );
    expect(explainFailure(new BackendError("outgoingFailed", "timed out."), at)).toMatch(
      /smtp\.x\.pl didn't answer properly/,
    );
  });
});

/** A backend with a mutable mailbox; only what the store calls. */
function fakeBackend(initial: readonly Message[]) {
  let all = [...initial].sort((a, b) => b.key - a.key);
  const backend = {
    async listNewest({ limit }: { beforeKey?: number; limit: number }) {
      return { type: "listNewest", requestId: "x", ok: true, messages: all.slice(0, limit) };
    },
    async getMessages(keys: readonly number[]) {
      return {
        type: "getMessages",
        requestId: "x",
        ok: true,
        messages: all.filter((m) => keys.includes(m.key)),
      };
    },
    async openThread(threadId: string) {
      const messages = all
        .filter((m) => m.threadId === threadId)
        .map((m) => ({ ...m, bodyText: "b" }));
      return {
        type: "openThread",
        requestId: "x",
        ok: true,
        thread: {
          id: threadId,
          accountId: "acc1",
          subject: "s",
          messageKeys: [],
          lastMessageKey: 0,
          labelIds: [],
          unreadCount: 0,
        },
        messages,
      };
    },
  } as unknown as Backend;
  return {
    backend,
    set: (next: readonly Message[]) => {
      all = [...next].sort((a, b) => b.key - a.key);
    },
  };
}

const changes = (changed: number[], removed: number[] = []): ChangesEvent => ({
  type: "changes",
  changeSeq: 1,
  changedKeys: changed,
  removedKeys: removed,
});

describe("live updates in the store", () => {
  it("takes in new mail without moving the selected message and reports the shift", async () => {
    const fake = fakeBackend([msg(50), msg(40), msg(30), msg(20)]);
    const store = createMailStore(fake.backend);
    await store.start();
    store.select(2); // key 30
    const shifts: number[] = [];
    store.onShift((rows) => shifts.push(rows));
    store.setAnchor(() => 40);

    fake.set([msg(70), msg(60), msg(50), msg(40), msg(30), msg(20)]);
    await store.applyChanges(changes([70, 60]));

    expect(store.messages().map((m) => m.key)).toEqual([70, 60, 50, 40, 30, 20]);
    expect(store.messages()[store.selected()]?.key).toBe(30);
    expect(shifts).toEqual([2]);
    expect(store.mailboxEmpty()).toBe(false);
  });

  it("moves the selection to a neighbour when its message is removed, and empties out", async () => {
    const fake = fakeBackend([msg(50), msg(40), msg(30)]);
    const store = createMailStore(fake.backend);
    await store.start();
    store.select(1);
    fake.set([msg(50), msg(30)]);
    await store.applyChanges(changes([], [40]));
    expect(store.messages().map((m) => m.key)).toEqual([50, 30]);
    expect(store.selected()).toBe(1);

    fake.set([]);
    await store.applyChanges(changes([], [50, 30]));
    expect(store.messages()).toEqual([]);
    expect(store.mailboxEmpty()).toBe(true);
    expect(store.thread()).toBeNull();
  });

  it("applies events one after the other, in order", async () => {
    const fake = fakeBackend([msg(50)]);
    const store = createMailStore(fake.backend);
    await store.start();
    fake.set([msg(70), msg(60), msg(50)]);
    const first = store.applyChanges(changes([60]));
    const second = store.applyChanges(changes([70]));
    await Promise.all([first, second]);
    expect(store.messages().map((m) => m.key)).toEqual([70, 60, 50]);
  });
});

/** A backend whose search answers come from a script, one call at a time. */
function searchBackend(initial: readonly Message[]) {
  const base = fakeBackend(initial);
  type Chunk = { messages: Message[]; nextBeforeKey?: number };
  const queue: ((args: { query: string; beforeKey?: number }) => Promise<Chunk>)[] = [];
  const search = vi.fn(async (args: { query: string; beforeKey?: number; limit: number }) => {
    const answer = queue.shift();
    if (!answer) throw new Error("no scripted search answer");
    const chunk = await answer(args);
    return { type: "search", requestId: "x", ok: true, ...chunk };
  });
  const listNewest = vi.spyOn(base.backend, "listNewest");
  return {
    ...base,
    backend: Object.assign(base.backend, { search }) as Backend,
    search,
    listNewest,
    /** Answers the next search call with this chunk. */
    answer: (chunk: Chunk) => queue.push(async () => chunk),
    /** The next search call waits for `release`. */
    hold(chunk: Chunk) {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      queue.push(async () => {
        await gate;
        return chunk;
      });
      return release;
    },
  };
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!done()) throw new Error("timed out");
};

describe("search in the store (ADR 0025)", () => {
  it("treats text that constrains nothing like no query, so the list does not empty", async () => {
    const fake = searchBackend([msg(50), msg(40)]);
    const store = createMailStore(fake.backend);
    await store.start();
    for (const text of ["from:", "is:un", " -- ", "after:2026-1", "a OR"]) {
      store.setQuery(text === "a OR" ? "OR" : text);
      await until(() => store.messages().length > 0);
      expect(
        store.messages().map((m) => m.key),
        text,
      ).toEqual([50, 40]);
      expect(store.filtered(), text).toBe(false);
      expect(store.mailboxEmpty()).toBe(false);
    }
    expect(fake.search).not.toHaveBeenCalled();
    // Typed on to something real, it does ask the backend.
    fake.answer({ messages: [msg(40)] });
    store.setQuery("from:jan");
    await until(() => store.messages().length === 1);
    expect(fake.search).toHaveBeenCalledTimes(1);
    expect(store.filtered()).toBe(true);
  });

  it("settles on the first window, then fills the page window by window, painting each", async () => {
    const fake = searchBackend([msg(90)]);
    const store = createMailStore(fake.backend);
    await store.start();
    const settled: [string, number][] = [];
    store.onSettled((q) => settled.push([q, store.messages().length]));

    fake.answer({ messages: [msg(80)], nextBeforeKey: 70 });
    const release2 = fake.hold({ messages: [], nextBeforeKey: 60 });
    const release3 = fake.hold({ messages: [msg(50), msg(40)] });
    store.setQuery("alpha");
    await until(() => store.messages()[0]?.key === 80);
    expect(settled).toEqual([["alpha", 1]]);
    expect(store.searching()).toBe(true);
    expect(store.hasMore()).toBe(true);

    release2();
    await until(() => fake.search.mock.calls.length === 3);
    expect(store.messages().map((m) => m.key)).toEqual([80]);
    release3();
    await until(() => !store.searching());
    expect(store.messages().map((m) => m.key)).toEqual([80, 50, 40]);
    expect(fake.search.mock.calls.map(([a]) => a.beforeKey)).toEqual([undefined, 70, 60]);
    expect(store.hasMore()).toBe(false);
    expect(settled).toHaveLength(1);
  });

  it("is searching, not finished, while an empty first window has a cursor", async () => {
    const fake = searchBackend([msg(90)]);
    const store = createMailStore(fake.backend);
    await store.start();
    fake.answer({ messages: [], nextBeforeKey: 70 });
    const release = fake.hold({ messages: [] });
    store.setQuery("zzz");
    await until(() => fake.search.mock.calls.length === 2);
    expect(store.messages()).toEqual([]);
    expect(store.searching()).toBe(true);
    release();
    await until(() => !store.searching());
    expect(store.messages()).toEqual([]);
    expect(store.filtered()).toBe(true);
  });

  it("stops filling when the query changed", async () => {
    const fake = searchBackend([msg(90)]);
    const store = createMailStore(fake.backend);
    await store.start();
    fake.answer({ messages: [msg(80)], nextBeforeKey: 70 });
    const release = fake.hold({ messages: [msg(10)], nextBeforeKey: 5 });
    store.setQuery("alpha");
    await until(() => fake.search.mock.calls.length === 2);
    fake.answer({ messages: [msg(33)] });
    store.setQuery("beta");
    release();
    await until(() => store.messages().length === 1 && store.messages()[0]?.key === 33);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.messages().map((m) => m.key)).toEqual([33]);
    expect(store.searching()).toBe(false);
    expect(fake.search).toHaveBeenCalledTimes(3);
  });

  it("loads more through short and empty windows", async () => {
    const page = Array.from({ length: PAGE_SIZE }, (_, i) => msg(10_000 - i));
    const fake = searchBackend([msg(1)]);
    const store = createMailStore(fake.backend);
    await store.start();
    fake.answer({ messages: page, nextBeforeKey: 9_000 });
    store.setQuery("alpha");
    await until(() => store.messages().length === PAGE_SIZE && !store.searching());
    expect(store.hasMore()).toBe(true);

    fake.answer({ messages: [], nextBeforeKey: 8_000 });
    fake.answer({ messages: [msg(7_000)], nextBeforeKey: 6_000 });
    fake.answer({ messages: [], nextBeforeKey: 5_000 });
    fake.answer({ messages: [msg(4_000), msg(3_999)] });
    await store.loadMore();
    expect(store.messages().length).toBe(PAGE_SIZE + 3);
    expect(store.messages().at(-1)?.key).toBe(3_999);
    expect(store.hasMore()).toBe(false);
    expect(fake.search.mock.calls.map(([a]) => a.beforeKey)).toEqual([
      undefined,
      9_000,
      8_000,
      6_000,
      5_000,
    ]);
    await store.loadMore(); // nothing left: no request
    expect(fake.search).toHaveBeenCalledTimes(5);
  });

  it("does not blank a filtered list when a change arrives and the first window is empty", async () => {
    const fake = searchBackend([msg(90)]);
    const store = createMailStore(fake.backend);
    await store.start();
    fake.answer({ messages: [msg(80), msg(70)] });
    store.setQuery("alpha");
    await until(() => store.messages().length === 2);

    // The fresh first window is empty but has a cursor; the second holds the answer.
    fake.answer({ messages: [], nextBeforeKey: 50 });
    const release = fake.hold({ messages: [msg(80), msg(40)] });
    const applied = store.applyChanges(changes([40]));
    await until(() => fake.search.mock.calls.length === 3);
    expect(store.messages().map((m) => m.key)).toEqual([80, 70]);
    release();
    await applied;
    expect(store.messages().map((m) => m.key)).toEqual([80, 40]);
    expect(store.searching()).toBe(false);
  });

  it("abandons a change that was overtaken by a new query", async () => {
    const fake = searchBackend([msg(90)]);
    const store = createMailStore(fake.backend);
    await store.start();
    fake.answer({ messages: [msg(80)] });
    store.setQuery("alpha");
    await until(() => store.messages().length === 1);

    const release = fake.hold({ messages: [msg(11)], nextBeforeKey: 5 });
    const applied = store.applyChanges(changes([11]));
    await until(() => fake.search.mock.calls.length === 2);
    fake.answer({ messages: [msg(22)] });
    store.setQuery("beta");
    release();
    await applied;
    await until(() => store.messages()[0]?.key === 22);
    expect(store.messages().map((m) => m.key)).toEqual([22]);
    expect(fake.search).toHaveBeenCalledTimes(3); // the overtaken change asked for no more
  });

  it("treats a change under an unconstrained query as unfiltered", async () => {
    const fake = searchBackend([msg(50)]);
    const store = createMailStore(fake.backend);
    await store.start();
    store.setQuery("from:");
    await until(() => store.messages().length > 0);
    fake.set([msg(60), msg(50)]);
    await store.applyChanges(changes([60]));
    expect(store.messages().map((m) => m.key)).toEqual([60, 50]);
    expect(fake.search).not.toHaveBeenCalled();
  });
});

describe("links in messages", () => {
  it("opens only web and mail addresses", () => {
    expect(isOpenable("https://x.pl/a")).toBe(true);
    expect(isOpenable("mailto:a@x.pl")).toBe(true);
    expect(isOpenable("javascript:alert(1)")).toBe(false);
    expect(isOpenable("file:///etc/passwd")).toBe(false);
  });

  it("warns when a link's text names another site", () => {
    expect(misleadingHost("www.mbank.pl", "https://mbank.evil.example/login")).toBe("www.mbank.pl");
    expect(misleadingHost("https://paypal.com/x", "https://paypal.com.evil.example")).toBe(
      "paypal.com",
    );
  });

  it("does not warn about words or the same site", () => {
    expect(misleadingHost("Reactivate now", "https://track.example/abc")).toBeNull();
    expect(misleadingHost("linkedin.com", "https://www.linkedin.com/x")).toBeNull();
    expect(misleadingHost("example.com", "https://mail.example.com/x")).toBeNull();
  });
});

describe("text of a letter", () => {
  it("finds links without the punctuation around them", () => {
    expect(linkify("See https://x.pl/a, (www.y.pl) or https://z.pl/a_(b).")).toEqual([
      { text: "See " },
      { text: "https://x.pl/a", href: "https://x.pl/a" },
      { text: ", (" },
      { text: "www.y.pl", href: "https://www.y.pl" },
      { text: ") or " },
      { text: "https://z.pl/a_(b)", href: "https://z.pl/a_(b)" },
      { text: "." },
    ]);
    expect(linkify("no links here")).toEqual([{ text: "no links here" }]);
  });

  it("cuts a signature at its last delimiter", () => {
    expect(splitSignature("Hello\n\n-- \nAnna\ntel. 1")).toEqual({
      body: "Hello",
      signature: "Anna\ntel. 1",
      lines: 2,
    });
    expect(splitSignature("a -- b\nc")).toEqual({ body: "a -- b\nc", lines: 0 });
    expect(splitSignature("trailing\n--")).toEqual({ body: "trailing\n--", lines: 0 });
  });
});

describe("link text that hides its address (ADR 0048)", () => {
  it("sees an address split by a character that draws nothing", () => {
    for (const hidden of [
      "\u200B",
      "\u200C",
      "\u200D",
      "\u2060",
      "\uFEFF",
      "\u00AD",
      "\u202E",
      "\u0000",
      "\u3164",
    ]) {
      expect(misleadingHost(`exam${hidden}ple.org/login`, "https://evil.example/")).toBe(
        "example.org",
      );
      expect(
        misleadingHost(`https://www.example.org${hidden}/account`, "https://evil.example/"),
      ).toBe("www.example.org");
    }
    expect(misleadingHost("\u200Bexample.org\u200B", "https://example.org/x")).toBeNull();
  });

  it("keeps ordinary white space in the text", () => {
    expect(withoutInvisible("a\tb\nc d")).toBe("a\tb\nc d");
    expect(misleadingHost("go to example.org now", "https://evil.example/")).toBeNull();
  });

  it("decodes a CSS content value that is only strings", () => {
    expect(cssStringContent('"https://www.example.org/account"')).toBe(
      "https://www.example.org/account",
    );
    expect(cssStringContent('"a" "b"')).toBe("ab");
    expect(cssStringContent("'it\\'s'")).toBe("it's");
    expect(cssStringContent('"\\41 B\\"q\\""')).toBe('AB"q"');
    expect(cssStringContent('"a\\\\b"')).toBe("a\\b");
    expect(cssStringContent('"\\1F600"')).toBe("\u{1F600}");
    expect(cssStringContent('"\\0"')).toBe("\uFFFD");
  });

  it("ignores none, normal and anything that is not a plain string", () => {
    for (const value of [
      "none",
      "normal",
      "",
      "counter(x)",
      "attr(href)",
      '"a" counter(x)',
      'url("x.png")',
      "open-quote",
      '"a" / "alt"',
      '"unterminated',
    ]) {
      expect(cssStringContent(value)).toBe("");
    }
  });

  const text = (data: string): TextNode => ({ nodeType: 3, data, childNodes: [] });
  const el = (...childNodes: TextNode[]): TextNode => ({ nodeType: 1, childNodes });

  it("reads text in order with what CSS draws before and after each element", () => {
    const inner = el(text("ple"));
    const link = el(text("exam"), inner, text(".org"));
    const drawn = new Map<TextNode, { "::before"?: string; "::after"?: string }>([
      [link, { "::before": "https://" }],
      [inner, { "::before": "<", "::after": ">" }],
    ]);
    const pseudo = (node: TextNode, which: "::before" | "::after") =>
      drawn.get(node)?.[which] ?? "";
    expect(visibleLinkText(link, pseudo)).toBe("https://exam<ple>.org");
    expect(visibleLinkText(link, () => "")).toBe("example.org");
  });

  it("reads a link drawn only by CSS, and survives very deep markup", () => {
    const empty = el();
    expect(
      visibleLinkText(empty, (_n, w) => (w === "::before" ? "https://www.example.org/x" : "")),
    ).toBe("https://www.example.org/x");
    let deep = text("x");
    for (let i = 0; i < 50_000; i++) deep = el(deep);
    expect(visibleLinkText(deep, () => "")).toBe("x");
  });
});
