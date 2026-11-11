import { describe, expect, it, vi } from "vitest";
import type { Message, NewMail, NewMailDeps, NotificationPrefs } from "../src/index.ts";
import {
  arrivalsBetween,
  badgeText,
  CATCH_UP_DAYS,
  channelsOf,
  clockText,
  DEFAULT_NOTIFICATION_PREFS,
  fromWhom,
  isOldMail,
  isPaused,
  isQuiet,
  localMinuteOf,
  MAILBOX_BIT,
  NEEDS_YOU_VIEW,
  NewMailWatch,
  NOTICE_KINDS,
  noticeKindOf,
  parseClock,
  pausedText,
  pauseUntil,
  planCatchUp,
  planNotices,
  planPromptNotices,
  quietEndsAt,
  readNotificationPrefs,
  readWatchState,
} from "../src/index.ts";

let n = 0;
function msg(over: Partial<Message> = {}): Message {
  n += 1;
  return {
    key: 1000 + n,
    accountId: "a1",
    providerId: `p${n}`,
    threadId: `t${n}`,
    messageIdHeader: `<p${n}@x>`,
    dateMs: 0,
    from: { name: `Person ${n}`, address: `p${n}@northwind.example` },
    to: [],
    cc: [],
    subject: `Subject ${n}`,
    snippet: `First line ${n}`,
    flags: { seen: false, flagged: false, answered: false, draft: false },
    labelIds: [],
    hasAttachments: false,
    senderAuth: "unknown",
    mailboxes: MAILBOX_BIT.inbox,
    ...over,
  };
}

function mail(message: Message, over: Partial<NewMail> = {}): NewMail {
  return { message, inbox: true, fromMe: false, youWrote: false, views: [], ...over };
}

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_NOTIFICATION_PREFS,
  ...over,
});

describe("notification settings (ADR 0071, rule 6)", () => {
  it("fills what is missing or wrong with the defaults", () => {
    expect(readNotificationPrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(readNotificationPrefs("nonsense")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    const read = readNotificationPrefs({
      enabled: "yes",
      kinds: { lists: { banner: true } },
      banner: { together: 7, content: "full" },
      inApp: { seconds: 0 },
      quiet: { on: true, fromMin: 9999, toMin: 420 },
      views: { v1: { badge: true }, "": { banner: true } },
      mutedAccounts: ["a1", "a1", 3],
      pausedUntilMs: -5,
    });
    expect(read.enabled).toBe(true);
    expect(read.kinds.lists).toEqual({ banner: true, inApp: false, badge: false });
    expect(read.banner.together).toBe(3);
    expect(read.banner.content).toBe("full");
    expect(read.inApp.seconds).toBe(0);
    expect(read.quiet).toEqual({ on: true, fromMin: 22 * 60, toMin: 420 });
    expect(read.views).toEqual({ v1: { banner: false, inApp: false, badge: true } });
    expect(read.mutedAccounts).toEqual(["a1"]);
    expect(read.pausedUntilMs).toBeNull();
  });

  it("counts the starter view on the badge by default, and keeps a source that was chosen (ADR 0117, rule 5)", () => {
    const starter = { source: "view", viewId: NEEDS_YOU_VIEW.id, style: "count" };
    expect(NEEDS_YOU_VIEW.id).toBe("starter-needs-you");
    expect(DEFAULT_NOTIFICATION_PREFS.badge).toEqual(starter);
    expect(readNotificationPrefs({}).badge).toEqual(starter);
    expect(readNotificationPrefs({ badge: { source: "unread" } }).badge).toEqual(starter);
    expect(readNotificationPrefs({ badge: { source: 3, style: "dot" } }).badge).toEqual({
      ...starter,
      style: "dot",
    });
    for (const source of ["notified", "inbox", "off"] as const) {
      expect(readNotificationPrefs({ badge: { source } }).badge).toEqual({
        source,
        style: "count",
      });
    }
  });

  it("reads a stored `matters` badge as the starter view (ADR 0117, rule 5)", () => {
    expect(readNotificationPrefs({ badge: { source: "matters" } }).badge).toEqual({
      source: "view",
      viewId: "starter-needs-you",
      style: "count",
    });
    // Its style is kept, and a view id stored beside it does not count.
    expect(
      readNotificationPrefs({ badge: { source: "matters", viewId: "v1", style: "dot" } }).badge,
    ).toEqual({ source: "view", viewId: "starter-needs-you", style: "dot" });
  });

  it("keeps the view a badge of `view` counts, and only for that source (ADR 0117, rule 5)", () => {
    expect(readNotificationPrefs({ badge: { source: "view", viewId: "v1" } }).badge).toEqual({
      source: "view",
      viewId: "v1",
      style: "count",
    });
    // No view, or a broken one: the starter view.
    expect(readNotificationPrefs({ badge: { source: "view" } }).badge).toEqual({
      source: "view",
      viewId: "starter-needs-you",
      style: "count",
    });
    expect(readNotificationPrefs({ badge: { source: "view", viewId: 7 } }).badge).toEqual({
      source: "view",
      viewId: "starter-needs-you",
      style: "count",
    });
    expect(readNotificationPrefs({ badge: { source: "inbox", viewId: "v1" } }).badge).toEqual({
      source: "inbox",
      style: "count",
    });
  });

  it("has three kinds, and ignores a stored `matters` kind (ADR 0117, rule 6)", () => {
    const none = { banner: false, inApp: false, badge: false };
    const all = { banner: true, inApp: true, badge: true };
    expect(NOTICE_KINDS).toEqual(["replies", "people", "lists"]);
    expect(Object.keys(DEFAULT_NOTIFICATION_PREFS.kinds).sort()).toEqual([
      "lists",
      "people",
      "replies",
    ]);
    const old = readNotificationPrefs({
      kinds: { replies: none, people: all, lists: none, matters: all },
    });
    expect(old.kinds).toEqual({ replies: none, people: all, lists: none });
    expect(old.kinds).not.toHaveProperty("matters");
  });

  it("is quiet while paused and inside quiet hours, also across midnight", () => {
    const p = prefs({ quiet: { on: true, fromMin: 22 * 60, toMin: 7 * 60 } });
    expect(isQuiet(p, 0, 23 * 60)).toBe(true);
    expect(isQuiet(p, 0, 6 * 60 + 59)).toBe(true);
    expect(isQuiet(p, 0, 7 * 60)).toBe(false);
    expect(isQuiet(p, 0, 12 * 60)).toBe(false);
    const day = prefs({ quiet: { on: true, fromMin: 12 * 60, toMin: 13 * 60 } });
    expect(isQuiet(day, 0, 12 * 60 + 30)).toBe(true);
    expect(isQuiet(day, 0, 13 * 60)).toBe(false);
    expect(isQuiet(prefs({ pausedUntilMs: 100 }), 99, 600)).toBe(true);
    expect(isQuiet(prefs({ pausedUntilMs: 100 }), 100, 600)).toBe(false);
  });

  it("reads and writes clock times", () => {
    expect(clockText(7 * 60 + 5)).toBe("07:05");
    expect(parseClock("7:30")).toBe(450);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("noon")).toBeNull();
  });
});

describe("which mail notifies (ADR 0071, rules 3 and 4)", () => {
  it("sorts Inbox mail into replies, people and lists", () => {
    expect(noticeKindOf(mail(msg(), { youWrote: true }))).toBe("replies");
    expect(noticeKindOf(mail(msg()))).toBe("people");
    expect(noticeKindOf(mail(msg({ automated: true }), { youWrote: true }))).toBe("lists");
    expect(noticeKindOf(mail(msg({ from: { address: "no-reply@shop.example" } })))).toBe("lists");
    expect(noticeKindOf(mail(msg(), { inbox: false }))).toBeNull();
  });

  it("never notifies for your own, read or muted mail, nor when off", () => {
    const none = { banner: false, inApp: false, badge: false };
    expect(channelsOf(prefs(), mail(msg(), { fromMe: true }), 0)).toEqual(none);
    const read = msg({ flags: { seen: true, flagged: false, answered: false, draft: false } });
    expect(channelsOf(prefs(), mail(read), 0)).toEqual(none);
    expect(channelsOf(prefs({ mutedAccounts: ["a1"] }), mail(msg()), 0)).toEqual(none);
    expect(channelsOf(prefs({ enabled: false }), mail(msg()), 0)).toEqual(none);
  });

  it("adds the channels of the views a message is in, also outside the Inbox", () => {
    const p = prefs({ views: { v1: { banner: true, inApp: false, badge: false } } });
    const archived = mail(msg(), { inbox: false, views: ["v1"] });
    expect(channelsOf(p, archived, 0)).toEqual({ banner: true, inApp: false, badge: false });
    // A list is off by default, but a view of it can still ring.
    const list = mail(msg({ automated: true }), { views: ["v1"] });
    expect(channelsOf(p, list, 0).banner).toBe(true);
    expect(channelsOf(p, mail(msg({ automated: true })), 0).banner).toBe(false);
  });
});

describe("what the notices say (ADR 0071, rule 5)", () => {
  it("says as much as the banner setting allows; the window always says it all", () => {
    const m = msg({ from: { name: "Anna", address: "anna@x.example" }, subject: "Umowa" });
    const at = (content: "full" | "subject" | "minimal") =>
      planNotices(
        prefs({ banner: { ...DEFAULT_NOTIFICATION_PREFS.banner, content } }),
        [mail(m)],
        false,
        0,
      );
    expect(at("full").banners[0]).toMatchObject({ title: "Anna", subtitle: "Umowa" });
    expect(at("subject").banners[0]).toMatchObject({ title: "Anna", body: "Umowa" });
    expect(at("minimal").banners[0]?.title).toBe("New mail");
    expect(JSON.stringify(at("minimal").banners)).not.toContain("Anna");
    expect(at("minimal").inApp[0]).toMatchObject({ title: "Anna", subtitle: "Umowa" });
  });

  it("groups mail that came together into at most `together` banners", () => {
    const five = [1, 2, 3, 4, 5].map(() => mail(msg()));
    const plan = planNotices(prefs(), five, false, 0);
    expect(plan.banners).toHaveLength(3);
    // Newest first, then one summary for the rest.
    expect(plan.banners[0]?.key).toBe(five[4]?.message.key);
    expect(plan.banners[2]?.title).toBe("3 more new messages");
    const one = planNotices(
      prefs({ banner: { ...DEFAULT_NOTIFICATION_PREFS.banner, together: 1 } }),
      five,
      false,
      0,
    );
    expect(one.banners.map((b) => b.title)).toEqual(["5 new messages"]);
    expect(plan.inApp).toHaveLength(5);
    expect(plan.badged).toHaveLength(5);
  });

  it("keeps quiet: no banner and no sound, but the window and the badge go on", () => {
    const plan = planNotices(prefs(), [mail(msg())], true, 0);
    expect(plan.banners).toEqual([]);
    expect(plan.sound).toBe(false);
    expect(plan.inApp).toHaveLength(1);
    expect(plan.badged).toHaveLength(1);
  });

  it("names senders shortly and shows the badge as asked", () => {
    const people = ["Anna", "Bartek", "Celina", "Dorota"].map((name) =>
      msg({ from: { name, address: `${name}@x.example` } }),
    );
    expect(fromWhom(people.slice(0, 2))).toBe("Anna and Bartek");
    expect(fromWhom(people.slice(0, 3))).toBe("Anna, Bartek and 1 other");
    expect(fromWhom(people)).toBe("Anna, Bartek and 2 others");
    expect(badgeText(0, "count")).toBe("");
    expect(badgeText(4, "count")).toBe("4");
    expect(badgeText(4, "dot")).toBe("•");
    expect(badgeText(1200, "count")).toBe("999+");
  });
});

/** One folder of one account: each message stored gets the next UID, as a server gives it. */
function folders() {
  const uids = new Map<number, { accountId: string; folderId: string; uid: number }[]>();
  const tops = new Map<string, { accountId: string; folderId: string; uid: number; v: string }>();
  let validity = "1";
  // An empty Inbox has a cursor too: its sync saw it empty.
  tops.set("a1/INBOX", { accountId: "a1", folderId: "INBOX", uid: 0, v: validity });
  const arrivals: NewMailDeps["arrivals"] = {
    marks: async () =>
      [...tops.values()].map((t) => ({
        accountId: t.accountId,
        folderId: t.folderId,
        uidValidity: t.v,
        uid: t.uid,
      })),
    unreadIn: async (spans, limit) => {
      const out: number[] = [];
      for (const [key, places] of uids) {
        if (
          places.some((p) =>
            spans.some(
              (s) =>
                s.accountId === p.accountId &&
                s.folderId === p.folderId &&
                p.uid > s.afterUid &&
                p.uid <= s.upToUid,
            ),
          )
        ) {
          out.push(key);
        }
      }
      return out.sort((a, b) => b - a).slice(0, limit);
    },
  };
  return {
    arrivals,
    /** Stores the message at the top of the folder (new mail) or under it (a backfill). */
    put(key: number, accountId = "a1", folderId = "INBOX", below = false) {
      const id = `${accountId}/${folderId}`;
      const top = tops.get(id) ?? { accountId, folderId, uid: 0, v: validity };
      const uid = below ? 0 : top.uid + 1;
      if (!below) tops.set(id, { ...top, uid, v: validity });
      else tops.set(id, top);
      uids.set(key, [...(uids.get(key) ?? []), { accountId, folderId, uid }]);
    },
    resetValidity(v: string) {
      validity = v;
      for (const [id, t] of tops) tops.set(id, { ...t, v });
    },
  };
}

describe("NewMailWatch (ADR 0106, rule 1)", () => {
  function rig(start: Message[], shared?: ReturnType<typeof folders>) {
    let now = 1_000_000;
    const store = new Map<number, Message>(start.map((m) => [m.key, m]));
    const box = shared ?? folders();
    if (!shared) for (const m of start) box.put(m.key);
    const sent = new Set<string>();
    const searchChunk = vi.fn(async (_q: unknown, _o: { limit: number }) => ({
      keys: [...store.values()]
        .filter((m) => !m.flags.seen)
        .map((m) => m.key)
        .sort((a, b) => b - a),
    }));
    const matchesAmong = vi.fn(async (_q: unknown, keys: readonly number[]) =>
      keys.filter((k) => store.get(k)?.subject.includes("faktura")),
    );
    const deps: NewMailDeps = {
      index: { searchChunk, matchesAmong } as unknown as NewMailDeps["index"],
      store: {
        getByKeys: async (keys) =>
          keys.map((k) => store.get(k)).filter((m): m is Message => m !== undefined),
        getThread: async (id) =>
          sent.has(id)
            ? ({
                thread: { id },
                messages: [msg({ threadId: id, mailboxes: MAILBOX_BIT.sent })],
              } as never)
            : null,
      },
      arrivals: {
        marks: () => box.arrivals.marks(),
        unreadIn: async (spans, limit) =>
          (await box.arrivals.unreadIn(spans, limit)).filter((k) => !store.get(k)?.flags.seen),
      },
      views: {
        list: async () => [
          { id: "v1", name: "Faktury", query: "faktura", position: 0, createdMs: 0, updatedMs: 0 },
        ],
      },
      accounts: {
        list: async () => [{ id: "a1", address: "me@example.com", displayName: "Me" }] as never,
      },
      now: () => now,
    };
    return {
      watch: new NewMailWatch(deps),
      deps,
      box,
      store,
      add(m: Message, folder = "INBOX", account = "a1") {
        store.set(m.key, m);
        box.put(m.key, account, folder);
      },
      backfill(m: Message) {
        store.set(m.key, m);
        box.put(m.key, "a1", "INBOX", true);
      },
      read(key: number) {
        const m = store.get(key) as Message;
        store.set(key, { ...m, flags: { ...m.flags, seen: true } });
      },
      sent,
      later(ms: number) {
        now += ms;
      },
    };
  }

  it("announces nothing that was there at the start, and each message once", async () => {
    const old = msg();
    const r = rig([old]);
    await r.watch.start();
    expect(await r.watch.look()).toEqual([]);
    const fresh = msg({ subject: "faktura 12" });
    r.add(fresh);
    const found = await r.watch.look(["v1"]);
    expect(found.map((f) => f.message.key)).toEqual([fresh.key]);
    expect(found[0]).toMatchObject({ inbox: true, fromMe: false, youWrote: false, views: ["v1"] });
    expect(await r.watch.look(["v1"])).toEqual([]);
  });

  it("judges by arrival: a late or oddly dated message is new, a backfill is not", async () => {
    const r = rig([msg()]);
    await r.watch.start();
    // A Date header years old, delivered now: above the mark, so it arrived.
    const late = msg({ key: 7, dateMs: 0 });
    r.add(late);
    // Older mail the sync reaches below the mark: it was there before.
    r.backfill(msg({ key: 9_000_000 }));
    expect((await r.watch.look()).map((f) => f.message.key)).toEqual([7]);
  });

  it("takes an account added today, a new folder and a new UIDVALIDITY as there", async () => {
    const r = rig([msg()]);
    await r.watch.start();
    r.add(msg(), "INBOX", "a2");
    r.add(msg(), "Archive");
    expect(await r.watch.look()).toEqual([]);
    // Their next mail is new, now that they have a mark.
    const next = msg();
    r.add(next, "INBOX", "a2");
    expect((await r.watch.look()).map((f) => f.message.key)).toEqual([next.key]);
    r.box.resetValidity("2");
    r.add(msg());
    expect(await r.watch.look()).toEqual([]);
  });

  it("tells a message in two folders once", async () => {
    const r = rig([msg()]);
    await r.watch.start();
    const m = msg();
    r.add(m);
    expect(await r.watch.look()).toHaveLength(1);
    r.box.put(m.key, "a1", "INBOX");
    expect(await r.watch.look()).toEqual([]);
  });

  it("knows your own mail and threads you wrote in", async () => {
    const r = rig([]);
    await r.watch.start();
    const mine = msg({ from: { address: "Me@Example.com" } });
    const reply = msg();
    r.sent.add(reply.threadId);
    r.add(mine);
    r.add(reply);
    const found = await r.watch.look();
    expect(found.find((f) => f.message.key === mine.key)?.fromMe).toBe(true);
    expect(found.find((f) => f.message.key === reply.key)?.youWrote).toBe(true);
  });

  it("counts followed mail until it is read", async () => {
    const r = rig([]);
    await r.watch.start();
    const a = msg();
    const b = msg();
    r.add(a);
    r.add(b);
    await r.watch.look();
    r.watch.follow([a.key, b.key]);
    expect(await r.watch.notifiedUnread()).toBe(2);
    r.read(a.key);
    expect(await r.watch.notifiedUnread()).toBe(1);
    expect(await r.watch.inboxUnread()).toBe(1);
  });

  it("goes on from what it kept: mail that came while closed, and the badge", async () => {
    const box = folders();
    const first = rig([], box);
    await first.watch.start();
    const a = msg();
    const b = msg();
    first.add(a);
    first.add(b);
    await first.watch.look();
    first.watch.follow([a.key, b.key]);
    const kept = readWatchState(JSON.parse(JSON.stringify(first.watch.snapshot())));
    expect(kept).not.toBeNull();

    // Closed: one more arrives, and `a` is read elsewhere.
    const second = rig([a, b], box);
    const c = msg();
    second.add(c);
    second.read(a.key);
    await second.watch.start(kept);
    expect(await second.watch.notifiedUnread()).toBe(1);
    expect((await second.watch.look()).map((f) => f.message.key)).toEqual([c.key]);

    // Without what it kept, the same watch takes all of it as there.
    const fresh = rig([a, b, c], box);
    fresh.add(msg());
    await fresh.watch.start(null);
    expect(await fresh.watch.look()).toEqual([]);
  });

  it("lets go of what it told after 48 hours", async () => {
    const r = rig([]);
    await r.watch.start();
    r.add(msg());
    await r.watch.look();
    expect(r.watch.snapshot().told).toHaveLength(1);
    r.later(49 * 60 * 60_000);
    await r.watch.look();
    expect(r.watch.snapshot().told).toEqual([]);
  });
});

describe("arrival marks and the kept state (ADR 0106)", () => {
  const mark = (folderId: string, uid: number, uidValidity = "1") => ({
    accountId: "a1",
    folderId,
    uidValidity,
    uid,
  });

  it("gives the UIDs that came since each folder's mark", () => {
    const { spans, marks } = arrivalsBetween(
      [mark("INBOX", 10), mark("Sent", 4), mark("Old", 2)],
      [mark("INBOX", 13), mark("Sent", 4, "9"), mark("New", 50)],
    );
    expect(spans).toEqual([
      { accountId: "a1", folderId: "INBOX", uidValidity: "1", afterUid: 10, upToUid: 13 },
    ]);
    expect(marks).toEqual([mark("INBOX", 13), mark("Sent", 4, "9"), mark("New", 50)]);
    // A mark never goes back.
    expect(arrivalsBetween([mark("INBOX", 10)], [mark("INBOX", 8)]).marks).toEqual([
      mark("INBOX", 10),
    ]);
  });

  it("defends the kept state field by field", () => {
    expect(readWatchState(undefined)).toBeNull();
    expect(readWatchState({ marks: [] })).toBeNull();
    const read = readWatchState({
      lookedAtMs: 5,
      marks: [mark("INBOX", 3), { accountId: "a1", folderId: "X", uidValidity: 1, uid: 2 }],
      badged: [1, 1, -2, "x", 4],
      told: [
        { key: 1, threadId: "t", atMs: 2, channels: { banner: true } },
        { key: 1, threadId: "t", atMs: 2 },
        { key: "2", threadId: "t", atMs: 2 },
      ],
    });
    expect(read).toEqual({
      lookedAtMs: 5,
      marks: [mark("INBOX", 3)],
      badged: [1, 4],
      told: [
        {
          key: 1,
          threadId: "t",
          atMs: 2,
          channels: { banner: true, inApp: false, badge: false },
        },
      ],
    });
  });

  it("still reads a file from before ADR 0117, and drops its deadlines and decisions", () => {
    const read = readWatchState({
      lookedAtMs: 5,
      marks: [mark("INBOX", 3)],
      badged: [4],
      told: [{ key: 1, threadId: "t", atMs: 2, channels: { banner: true }, decided: false }],
      dues: { "t@0": 86_400_000, bad: "x" },
      duesHeld: { a: 5, b: 6 },
    });
    expect(read).toEqual({
      lookedAtMs: 5,
      marks: [mark("INBOX", 3)],
      badged: [4],
      told: [
        {
          key: 1,
          threadId: "t",
          atMs: 2,
          channels: { banner: true, inApp: false, badge: false },
        },
      ],
    });
  });
});

describe("what came while the app was closed (ADR 0106, rule 2)", () => {
  const now = 100 * 86_400_000;

  it("is one notice inside, with no banner and no sound", () => {
    const people = ["Anna", "Bartek", "Celina", "Dorota"].map((name) =>
      mail(msg({ dateMs: now - 3_600_000, from: { name, address: `${name}@x.example` } })),
    );
    const plan = planCatchUp(prefs(), people, now);
    expect(plan.banners).toEqual([]);
    expect(plan.sound).toBe(false);
    expect(plan.inApp).toEqual([
      expect.objectContaining({
        title: "4 new messages while Matters was closed",
        body: "From Dorota, Celina and 2 others",
        key: people[3]?.message.key,
      }),
    ]);
    expect(plan.badged).toHaveLength(4);
    expect(plan.told.every((t) => !t.channels.banner && t.channels.inApp)).toBe(true);
  });

  it("counts only what would notify now, and only the last days", () => {
    const list = mail(msg({ dateMs: now, automated: true }));
    const old = mail(msg({ dateMs: now - (CATCH_UP_DAYS + 1) * 86_400_000 }));
    const read = mail(
      msg({ dateMs: now, flags: { seen: true, flagged: false, answered: false, draft: false } }),
    );
    expect(planCatchUp(prefs(), [list, old, read], now).inApp).toEqual([]);
    const one = planCatchUp(prefs(), [list, mail(msg({ dateMs: now }))], now);
    expect(one.inApp[0]?.title).toBe("1 new message while Matters was closed");
    // The badge follows its own column.
    const noBadge = prefs({
      kinds: {
        ...DEFAULT_NOTIFICATION_PREFS.kinds,
        people: { banner: true, inApp: true, badge: false },
      },
    });
    expect(planCatchUp(noBadge, [mail(msg({ dateMs: now }))], now).badged).toEqual([]);
  });
});

describe("local time, pause and old mail (ADR 0108)", () => {
  const day = 86_400_000;
  const hour = 3_600_000;
  /** Warsaw: UTC+1 in winter, UTC+2 from the last Sunday of March (here: from day 100). */
  const warsaw = (ms: number) => (ms >= 100 * day + hour ? 120 : 60);

  it("reads the minute of the local day from the zone", () => {
    expect(localMinuteOf(10 * day + 23 * hour, () => 60)).toBe(0);
    expect(localMinuteOf(10 * day, () => -300)).toBe(19 * 60);
    expect(localMinuteOf(10 * day + 30 * 60_000, () => 0)).toBe(30);
  });

  it("pauses for an hour, or until 8:00 tomorrow where the person is", () => {
    const now = 10 * day + 21 * hour + 30 * 60_000; // 22:30 in Warsaw
    expect(pauseUntil("hour", now, warsaw)).toBe(now + hour);
    // 8:00 local on day 11 is 7:00 UTC.
    expect(pauseUntil("tomorrow", now, warsaw)).toBe(11 * day + 7 * hour);
    // Just after local midnight (23:30 UTC) it is still the next morning, not the same one.
    expect(pauseUntil("tomorrow", 10 * day + 23 * hour + 30 * 60_000, warsaw)).toBe(
      12 * day + 7 * hour,
    );
    // Across the change to summer time, 8:00 is 6:00 UTC.
    expect(pauseUntil("tomorrow", 100 * day + 12 * hour, warsaw)).toBe(101 * day + 6 * hour);
  });

  it("says the pause the same way in Settings and in the menu", () => {
    const now = 10 * day + 12 * hour; // 13:00 local
    expect(pausedText(now + hour, now, warsaw)).toBe("Paused until 14:00");
    expect(pausedText(11 * day + 7 * hour, now, warsaw)).toBe("Paused until tomorrow, 08:00");
    const p = DEFAULT_NOTIFICATION_PREFS;
    expect(isPaused({ ...p, pausedUntilMs: now + 1 }, now)).toBe(true);
    expect(isPaused({ ...p, pausedUntilMs: now }, now)).toBe(false);
  });

  it("knows when banners may go again: after the pause and after the quiet hours", () => {
    const quiet = { on: true, fromMin: 22 * 60, toMin: 7 * 60 };
    const p = prefs({ quiet });
    const utc = () => 0;
    expect(quietEndsAt(p, 10 * day + 12 * hour, utc)).toBe(10 * day + 12 * hour);
    expect(quietEndsAt(p, 10 * day + 23 * hour, utc)).toBe(11 * day + 7 * hour);
    expect(quietEndsAt(p, 11 * day + hour, utc)).toBe(11 * day + 7 * hour);
    // A pause that ends inside the quiet hours waits for them too, and the other way round.
    const pausedToNight = prefs({ quiet, pausedUntilMs: 10 * day + 23 * hour });
    expect(quietEndsAt(pausedToNight, 10 * day + 20 * hour, utc)).toBe(11 * day + 7 * hour);
    const pausedPastMorning = prefs({ quiet, pausedUntilMs: 11 * day + 9 * hour });
    expect(quietEndsAt(pausedPastMorning, 11 * day + hour, utc)).toBe(11 * day + 9 * hour);
  });

  it("never notifies for old mail that only moved; mail late by a day still does", () => {
    const now = 100 * day;
    const moved = msg({ dateMs: now - (CATCH_UP_DAYS * day + 1) });
    const late = msg({ dateMs: now - day });
    expect(isOldMail(moved, now)).toBe(true);
    expect(isOldMail(late, now)).toBe(false);
    const none = { banner: false, inApp: false, badge: false };
    expect(channelsOf(prefs(), mail(moved), now)).toEqual(none);
    const plan = planNotices(prefs(), [mail(moved), mail(late)], false, now);
    expect(plan.banners.map((b) => b.key)).toEqual([late.key]);
    expect(plan.badged).toEqual([late.key]);
    const all = { banner: true, inApp: true, badge: true };
    const prompted = planPromptNotices(
      prefs({ views: { v1: all } }),
      [{ message: moved, told: none, views: ["v1"] }],
      false,
      now,
    );
    expect(prompted.banners).toEqual([]);
    expect(prompted.inApp).toEqual([]);
  });

  it("marks single banners, which can act and be taken back, and not summaries", () => {
    const five = [1, 2, 3, 4, 5].map(() => mail(msg()));
    const plan = planNotices(prefs(), five, false, 0);
    expect(plan.banners.map((b) => b.alone === true)).toEqual([true, true, false]);
    expect(plan.inApp.some((n) => n.alone === true)).toBe(false);
  });
});

describe("NewMailWatch checks banners (ADR 0108)", () => {
  function watchOf(store: Map<number, Message>) {
    const deps = {
      index: {} as NewMailDeps["index"],
      store: {
        getByKeys: vi.fn(async (keys: readonly number[]) =>
          keys.map((k) => store.get(k)).filter((m): m is Message => m !== undefined),
        ),
        getThread: async () => null,
      },
      arrivals: { marks: async () => [], unreadIn: async () => [] },
      views: { list: async () => [] },
      accounts: { list: async () => [] },
      now: () => 1000,
    } satisfies NewMailDeps;
    return { watch: new NewMailWatch(deps), deps };
  }

  it("checks the banners still out in the badge's own read", async () => {
    const a = msg();
    const b = msg();
    const store = new Map([
      [a.key, a],
      [b.key, b],
    ]);
    const { watch, deps } = watchOf(store);
    await watch.start();
    watch.follow([a.key]);
    const r = await watch.recount([b.key, 424242]);
    expect(r.notified).toBe(1);
    expect(r.also.map((m) => m.key)).toEqual([b.key]);
    expect(deps.store.getByKeys).toHaveBeenCalledTimes(1);
    // Nothing followed and nothing out: no read at all.
    const { watch: empty, deps: emptyDeps } = watchOf(store);
    await empty.start();
    expect(await empty.recount([])).toEqual({ notified: 0, also: [] });
    expect(emptyDeps.store.getByKeys).not.toHaveBeenCalled();
  });
});

describe("views with a prompt (ADR 0117, rule 6)", () => {
  const none = { banner: false, inApp: false, badge: false };
  const all = { banner: true, inApp: true, badge: true };
  const withView = prefs({ views: { v1: all } });

  it("rings through the view's channels the mail did not go through, and never twice", () => {
    const anna = msg({ from: { name: "Anna", address: "anna@x.example" }, subject: "Lease" });
    const quiet = planPromptNotices(
      withView,
      [{ message: anna, told: none, views: ["v1"] }],
      false,
      0,
    );
    expect(quiet.banners).toEqual([expect.objectContaining({ title: "Anna", body: "Lease" })]);
    expect(quiet.inApp).toHaveLength(1);
    expect(quiet.badged).toEqual([anna.key]);
    expect(quiet.told).toEqual([{ key: anna.key, channels: all }]);
    const already = planPromptNotices(
      withView,
      [{ message: anna, told: all, views: ["v1"] }],
      false,
      0,
    );
    expect(already.banners).toEqual([]);
    expect(already.inApp).toEqual([]);
    expect(already.badged).toEqual([]);
    // A view that does not notify adds nothing; read mail never rings.
    expect(
      planPromptNotices(prefs(), [{ message: anna, told: none, views: ["v1"] }], false, 0).banners,
    ).toEqual([]);
    const read = { ...anna, flags: { ...anna.flags, seen: true } };
    expect(
      planPromptNotices(withView, [{ message: read, told: none, views: ["v1"] }], false, 0).banners,
    ).toEqual([]);
  });

  it("keeps what a view waits for in the watch's file, defended like the rest", () => {
    const state = readWatchState({
      lookedAtMs: 1,
      marks: [],
      badged: [],
      told: [
        { key: 1, threadId: "t", atMs: 1, channels: none, waiting: ["v1", 3, "v1"] },
        { key: 2, threadId: "t", atMs: 1, channels: none, waiting: [] },
        { key: 3, threadId: "t", atMs: 1, channels: none, waiting: "v1" },
      ],
    });
    expect(state?.told.map((t) => t.waiting)).toEqual([["v1"], undefined, undefined]);
  });

  it("holds new mail a prompt view's filters match, a prompt alone holding all of it", async () => {
    let now = 1_000_000;
    const store = new Map<number, Message>();
    let top = 0;
    const uids = new Map<number, number>();
    const deps: NewMailDeps = {
      index: {
        searchChunk: async () => ({ keys: [] }),
        matchesAmong: async (_q: unknown, keys: readonly number[]) =>
          keys.filter((k) => store.get(k)?.subject.includes("faktura")),
      } as unknown as NewMailDeps["index"],
      store: {
        getByKeys: async (keys) =>
          keys.map((k) => store.get(k)).filter((m): m is Message => m !== undefined),
        getThread: async () => null,
      },
      arrivals: {
        marks: async () => [{ accountId: "a1", folderId: "INBOX", uidValidity: "1", uid: top }],
        unreadIn: async (spans) =>
          [...uids]
            .filter(([, uid]) => spans.some((s) => uid > s.afterUid && uid <= s.upToUid))
            .map(([key]) => key),
      },
      views: {
        list: async () =>
          [
            { id: "plain", query: "faktura" },
            { id: "asks", query: 'faktura prompt:"to pay"' },
            { id: "alone", query: 'prompt:"needs me"' },
          ].map((v) => ({ ...v, name: v.id, position: 0, createdMs: 0, updatedMs: 0 })),
      },
      accounts: {
        list: async () => [{ id: "a1", address: "me@example.com", displayName: "Me" }] as never,
      },
      now: () => now,
    };
    const watch = new NewMailWatch(deps);
    await watch.start();
    const add = (m: Message) => {
      store.set(m.key, m);
      uids.set(m.key, ++top);
    };
    const bill = msg({ subject: "faktura 3" });
    const hello = msg({ subject: "hello" });
    const mine = msg({ subject: "faktura 4", from: { name: "Me", address: "me@example.com" } });
    add(bill);
    add(hello);
    add(mine);
    const found = await watch.look(["plain", "asks", "alone"]);
    const byKey = new Map(found.map((f) => [f.message.key, f]));
    // The plain view notifies now; the views with a prompt hold it.
    expect(byKey.get(bill.key)).toMatchObject({ views: ["plain"], prompted: ["asks", "alone"] });
    expect(byKey.get(hello.key)).toMatchObject({ views: [], prompted: ["alone"] });
    // Your own mail waits for nothing.
    expect(watch.waiting().map((t) => [t.key, t.waiting])).toEqual([
      [hello.key, ["alone"]],
      [bill.key, ["asks", "alone"]],
    ]);
    watch.settle(bill.key, ["asks"]);
    expect(watch.waiting().find((t) => t.key === bill.key)?.waiting).toEqual(["alone"]);
    watch.settle(bill.key, ["alone"]);
    expect(watch.waiting().map((t) => t.key)).toEqual([hello.key]);
    // Kept across a restart; let go with the mail after 48 hours.
    const again = new NewMailWatch(deps);
    await again.start(watch.snapshot());
    expect(again.waiting().map((t) => t.key)).toEqual([hello.key]);
    now += 49 * 60 * 60_000;
    await again.look([]);
    expect(again.waiting()).toEqual([]);
  });
});
