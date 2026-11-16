import { describe, expect, it, vi } from "vitest";
import {
  createLinkQueue,
  defaultMailInfo,
  linkSummary,
  MAILTO_WAITING_MAX,
  type MailtoClient,
  mailtoArguments,
  makeDefaultMail,
  standInMailtoClient,
} from "../src/main/mailtoLinks.ts";
import { readDefaultMailInfo, readMailtoPrefill } from "../src/main/mailtoShapes.ts";
import {
  CHANNEL_DEFAULT_MAIL,
  CHANNEL_MAILTO_TAKE,
  createMailtoBridge,
} from "../src/preload/mailtoBridge.ts";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the links that wait (ADR 0143, rule 5)", () => {
  it("keeps what core read, in order, and gives each once", () => {
    const q = createLinkQueue();
    expect(q.offer("mailto:a@example.com?subject=one")?.subject).toBe("one");
    q.offer("mailto:b@example.com?attach=/etc/hosts&bcc=c@example.com");
    expect(q.size()).toBe(2);
    expect(q.take()).toMatchObject({ to: ["a@example.com"], subject: "one" });
    expect(q.take()).toEqual({
      to: ["b@example.com"],
      cc: [],
      bcc: ["c@example.com"],
      subject: "",
      body: "",
    });
    expect(q.take()).toBeNull();
  });

  it("drops what is not a mailto: link", () => {
    const q = createLinkQueue();
    expect(q.offer("https://example.com")).toBeNull();
    expect(q.offer("file:///etc/passwd")).toBeNull();
    expect(q.size()).toBe(0);
  });

  it("keeps at most five: a page that fires hundreds gets five drafts", () => {
    const q = createLinkQueue();
    for (let i = 0; i < 300; i++) q.offer(`mailto:p${i}@example.com`);
    expect(q.size()).toBe(MAILTO_WAITING_MAX);
    expect(q.take()?.to).toEqual(["p0@example.com"]);
    // A place freed is a place for the next link that comes, not for one already dropped.
    q.offer("mailto:later@example.com");
    const left = [q.take(), q.take(), q.take(), q.take(), q.take()].map((d) => d?.to[0]);
    expect(left).toEqual([
      "p1@example.com",
      "p2@example.com",
      "p3@example.com",
      "p4@example.com",
      "later@example.com",
    ]);
  });

  it("reads only mailto: arguments, at most five", () => {
    expect(
      mailtoArguments([
        "/Applications/Matters.app/Contents/MacOS/Matters",
        "--inspect",
        "/etc/passwd",
        "MAILTO:a@example.com",
        "https://example.com",
        "mailto:b@example.com",
      ]),
    ).toEqual(["MAILTO:a@example.com", "mailto:b@example.com"]);
    expect(
      mailtoArguments(Array.from({ length: 9 }, (_, i) => `mailto:${i}@x.example`)),
    ).toHaveLength(5);
  });

  it("says in a smoke run how much a link holds, never what", () => {
    const line = linkSummary(
      { to: ["secret@example.com"], cc: [], bcc: [], subject: "private", body: "words" },
      "outside",
    );
    expect(line).toBe(
      "matters-mailto: a link from outside waits (to 1, cc 0, bcc 0, subject 7, body 5)",
    );
    expect(line).not.toContain("secret");
  });
});

describe("the default mail app (ADR 0143, rule 2)", () => {
  it("is not offered without a client: a build that is not packaged", () => {
    expect(defaultMailInfo(null)).toEqual({ offered: false, isDefault: false });
    expect(makeDefaultMail(null)).toEqual({ offered: false, isDefault: false });
  });

  it("asks the system only on the press, and then says how things stand", () => {
    const client: MailtoClient = { isDefault: vi.fn(() => false), makeDefault: vi.fn(() => true) };
    expect(defaultMailInfo(client)).toEqual({ offered: true, isDefault: false });
    expect(client.makeDefault).not.toHaveBeenCalled();
    makeDefaultMail(client);
    expect(client.makeDefault).toHaveBeenCalledTimes(1);
  });

  it("does not claim to be the default before the system says so (macOS may ask first)", () => {
    const client: MailtoClient = { isDefault: () => false, makeDefault: () => true };
    expect(makeDefaultMail(client)).toEqual({ offered: true, isDefault: false });
  });

  it("survives a client that throws", () => {
    const client: MailtoClient = {
      isDefault: () => {
        throw new Error("no");
      },
      makeDefault: () => {
        throw new Error("no");
      },
    };
    expect(makeDefaultMail(client)).toEqual({ offered: true, isDefault: false });
  });

  it("the window tests' stand-in becomes the default when pressed", () => {
    const client = standInMailtoClient();
    expect(defaultMailInfo(client).isDefault).toBe(false);
    expect(makeDefaultMail(client)).toEqual({ offered: true, isDefault: true });
  });
});

describe("what crosses to the page", () => {
  it("reads a well-shaped link and nothing else", () => {
    const good = { to: ["a@example.com"], cc: [], bcc: [], subject: "s", body: "b" };
    expect(readMailtoPrefill(good)).toEqual(good);
    for (const bad of [
      null,
      [],
      { ...good, to: "a@example.com" },
      { ...good, cc: [1] },
      { ...good, subject: 1 },
      { ...good, body: "x".repeat(40_001) },
      { ...good, to: Array.from({ length: 51 }, () => "a@example.com") },
    ]) {
      expect(readMailtoPrefill(bad)).toBeNull();
    }
  });

  it("never reads a default that is not offered", () => {
    expect(readDefaultMailInfo({ offered: false, isDefault: true })).toEqual({
      offered: false,
      isDefault: false,
    });
    expect(readDefaultMailInfo({ offered: "yes", isDefault: true })).toBeNull();
  });
});

describe("the mailto bridge", () => {
  function rig(answer: unknown = null) {
    const page = {};
    const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => answer);
    const post = vi.fn();
    const bridge = createMailtoBridge({ invoke, post }, page);
    return { page, invoke, post, bridge };
  }

  it("ignores another window, malformed requests and unknown actions", async () => {
    const r = rig();
    r.bridge.message({ source: {}, data: { mattersMailtoTake: { requestId: "1" } } });
    for (const data of [null, 1, "x", {}, { mattersMailtoTake: { requestId: 1 } }])
      r.bridge.message({ source: r.page, data });
    r.bridge.message({
      source: r.page,
      data: { mattersMailtoTake: { requestId: "x".repeat(101) } },
    });
    r.bridge.message({
      source: r.page,
      data: { mattersDefaultMail: { requestId: "2", action: "unset" } },
    });
    await flush();
    expect(r.invoke).not.toHaveBeenCalled();
    expect(r.post).toHaveBeenCalledTimes(1);
    expect(r.post).toHaveBeenCalledWith({
      mattersDefaultMailAnswer: { requestId: "2", answer: null },
    });
  });

  it("takes a link with no argument from the page: the page names no link", async () => {
    const link = { to: ["a@example.com"], cc: [], bcc: [], subject: "", body: "" };
    const r = rig(link);
    r.bridge.message({
      source: r.page,
      data: { mattersMailtoTake: { requestId: "1", href: "mailto:evil@example.com" } },
    });
    await flush();
    expect(r.invoke).toHaveBeenCalledWith(CHANNEL_MAILTO_TAKE);
    expect(r.post).toHaveBeenCalledWith({ mattersMailtoAnswer: { requestId: "1", answer: link } });
  });

  it("reads main's answer before the page sees it", async () => {
    const r = rig({ to: "not a list" });
    r.bridge.message({ source: r.page, data: { mattersMailtoTake: { requestId: "1" } } });
    await flush();
    expect(r.post).toHaveBeenCalledWith({ mattersMailtoAnswer: { requestId: "1", answer: null } });
  });

  it("asks main for the default by action name only", async () => {
    const r = rig({ offered: true, isDefault: false });
    r.bridge.message({
      source: r.page,
      data: { mattersDefaultMail: { requestId: "3", action: "make", scheme: "https" } },
    });
    await flush();
    expect(r.invoke).toHaveBeenCalledWith(CHANNEL_DEFAULT_MAIL, "make");
    expect(r.post).toHaveBeenCalledWith({
      mattersDefaultMailAnswer: { requestId: "3", answer: { offered: true, isDefault: false } },
    });
  });

  it("tells the page that a link waits", () => {
    const r = rig();
    r.bridge.waiting();
    expect(r.post).toHaveBeenCalledWith({ mattersMailtoWaiting: true });
  });
});
