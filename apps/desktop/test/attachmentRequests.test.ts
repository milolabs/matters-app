import type { ClockPort, StoredAccount } from "@matters/core";
import { createInMemoryStorage, FakeComposeRenderer } from "@matters/testkit/fakes";
import { describe, expect, it } from "vitest";
import { handle } from "../src/backend/handler.ts";
import { LimitProbe } from "../src/backend/limitProbe.ts";
import { ProgressThrottle } from "../src/backend/progressThrottle.ts";
import { TransferBook } from "../src/backend/transfers.ts";
import { imageDeps, noCounts, noSend, noViewWrites } from "./support/noSend.ts";

const account: StoredAccount = {
  id: "a1",
  address: "me@example.test",
  displayName: "Me",
  imap: { host: "h", port: 993, security: "tls", username: "me" },
  smtp: { host: "h", port: 465, security: "tls", username: "me" },
  createdAtMs: 1,
};

function depsFor(accounts: StoredAccount[], limits: { ensure(a: unknown): void }) {
  const storage = createInMemoryStorage();
  const list = async () => accounts;
  return {
    ...storage,
    accountStore: { list },
    renderer: new FakeComposeRenderer(),
    send: noSend,
    savedViews: { list: async () => [], recentSearches: async () => [] },
    viewWrites: noViewWrites,
    counts: noCounts,
    ...imageDeps,
    limits,
    accounts: {
      discover: async () => null,
      list: async () => [],
      add: async () => {
        throw new Error("not used");
      },
      remove: async () => false,
      syncNow: async () => false,
      changePassword: async () => null,
    },
  } as unknown as Parameters<typeof handle>[0];
}

const validContent = {
  accountId: "a1",
  from: { address: "me@example.test" },
  to: [{ address: "anna@northwind.example" }],
  cc: [],
  bcc: [],
  subject: "Files",
  bodyMarkdown: "x",
  inReplyTo: "",
  references: [],
};
const file = (id: string) => ({ id, name: `${id}.pdf`, size: 10, delivery: { kind: "inline" } });

describe("drafts that list files", () => {
  const seen: unknown[] = [];
  const deps = {
    ...depsFor([account], { ensure: () => {} }),
    send: {
      ...noSend,
      saveDraft: async (input: unknown) => {
        seen.push(input);
        return { id: "d1" } as never;
      },
    },
  };
  const save = (attachments: unknown) =>
    handle(deps, {
      type: "saveDraft",
      requestId: "r",
      content: { ...validContent, attachments },
    });

  it("passes the files on with only the fields a draft has, nothing that could be a path", async () => {
    seen.length = 0;
    const r = await save([
      { ...file("att-1"), path: "/etc/passwd", sourcePath: "/etc/passwd" },
      { id: "att-2", name: "b.pdf", size: 0, delivery: { kind: "link", carrierId: "dropbox" } },
    ]);
    expect(r).toMatchObject({ type: "saveDraft", ok: true });
    expect(seen).toEqual([
      {
        content: {
          ...validContent,
          attachments: [
            file("att-1"),
            {
              ...file("att-2"),
              name: "b.pdf",
              size: 0,
              delivery: { kind: "link", carrierId: "dropbox" },
            },
          ],
        },
      },
    ]);
  });

  it("leaves the key out for an empty list, as the fingerprint does", async () => {
    seen.length = 0;
    await save([]);
    expect(seen).toEqual([{ content: validContent }]);
  });

  it("refuses files that are not files, field by field", async () => {
    for (const bad of [
      "x",
      [file("../escape")],
      [file("")],
      [{ ...file("a"), name: "" }],
      [{ ...file("a"), size: -1 }],
      [{ ...file("a"), size: Number.NaN }],
      [{ ...file("a"), delivery: { kind: "ftp" } }],
      [{ ...file("a"), delivery: "inline" }],
      Array.from({ length: 101 }, (_, i) => file(`a${i}`)),
    ]) {
      expect(await save(bad)).toMatchObject({ type: "error", code: "invalidRequest" });
    }
  });
});

describe("the message limit in a prepared message", () => {
  it("is the stored limit, and a known one is not asked for again", async () => {
    const asked: unknown[] = [];
    const deps = depsFor([{ ...account, messageLimitBytes: 25_000_000 }], {
      ensure: (a) => asked.push(a),
    });
    const r = await handle(deps, { type: "prepareNew", requestId: "r" });
    expect(r).toMatchObject({
      type: "prepareNew",
      ok: true,
      messageLimitBytes: 25_000_000,
      redirect: null,
    });
    expect(asked).toEqual([{ id: "a1", canSend: true, messageLimitBytes: 25_000_000 }]);
  });

  it("is null while unknown, and starts the background ask", async () => {
    const asked: unknown[] = [];
    const deps = depsFor([account], { ensure: (a) => asked.push(a) });
    const r = await handle(deps, { type: "prepareNew", requestId: "r" });
    expect(r).toMatchObject({ type: "prepareNew", ok: true, messageLimitBytes: null });
    expect(asked).toEqual([{ id: "a1", canSend: true }]);
  });

  it("accepts Stop among the send actions", async () => {
    const calls: unknown[] = [];
    const deps = {
      ...depsFor([account], { ensure: () => {} }),
      send: {
        ...noSend,
        sendAction: async (id: string, action: string) => {
          calls.push([id, action]);
          return true;
        },
      },
    };
    expect(
      await handle(deps, { type: "sendAction", requestId: "r", operationId: "o1", action: "stop" }),
    ).toMatchObject({ type: "sendAction", ok: true, done: true });
    expect(calls).toEqual([["o1", "stop"]]);
  });
});

describe("LimitProbe", () => {
  it("asks once per session, only for accounts that can send and do not know yet", async () => {
    const asked: string[] = [];
    const found: [string, number][] = [];
    const probe = new LimitProbe(
      async (id) => {
        asked.push(id);
        return id === "a1" ? 25_000_000 : null;
      },
      (id, limit) => found.push([id, limit]),
    );
    probe.ensure({ id: "known", canSend: true, messageLimitBytes: 1 });
    probe.ensure({ id: "readonly", canSend: false });
    probe.ensure({ id: "a1", canSend: true });
    probe.ensure({ id: "a1", canSend: true });
    probe.ensure({ id: "a2", canSend: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual(["a1", "a2"]);
    // A server that announces nothing says nothing.
    expect(found).toEqual([["a1", 25_000_000]]);
  });

  it("does not fail the prepare when the ask fails", async () => {
    const probe = new LimitProbe(
      async () => {
        throw new Error("unreachable");
      },
      () => {
        throw new Error("not called");
      },
    );
    expect(() => probe.ensure({ id: "a1", canSend: true })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("TransferBook", () => {
  it("stops one transfer as the user, and all of them as quit", () => {
    const book = new TransferBook();
    const a = new AbortController();
    const b = new AbortController();
    book.start("a", a);
    book.start("b", b);
    expect(book.stop("a")).toBe(true);
    expect(a.signal.reason).toBe("stop");
    expect(book.abortAll("quit")).toBe(2);
    expect(b.signal.reason).toBe("quit");
    book.end("a");
    book.end("b");
    expect(book.stop("a")).toBe(false);
    expect(book.size).toBe(0);
  });
});

describe("ProgressThrottle", () => {
  function fake() {
    let now = 0;
    const timers: { at: number; run: () => void }[] = [];
    const clock: ClockPort = {
      now: () => now,
      setTimeout(run, ms) {
        const timer = { at: now + ms, run };
        timers.push(timer);
        return () => timers.splice(timers.indexOf(timer) >>> 0, 1);
      },
      random: () => 0,
    };
    const advance = (ms: number) => {
      now += ms;
      for (const t of timers.filter((x) => x.at <= now).sort((x, y) => x.at - y.at)) {
        timers.splice(timers.indexOf(t), 1);
        t.run();
      }
    };
    return { clock, advance };
  }

  it("lets at most four reports a second through per item, and never loses the last", () => {
    const { clock, advance } = fake();
    const out: [string, number, number][] = [];
    const throttle = new ProgressThrottle<number>(clock, (k, v) => out.push([k, v, clock.now()]));
    // A thousand reports in one second, as a fast hash would make.
    for (let t = 0; t < 1000; t++) {
      throttle.report("a", t / 1000);
      advance(1);
    }
    throttle.report("a", 1);
    advance(250);
    expect(out.length).toBeGreaterThanOrEqual(4);
    expect(out.length).toBeLessThan(10);
    for (let i = 1; i < out.length; i++) {
      expect((out[i]?.[2] ?? 0) - (out[i - 1]?.[2] ?? 0)).toBeGreaterThanOrEqual(250);
    }
    expect(out.at(-1)?.slice(0, 2)).toEqual(["a", 1]);
  });

  it("keeps items apart, and forgets one without a trailing report", () => {
    const { clock, advance } = fake();
    const out: [string, number][] = [];
    const throttle = new ProgressThrottle<number>(clock, (k, v) => out.push([k, v]));
    throttle.report("a", 0.1);
    throttle.report("b", 0.1);
    throttle.report("a", 0.2);
    throttle.forget("a");
    advance(1000);
    expect(out).toEqual([
      ["a", 0.1],
      ["b", 0.1],
    ]);
    // A forgotten item starts again with an immediate report.
    throttle.report("a", 0.5);
    expect(out.at(-1)).toEqual(["a", 0.5]);
  });
});
