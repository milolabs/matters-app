import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendEvent, NoticeToMain } from "@matters/contracts";
import {
  DEFAULT_NOTIFICATION_PREFS,
  MAILBOX_BIT,
  type Message,
  type NewMailDeps,
  type NoticeText,
  type NotificationPrefs,
  type ThreadAnalysis,
} from "@matters/core";
import { afterEach, describe, expect, it } from "vitest";
import { handle } from "../src/backend/handler.ts";
import { type MattersSource, Notifier } from "../src/backend/notifier.ts";
import {
  bundleIdOf,
  bundleOf,
  MATTERS_BUNDLE_ID,
  NOTIFICATION_SETTINGS_URL,
  noticeSystem,
} from "../src/main/noticeSystem.ts";
import {
  type Banner,
  type BannerOptions,
  NoticeShower,
  noticeFrom,
  type PauseState,
  pauseMenu,
  pauseTarget,
} from "../src/main/notices.ts";
import { createNoticeBridge } from "../src/preload/noticeBridge.ts";
import { clear, dismiss, EMPTY, moreText, push, tick } from "../src/renderer/noticeStack.ts";

let n = 0;
function msg(over: Partial<Message> = {}): Message {
  n += 1;
  return {
    key: 5000 + n,
    accountId: "a1",
    providerId: `p${n}`,
    threadId: `t${n}`,
    messageIdHeader: `<p${n}@x>`,
    // Mail of the rig's day: older mail only moved and never notifies (ADR 0108).
    dateMs: 1_000_000_000,
    from: { name: `Person ${n}`, address: `p${n}@northwind.example` },
    to: [],
    cc: [],
    subject: `Subject ${n}`,
    snippet: `Line ${n}`,
    flags: { seen: false, flagged: false, answered: false, draft: false },
    labelIds: [],
    hasAttachments: false,
    senderAuth: "unknown",
    mailboxes: MAILBOX_BIT.inbox,
    ...over,
  };
}

/**
 * Unread mail in a map, as the reader connection would answer for it. Each message stored gets
 * the next UID of the one folder, as a server gives it; `arrivals` answers from those.
 */
function mailbox() {
  const store = new Map<number, Message>();
  const uids = new Map<number, number>();
  let top = 0;
  const read: Omit<NewMailDeps, "now"> = {
    index: {
      searchChunk: async () => ({
        keys: [...store.values()]
          .filter((m) => !m.flags.seen)
          .map((m) => m.key)
          .sort((a, b) => b - a),
      }),
      matchesAmong: async () => [],
    },
    store: {
      getByKeys: async (keys) =>
        keys.map((k) => store.get(k)).filter((m): m is Message => m !== undefined),
      getThread: async () => null,
    },
    arrivals: {
      marks: async () => [{ accountId: "a1", folderId: "INBOX", uidValidity: "1", uid: top }],
      unreadIn: async (spans) =>
        [...uids]
          .filter(
            ([key, uid]) =>
              !store.get(key)?.flags.seen &&
              spans.some((s) => uid > s.afterUid && uid <= s.upToUid),
          )
          .map(([key]) => key)
          .sort((a, b) => b - a),
    },
    views: { list: async () => [] },
    accounts: { list: async () => [{ id: "a1", address: "me@example.com" }] as never },
  };
  return {
    store,
    read,
    /** A message delivered now. */
    deliver(m: Message) {
      store.set(m.key, m);
      top += 1;
      uids.set(m.key, top);
    },
  };
}

/**
 * The settings most of these tests run with: the badge counts mail it told about, as it did
 * before ADR 0109 made what is in Matters the default.
 */
const NOTIFIED: NotificationPrefs = {
  ...DEFAULT_NOTIFICATION_PREFS,
  badge: { source: "notified", style: "count" },
};

/** The agent's readings, as the reader connection would give them. */
function agent() {
  const readings = new Map<string, ThreadAnalysis>();
  const shows = new Set<string>();
  // What the Matters tab would count, and how often it was counted (ADR 0109).
  const matters = { count: 0, reads: 0, fails: false };
  const things: MattersSource = {
    count: async () => {
      matters.reads += 1;
      if (matters.fails) throw new Error("read failed");
      return matters.count;
    },
    readings: async (ids) =>
      [...readings.values()].filter((a) => ids === undefined || ids.includes(a.threadId)),
    shown: async (threadId) => {
      const analysis = readings.get(threadId);
      return analysis !== undefined && shows.has(threadId) ? { analysis, accountId: "a1" } : null;
    },
  };
  return {
    things,
    matters,
    /** The agent read the thread at `atMs`; `matters` says whether it shows in Matters. */
    reads(threadId: string, atMs: number, matters: boolean, facts: ThreadAnalysis["facts"] = []) {
      readings.set(threadId, {
        threadId,
        lastMessageKey: 1,
        analyzerVersion: 1,
        state: "onYou",
        headline: `Thing of ${threadId}`,
        facts,
        stakes: "none",
        confidence: 0.9,
        analyzedAtMs: atMs,
      });
      if (matters) shows.add(threadId);
      else shows.delete(threadId);
    },
  };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface RigOptions {
  readonly prefsPath?: string | null;
  readonly statePath?: string | null;
  readonly minute?: number;
  readonly box?: ReturnType<typeof mailbox>;
  readonly brain?: ReturnType<typeof agent>;
  readonly clock?: { now: number };
  readonly catchUpMaxMs?: number;
  readonly dueEveryMs?: number;
  /** The settings to start from; NOTIFIED when absent. */
  readonly prefs?: NotificationPrefs;
  readonly countGapMs?: number;
  /** Without the agent's readings at all. */
  readonly noThings?: boolean;
}

function rig(prefsPath: string | null = null, minute = 12 * 60, more: RigOptions = {}) {
  const box = more.box ?? mailbox();
  const brain = more.brain ?? agent();
  const clock = more.clock ?? { now: 1_000_000_000 };
  // A zone where the rig's start is `minute` past local midnight.
  const offset = minute - (Math.floor(clock.now / 60_000) % (24 * 60));
  const toMain: NoticeToMain[] = [];
  const events: BackendEvent[] = [];
  const notifier = new Notifier({
    read: box.read,
    prefsPath,
    statePath: more.statePath ?? null,
    prefs: more.prefs ?? NOTIFIED,
    ...(more.noThings === true ? {} : { things: brain.things }),
    ...(more.countGapMs === undefined ? {} : { countGapMs: more.countGapMs }),
    toMain: (e) => toMain.push(e),
    broadcast: (e) => events.push(e),
    zone: () => offset,
    now: () => clock.now,
    delayMs: 0,
    agentDelayMs: 0,
    ...(more.catchUpMaxMs === undefined ? {} : { catchUpMaxMs: more.catchUpMaxMs }),
    ...(more.dueEveryMs === undefined ? {} : { dueEveryMs: more.dueEveryMs }),
  });
  return { box, brain, clock, toMain, events, notifier };
}

async function settle(r: ReturnType<typeof rig>) {
  r.notifier.touched();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await r.notifier.idle();
}

async function agentDone(r: ReturnType<typeof rig>) {
  r.notifier.agentChanged();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await r.notifier.idle();
}

const bannersOf = (r: ReturnType<typeof rig>) =>
  r.toMain.flatMap((e) => (e.type === "banners" ? e.banners : []));
const noticesOf = (r: ReturnType<typeof rig>) =>
  r.events.flatMap((e) => (e.type === "notices" ? e.notices : []));

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "matters-notify-"));
  dirs.push(dir);
  return dir;
}

describe("Notifier, the router's notifications (ADR 0071)", () => {
  it("rings nothing at the start, then banners, notices and the badge for new mail", async () => {
    const r = rig();
    r.box.deliver(msg({ key: 1 }));
    await r.notifier.start();
    await r.notifier.idle();
    expect(r.toMain.filter((e) => e.type === "banners")).toEqual([]);
    expect(r.events).toEqual([]);

    const anna = msg({ from: { name: "Anna", address: "anna@x.example" }, subject: "Umowa" });
    r.box.deliver(anna);
    await settle(r);
    const banners = r.toMain.find((e) => e.type === "banners");
    expect(banners).toMatchObject({ banners: [{ title: "Anna", body: "Umowa" }], sound: true });
    expect(r.events).toEqual([
      expect.objectContaining({ type: "notices", seconds: 6, notices: [expect.anything()] }),
    ]);
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "1" });

    // Read: the badge clears, and nothing rings again.
    r.box.store.set(anna.key, { ...anna, flags: { ...anna.flags, seen: true } });
    await settle(r);
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "" });
    expect(r.toMain.filter((e) => e.type === "banners")).toHaveLength(1);
  });

  it("keeps quiet at night, but still notices inside and counts", async () => {
    const r = rig(null, 23 * 60);
    await r.notifier.start();
    await r.notifier.set({
      ...NOTIFIED,
      quiet: { on: true, fromMin: 1320, toMin: 420 },
    });
    r.box.deliver(msg({ key: 1 }));
    await settle(r);
    expect(r.toMain.filter((e) => e.type === "banners")).toEqual([]);
    expect(r.events.some((e) => e.type === "notices")).toBe(true);
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "1" });
  });

  it("keeps the settings in a file and tells every window", async () => {
    const dir = await tempDir();
    const path = join(dir, "notifications.json");
    const r = rig(path);
    await r.notifier.start();
    const kept = await r.notifier.set({
      ...DEFAULT_NOTIFICATION_PREFS,
      badge: { source: "off", style: "dot" },
    });
    expect(kept.badge.source).toBe("off");
    expect(JSON.parse(await readFile(path, "utf8")).badge).toEqual({ source: "off", style: "dot" });
    expect(r.events.at(-1)).toEqual({ type: "notificationPrefsChanged", prefs: kept });

    const again = rig(path);
    await again.notifier.start();
    expect(again.notifier.get().badge.source).toBe("off");
  });

  it("sends a test through the channels as they say it", async () => {
    const r = rig();
    await r.notifier.start();
    await r.notifier.set({
      ...DEFAULT_NOTIFICATION_PREFS,
      banner: { ...DEFAULT_NOTIFICATION_PREFS.banner, content: "minimal" },
    });
    r.notifier.test();
    const banners = r.toMain.find((e) => e.type === "banners");
    expect(banners).toMatchObject({ whenFront: true, banners: [{ title: "New mail", key: 0 }] });
    expect(JSON.stringify(banners)).not.toContain("Anna");
  });
});

describe("Notifier across a restart (ADR 0106, rule 2)", () => {
  it("announces nothing on a first run, and keeps its state in a private file", async () => {
    const statePath = join(await tempDir(), "notifications-state.json");
    const r = rig(null, 12 * 60, { statePath });
    r.box.deliver(msg());
    await r.notifier.start();
    await r.notifier.idle();
    expect(r.events).toEqual([]);
    r.box.deliver(msg());
    await settle(r);
    const kept = JSON.parse(await readFile(statePath, "utf8"));
    expect(kept.marks).toEqual([{ accountId: "a1", folderId: "INBOX", uidValidity: "1", uid: 2 }]);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });

  it("says what came while closed once, with no banner, and restores the badge", async () => {
    const statePath = join(await tempDir(), "notifications-state.json");
    const box = mailbox();
    const first = rig(null, 12 * 60, { statePath, box });
    await first.notifier.start();
    const seen = msg();
    const unseen = msg();
    box.deliver(seen);
    box.deliver(unseen);
    await settle(first);
    expect(first.toMain.at(-1)).toEqual({ type: "badge", text: "2" });
    first.notifier.stop();

    // Closed: `seen` was read elsewhere, and three came, one of them from a list.
    box.store.set(seen.key, { ...seen, flags: { ...seen.flags, seen: true } });
    box.deliver(
      msg({ dateMs: first.clock.now, from: { name: "Anna", address: "anna@x.example" } }),
    );
    box.deliver(
      msg({ dateMs: first.clock.now, from: { name: "Bartek", address: "bartek@x.example" } }),
    );
    box.deliver(msg({ dateMs: first.clock.now, automated: true }));

    const second = rig(null, 12 * 60, { statePath, box });
    second.clock.now = first.clock.now + 3_600_000;
    await second.notifier.start();
    await second.notifier.idle();
    // It waits for the first sync: mail it brings belongs to the catch-up too.
    expect(noticesOf(second)).toEqual([]);
    box.deliver(
      msg({ dateMs: first.clock.now, from: { name: "Celina", address: "celina@x.example" } }),
    );
    await settle(second);
    expect(noticesOf(second)).toEqual([]);
    second.notifier.synced("a1");
    await second.notifier.idle();

    expect(bannersOf(second)).toEqual([]);
    expect(noticesOf(second)).toEqual([
      expect.objectContaining({
        title: "3 new messages while Matters was closed",
        body: "From Celina, Bartek and 1 other",
      }),
    ]);
    // The one followed before and still unread, and the three of the catch-up.
    expect(second.toMain.at(-1)).toEqual({ type: "badge", text: "4" });

    // After the catch-up, new mail rings as always; a window that opens now gets the catch-up.
    box.deliver(msg({ from: { name: "Dorota", address: "dorota@x.example" } }));
    await settle(second);
    expect(bannersOf(second)).toEqual([expect.objectContaining({ title: "Dorota" })]);
    const opened: BackendEvent[] = [];
    const before = second.events.length;
    second.notifier.windowOpened((e) => opened.push(e));
    expect(opened).toEqual([
      expect.objectContaining({
        notices: [expect.objectContaining({ title: "3 new messages while Matters was closed" })],
      }),
    ]);
    // Only the window that opened: the others have it already.
    expect(second.events.length).toBe(before);
    second.notifier.stop();

    // A third start finds nothing new: the catch-up is not said again.
    const third = rig(null, 12 * 60, { statePath, box });
    third.clock.now = second.clock.now + 60_000;
    await third.notifier.start();
    third.notifier.synced("a1");
    await third.notifier.idle();
    expect(noticesOf(third)).toEqual([]);
    expect(bannersOf(third)).toEqual([]);
    third.notifier.stop();
  });
});

describe("Notifier, a catch-up that cannot wait for the sync (ADR 0106, rule 2)", () => {
  it("is said when an account never finishes its first sync", async () => {
    const statePath = join(await tempDir(), "notifications-state.json");
    const box = mailbox();
    const first = rig(null, 12 * 60, { statePath, box });
    await first.notifier.start();
    box.deliver(msg());
    await settle(first);
    first.notifier.stop();
    box.deliver(msg({ dateMs: first.clock.now }));
    const second = rig(null, 12 * 60, { statePath, box, catchUpMaxMs: 10 });
    await second.notifier.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await second.notifier.idle();
    expect(noticesOf(second).map((n) => n.title)).toEqual([
      "1 new message while Matters was closed",
    ]);
    second.notifier.stop();
  });
});

describe("Notifier, what the agent says matters (ADR 0106, rule 3)", () => {
  async function started() {
    const r = rig();
    await r.notifier.start();
    await r.notifier.idle();
    return r;
  }

  it("rings when the agent finds that a quiet list's mail matters", async () => {
    const r = await started();
    const list = msg({ automated: true, from: { name: "Bank", address: "bank@x.example" } });
    r.box.deliver(list);
    await settle(r);
    expect(bannersOf(r)).toEqual([]);
    expect(noticesOf(r)).toEqual([]);

    // A reading from before the mail came says nothing about it.
    r.brain.reads(list.threadId, r.clock.now - 10 * 60_000, true);
    await agentDone(r);
    expect(bannersOf(r)).toEqual([]);

    r.clock.now += 5 * 60_000;
    r.brain.reads(list.threadId, r.clock.now, true);
    await agentDone(r);
    expect(bannersOf(r)).toEqual([
      expect.objectContaining({ title: "Bank", body: `Thing of ${list.threadId}` }),
    ]);
    expect(noticesOf(r)).toHaveLength(1);
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "1" });

    // Decided: another pass rings nothing.
    await agentDone(r);
    expect(bannersOf(r)).toHaveLength(1);
  });

  it("adds no second banner to mail that already rang, and nothing for what does not show", async () => {
    const r = await started();
    const anna = msg({ from: { name: "Anna", address: "anna@x.example" } });
    const other = msg();
    r.box.deliver(anna);
    r.box.deliver(other);
    await settle(r);
    expect(bannersOf(r)).toHaveLength(2);
    expect(noticesOf(r)).toHaveLength(2);
    r.clock.now += 60_000;
    r.brain.reads(anna.threadId, r.clock.now, true);
    r.brain.reads(other.threadId, r.clock.now, false);
    await agentDone(r);
    expect(bannersOf(r)).toHaveLength(2);
    expect(noticesOf(r)).toHaveLength(2);
  });

  it("keeps quiet hours, and never rings for mail read since", async () => {
    const r = rig(null, 23 * 60);
    await r.notifier.start();
    await r.notifier.set({
      ...NOTIFIED,
      quiet: { on: true, fromMin: 1320, toMin: 420 },
    });
    const a = msg({ automated: true });
    const b = msg({ automated: true });
    r.box.deliver(a);
    r.box.deliver(b);
    await settle(r);
    r.box.store.set(b.key, { ...b, flags: { ...b.flags, seen: true } });
    r.clock.now += 60_000;
    r.brain.reads(a.threadId, r.clock.now, true);
    r.brain.reads(b.threadId, r.clock.now, true);
    await agentDone(r);
    expect(bannersOf(r)).toEqual([]);
    expect(noticesOf(r).map((n) => n.key)).toEqual([a.key]);
  });

  it("says a deadline once when its day ends within a day, also across a restart", async () => {
    const statePath = join(await tempDir(), "notifications-state.json");
    const day = 86_400_000;
    const clock = { now: 20 * day + 3_600_000 };
    const brain = agent();
    const box = mailbox();
    brain.reads("t-due", 0, true, [
      {
        kind: "promise",
        who: "you",
        dueMs: 20 * day,
        evidence: { quote: "I will pay", messageKey: 1 },
      },
    ]);
    brain.reads("t-later", 0, true, [
      { kind: "ask", who: "you", dueMs: 25 * day, evidence: { quote: "later", messageKey: 1 } },
    ]);
    const first = rig(null, 12 * 60, { statePath, brain, box, clock });
    await first.notifier.start();
    await first.notifier.idle();
    expect(bannersOf(first)).toEqual([
      expect.objectContaining({ title: "Due within a day", body: "Thing of t-due" }),
    ]);
    first.notifier.stop();

    const second = rig(null, 12 * 60, { statePath, brain, box, clock });
    await second.notifier.start();
    await second.notifier.idle();
    expect(bannersOf(second)).toEqual([]);
    second.notifier.stop();
  });
});
describe("Notifier, a badge of what is in Matters (ADR 0109)", () => {
  const badgesOf = (r: ReturnType<typeof rig>) =>
    r.toMain.flatMap((e) => (e.type === "badge" ? [e.text] : []));

  it("counts what is in Matters by default, at the start and after every agent write", async () => {
    const r = rig(null, 12 * 60, { prefs: DEFAULT_NOTIFICATION_PREFS });
    expect(r.notifier.get().badge.source).toBe("matters");
    r.brain.matters.count = 3;
    await r.notifier.start();
    await r.notifier.idle();
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "3" });

    // The person closed one; the agent's write says so.
    r.brain.matters.count = 2;
    await agentDone(r);
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "2" });

    // Nothing left (or AI off: the tab's read counts nothing then): no badge.
    r.brain.matters.count = 0;
    await agentDone(r);
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "" });
    r.notifier.stop();
  });

  it("does not count unread mail it told about, only what is in Matters", async () => {
    const r = rig(null, 12 * 60, { prefs: DEFAULT_NOTIFICATION_PREFS, countGapMs: 0 });
    r.brain.matters.count = 1;
    await r.notifier.start();
    await r.notifier.idle();
    r.box.deliver(msg());
    r.box.deliver(msg());
    await settle(r);
    expect(bannersOf(r)).toHaveLength(2);
    expect(badgesOf(r)).toEqual(["1"]);
    r.notifier.stop();
  });

  it("counts again after mail commits, at most once per gap, and at once on an agent write", async () => {
    const r = rig(null, 12 * 60, { prefs: DEFAULT_NOTIFICATION_PREFS, countGapMs: 60_000 });
    r.brain.matters.count = 4;
    await r.notifier.start();
    await r.notifier.idle();
    expect(r.brain.matters.reads).toBe(1);
    // A run of commits waits for the gap: no read each.
    r.brain.matters.count = 3;
    await settle(r);
    await settle(r);
    await settle(r);
    expect(r.brain.matters.reads).toBe(1);
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "4" });
    // An agent write does not wait, and takes the waiting count along.
    await agentDone(r);
    expect(r.brain.matters.reads).toBe(2);
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "3" });
    r.notifier.stop();

    // With no gap, a commit that took a thing's mail away counts at once.
    const s = rig(null, 12 * 60, { prefs: DEFAULT_NOTIFICATION_PREFS, countGapMs: 0 });
    s.brain.matters.count = 2;
    await s.notifier.start();
    await s.notifier.idle();
    s.brain.matters.count = 1;
    await settle(s);
    expect(s.toMain.at(-1)).toEqual({ type: "badge", text: "1" });
    s.notifier.stop();
  });

  it("tells the windows when mail alone changed the count, and counts at once for the outbox (ADR 0112)", async () => {
    const changed = (r: ReturnType<typeof rig>) =>
      r.events.filter((e) => e.type === "agentChanged").length;
    const r = rig(null, 12 * 60, { prefs: DEFAULT_NOTIFICATION_PREFS, countGapMs: 0 });
    r.brain.matters.count = 2;
    await r.notifier.start();
    await r.notifier.idle();
    // The first count has nothing to compare with; the windows read the list themselves.
    expect(changed(r)).toBe(0);
    // A commit that changes nothing in Matters says nothing.
    await settle(r);
    expect(changed(r)).toBe(0);
    // The person answered from another app: the commit takes the thing out, and the windows hear it.
    r.brain.matters.count = 1;
    await settle(r);
    expect(changed(r)).toBe(1);
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "1" });
    // After an agent write the windows read the list already: no second event.
    r.brain.matters.count = 0;
    await agentDone(r);
    expect(changed(r)).toBe(1);
    // A reply put in the outbox and undone: counted at once, with no gap to wait for.
    r.brain.matters.count = 1;
    const reads = r.brain.matters.reads;
    r.notifier.thingsChanged();
    await r.notifier.idle();
    expect(r.brain.matters.reads).toBe(reads + 1);
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "1" });
    r.notifier.stop();
  });

  it("keeps the last count when a read fails, and shows a dot when asked", async () => {
    const r = rig(null, 12 * 60, { prefs: DEFAULT_NOTIFICATION_PREFS });
    r.brain.matters.count = 5;
    await r.notifier.start();
    await r.notifier.idle();
    r.brain.matters.fails = true;
    r.brain.matters.count = 9;
    await agentDone(r);
    expect(badgesOf(r)).toEqual(["5"]);
    r.brain.matters.fails = false;
    await r.notifier.set({
      ...DEFAULT_NOTIFICATION_PREFS,
      badge: { source: "matters", style: "dot" },
    });
    await r.notifier.idle();
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "•" });
    r.notifier.stop();
  });

  it("counts nothing without the agent, while notifications are off, or for another source", async () => {
    const none = rig(null, 12 * 60, { prefs: DEFAULT_NOTIFICATION_PREFS, noThings: true });
    await none.notifier.start();
    await none.notifier.idle();
    expect(badgesOf(none)).toEqual([""]);

    const r = rig(null, 12 * 60, { prefs: DEFAULT_NOTIFICATION_PREFS });
    r.brain.matters.count = 2;
    await r.notifier.start();
    await r.notifier.idle();
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "2" });
    await r.notifier.set({ ...DEFAULT_NOTIFICATION_PREFS, enabled: false });
    await r.notifier.idle();
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "" });

    // The Inbox's unread, as before; the Matters count is not read for it.
    const reads = r.brain.matters.reads;
    r.box.deliver(msg({ automated: true }));
    await r.notifier.set({
      ...DEFAULT_NOTIFICATION_PREFS,
      badge: { source: "inbox", style: "count" },
    });
    await settle(r);
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "1" });
    await agentDone(r);
    expect(r.brain.matters.reads).toBe(reads);

    // Back to Matters: counted at once.
    await r.notifier.set(DEFAULT_NOTIFICATION_PREFS);
    await r.notifier.idle();
    expect(r.brain.matters.reads).toBe(reads + 1);
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "2" });
    r.notifier.stop();
  });
});

describe("Notifier: banners that act and leave, the pause, old mail, deadlines (ADR 0108)", () => {
  const closesOf = (r: ReturnType<typeof rig>) =>
    r.toMain.flatMap((e) => (e.type === "close" ? e.keys : []));
  const seen = (m: Message): Message => ({ ...m, flags: { ...m.flags, seen: true } });

  it("takes back a banner once its mail is read, archived or deleted, and not before", async () => {
    const r = rig();
    await r.notifier.start();
    const a = msg();
    const b = msg();
    const c = msg();
    const d = msg();
    r.box.deliver(a);
    r.box.deliver(b);
    r.box.deliver(c);
    r.box.deliver(d);
    await settle(r);
    // `together` is 3: two alone and one summary, which is not taken back by its newest mail.
    expect(bannersOf(r).map((x) => x.alone === true)).toEqual([true, true, false]);
    const [first, second] = bannersOf(r);
    await settle(r);
    expect(closesOf(r)).toEqual([]);

    r.box.store.set(first?.key ?? 0, seen(r.box.store.get(first?.key ?? 0) as Message));
    await settle(r);
    expect(closesOf(r)).toEqual([first?.key]);
    const archived = r.box.store.get(second?.key ?? 0) as Message;
    r.box.store.set(archived.key, { ...archived, mailboxes: MAILBOX_BIT.archive });
    await settle(r);
    expect(closesOf(r)).toEqual([first?.key, second?.key]);
    // Said once: nothing more to take back.
    await settle(r);
    expect(closesOf(r)).toHaveLength(2);
  });

  it("takes back a banner of a deleted message, and reads nothing when no banner is out", async () => {
    const r = rig();
    let reads = 0;
    const store = r.box.read.store as { getByKeys: NewMailDeps["store"]["getByKeys"] };
    const getByKeys = store.getByKeys;
    store.getByKeys = (keys) => {
      reads += 1;
      return getByKeys(keys);
    };
    await r.notifier.start();
    await r.notifier.set({
      ...DEFAULT_NOTIFICATION_PREFS,
      badge: { source: "off", style: "count" },
    });
    await r.notifier.idle();
    reads = 0;
    await settle(r);
    expect(reads).toBe(0);

    const a = msg();
    r.box.deliver(a);
    await settle(r);
    expect(bannersOf(r)).toHaveLength(1);
    r.box.store.delete(a.key);
    reads = 0;
    await settle(r);
    expect(closesOf(r)).toEqual([a.key]);
    // One read for the banner out; none once it is gone.
    expect(reads).toBe(1);
    reads = 0;
    await settle(r);
    expect(reads).toBe(0);
  });

  it("does not ring for old mail that was only moved in; mail a day late still rings", async () => {
    const r = rig();
    await r.notifier.start();
    const day = 86_400_000;
    r.box.deliver(msg({ dateMs: r.clock.now - 8 * day, subject: "Old, moved" }));
    r.box.deliver(msg({ dateMs: r.clock.now - day, subject: "Late" }));
    await settle(r);
    expect(bannersOf(r).map((x) => x.body)).toEqual(["Late"]);
    expect(noticesOf(r).map((x) => x.subtitle)).toEqual(["Late"]);
    expect(r.toMain.at(-1)).toEqual({ type: "badge", text: "1" });
  });

  it("tells main the pause at the start and when it changes, and pauses from the menu", async () => {
    const r = rig();
    await r.notifier.start();
    expect(r.toMain.filter((e) => e.type === "pause")).toEqual([
      { type: "pause", enabled: true, untilMs: null },
    ]);
    const until = r.clock.now + 3_600_000;
    const prefs = await r.notifier.pause(until);
    expect(prefs.pausedUntilMs).toBe(until);
    expect(r.events.at(-1)).toEqual({ type: "notificationPrefsChanged", prefs });
    expect(r.toMain.filter((e) => e.type === "pause").at(-1)).toEqual({
      type: "pause",
      enabled: true,
      untilMs: until,
    });
    // Everything else stays as it was.
    expect({ ...prefs, pausedUntilMs: null }).toEqual(NOTIFIED);
    r.box.deliver(msg());
    await settle(r);
    expect(bannersOf(r)).toEqual([]);
    await r.notifier.pause(null);
    expect(r.notifier.get().pausedUntilMs).toBeNull();
    // The same pause again says nothing new.
    const count = r.toMain.filter((e) => e.type === "pause").length;
    await r.notifier.pause(null);
    expect(r.toMain.filter((e) => e.type === "pause")).toHaveLength(count);
  });

  it("says a refused test banner to the windows", () => {
    const r = rig();
    r.notifier.bannerFailed("Notifications are not allowed");
    expect(r.events).toEqual([
      { type: "notificationTestFailed", reason: "Notifications are not allowed" },
    ]);
  });

  it("looks at a held deadline again by itself when the pause ends", async () => {
    const day = 86_400_000;
    const clock = { now: 20 * day + 12 * 3_600_000 };
    const brain = agent();
    brain.reads("t-due", 0, true, [
      { kind: "ask", who: "you", dueMs: 20 * day, evidence: { quote: "Send it", messageKey: 1 } },
    ]);
    const r = rig(null, 12 * 60, { brain, clock });
    await r.notifier.set({ ...DEFAULT_NOTIFICATION_PREFS, pausedUntilMs: clock.now + 5 });
    await r.notifier.start();
    await r.notifier.idle();
    expect(bannersOf(r)).toEqual([]);
    expect(noticesOf(r)).toHaveLength(1);
    clock.now += 10;
    // The retry waits for the pause's end and a second more.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await r.notifier.idle();
    expect(bannersOf(r)).toEqual([expect.objectContaining({ title: "Due within a day" })]);
    expect(noticesOf(r)).toHaveLength(1);
    r.notifier.stop();
  });

  it("holds a deadline's banner through quiet hours and shows it after, inside once", async () => {
    const day = 86_400_000;
    const hour = 3_600_000;
    // 01:00 local on the due day (the rig's zone puts its start at 01:00).
    const clock = { now: 20 * day + hour };
    const brain = agent();
    brain.reads("t-due", 0, true, [
      {
        kind: "promise",
        who: "you",
        dueMs: 20 * day,
        evidence: { quote: "I will pay", messageKey: 1 },
      },
    ]);
    const statePath = join(await tempDir(), "notifications-state.json");
    const r = rig(null, 60, { brain, clock, statePath, dueEveryMs: 10 });
    await r.notifier.set({
      ...DEFAULT_NOTIFICATION_PREFS,
      quiet: { on: true, fromMin: 22 * 60, toMin: 7 * 60 },
    });
    await r.notifier.start();
    await r.notifier.idle();
    expect(bannersOf(r)).toEqual([]);
    expect(noticesOf(r).map((x) => x.title)).toEqual(["Due within a day"]);
    // Another hour, still quiet: nothing again.
    clock.now += hour;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await r.notifier.idle();
    expect(bannersOf(r)).toEqual([]);
    expect(noticesOf(r)).toHaveLength(1);
    r.notifier.stop();

    // A restart at 08:00: the banner that was owed goes, the notice inside does not repeat.
    clock.now = 20 * day + 7 * hour;
    const later = rig(null, 8 * 60, { brain, clock, statePath, dueEveryMs: 10 });
    await later.notifier.set({
      ...DEFAULT_NOTIFICATION_PREFS,
      quiet: { on: true, fromMin: 22 * 60, toMin: 7 * 60 },
    });
    await later.notifier.start();
    await later.notifier.idle();
    expect(bannersOf(later)).toEqual([
      expect.objectContaining({ title: "Due within a day", body: "Thing of t-due" }),
    ]);
    expect(noticesOf(later)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await later.notifier.idle();
    expect(bannersOf(later)).toHaveLength(1);
    later.notifier.stop();
  });
});

describe("NoticeShower, banners in main (ADR 0071, rule 8; ADR 0108)", () => {
  function host(focused: boolean) {
    const shown: {
      text: NoticeText;
      options: BannerOptions;
      banner: Banner & { fire(e: string, arg?: unknown): void; closed: boolean };
    }[] = [];
    const opened: [number, string][] = [];
    const badges: string[] = [];
    const acts: [string, number, string][] = [];
    const removed: string[][] = [];
    const failures: string[] = [];
    const pauses: PauseState[] = [];
    const shower = new NoticeShower({
      focused: () => focused,
      banner(text, options) {
        const listeners = new Map<string, (arg?: unknown) => void>();
        const banner = {
          closed: false,
          on(event: string, listener: (arg: never) => void) {
            listeners.set(event, listener as (arg?: unknown) => void);
          },
          show() {},
          close() {
            banner.closed = true;
          },
          fire(event: string, arg?: unknown) {
            listeners.get(event)?.(arg);
          },
        };
        shown.push({ text, options, banner });
        return banner;
      },
      setBadge: (t) => badges.push(t),
      open: (key, threadId) => opened.push([key, threadId]),
      act: (action, key, threadId) => acts.push([action, key, threadId]),
      remove: (ids) => removed.push([...ids]),
      failed: (reason) => failures.push(reason),
      paused: (state) => pauses.push(state),
    });
    return { shower, shown, opened, badges, acts, removed, failures, pauses };
  }
  const text = (key: number, alone = false): NoticeText => ({
    key,
    threadId: `t${key}`,
    accountId: "a1",
    title: "Anna",
    body: "Umowa",
    ...(alone ? { alone: true as const } : {}),
  });

  it("shows nothing while the window is in front, unless asked", () => {
    const h = host(true);
    h.shower.handle({ type: "banners", banners: [text(1)], sound: true, whenFront: false });
    expect(h.shown).toEqual([]);
    h.shower.handle({ type: "banners", banners: [text(1)], sound: true, whenFront: true });
    expect(h.shown).toHaveLength(1);
  });

  it("rings once for mail that came together, opens on click, and lets go", () => {
    const h = host(false);
    h.shower.handle({
      type: "banners",
      banners: [text(1), text(2)],
      sound: true,
      whenFront: false,
    });
    expect(h.shown.map((s) => s.options.silent)).toEqual([false, true]);
    expect(h.shower.held).toBe(2);
    h.shown[1]?.banner.fire("click");
    expect(h.opened).toEqual([[2, "t2"]]);
    h.shown[0]?.banner.fire("close");
    expect(h.shower.held).toBe(0);
    h.shower.handle({ type: "badge", text: "3" });
    expect(h.badges).toEqual(["3"]);
  });

  it("gives a banner of one message its two buttons and an id, and nothing else gets them", () => {
    const h = host(false);
    const summary = { ...text(3), title: "3 more new messages" };
    const test: NoticeText = { ...text(0), threadId: "" };
    h.shower.handle({
      type: "banners",
      banners: [text(1, true), summary, test],
      sound: false,
      whenFront: false,
    });
    expect(h.shown.map((s) => s.options)).toEqual([
      { silent: true, id: "mail-1", actions: ["Mark as Read", "Archive"] },
      { silent: true, actions: [] },
      { silent: true, actions: [] },
    ]);
  });

  it("acts on its message without opening the window, and only for a known button", () => {
    const h = host(false);
    h.shower.handle({
      type: "banners",
      banners: [text(1, true), text(2, true), text(3)],
      sound: false,
      whenFront: false,
    });
    h.shown[0]?.banner.fire("action", 0);
    h.shown[1]?.banner.fire("action", 1);
    h.shown[1]?.banner.fire("action", 7);
    h.shown[2]?.banner.fire("action", 0);
    expect(h.acts).toEqual([
      ["read", 1, "t1"],
      ["archive", 2, "t2"],
    ]);
    expect(h.opened).toEqual([]);
    expect(h.shower.held).toBe(0);
  });

  it("takes back the banners of read mail: closes those held, removes the rest by id", () => {
    const h = host(false);
    h.shower.handle({
      type: "banners",
      banners: [text(1, true), text(2, true), text(1)],
      sound: false,
      whenFront: false,
    });
    h.shower.handle({ type: "close", keys: [1, 9] });
    expect(h.shown.map((s) => s.banner.closed)).toEqual([true, false, false]);
    expect(h.removed).toEqual([["mail-1", "mail-9"]]);
    expect(h.shower.held).toBe(2);
    h.shower.handle({ type: "close", keys: [] });
    expect(h.removed).toHaveLength(1);
  });

  it("passes on a refused test banner, and the pause for the menu", () => {
    const h = host(false);
    h.shower.handle({
      type: "banners",
      banners: [{ ...text(0), threadId: "" }, text(4, true)],
      sound: false,
      whenFront: true,
    });
    h.shown[1]?.banner.fire("failed", "not allowed");
    h.shown[0]?.banner.fire("failed", "Notifications are not allowed");
    expect(h.failures).toEqual(["Notifications are not allowed"]);
    h.shower.handle({ type: "pause", enabled: true, untilMs: 5 });
    expect(h.pauses).toEqual([{ enabled: true, untilMs: 5 }]);
  });

  it("takes only well-formed notices off the line", () => {
    expect(noticeFrom({ type: "badge", text: "2" })).toEqual({ type: "badge", text: "2" });
    expect(noticeFrom({ type: "badge", text: 2 })).toBeNull();
    expect(noticeFrom({ requestId: "m1" })).toBeNull();
    const event = noticeFrom({
      type: "banners",
      banners: [
        { title: "A", body: "B", key: 3, threadId: "t", alone: true },
        { title: 5 },
        { title: "C", body: "D", key: -1, threadId: "t", alone: true },
        { title: "E", body: "F", key: 4, threadId: "x".repeat(300), alone: true },
      ],
      sound: "yes",
    });
    expect(event).toEqual({
      type: "banners",
      banners: [
        { key: 3, threadId: "t", accountId: "", title: "A", body: "B", alone: true },
        { key: 0, threadId: "t", accountId: "", title: "C", body: "D" },
        { key: 4, threadId: "", accountId: "", title: "E", body: "F" },
      ],
      sound: false,
      whenFront: false,
    });
    expect(noticeFrom({ type: "close", keys: [1, -2, "3", 1.5, 4] })).toEqual({
      type: "close",
      keys: [1, 4],
    });
    expect(noticeFrom({ type: "close", keys: "1" })).toBeNull();
    expect(noticeFrom({ type: "pause", enabled: true, untilMs: Number.NaN })).toEqual({
      type: "pause",
      enabled: true,
      untilMs: null,
    });
    expect(noticeFrom({ type: "pause", enabled: false, untilMs: 9 })).toEqual({
      type: "pause",
      enabled: false,
      untilMs: 9,
    });
  });
});

describe("the router's pause and refused-banner requests (ADR 0108)", () => {
  it("pauses through the router, and turns away a bad time", async () => {
    const r = rig();
    await r.notifier.start();
    const deps = { notifications: r.notifier } as never;
    const ok = await handle(deps, { type: "pauseNotifications", requestId: "1", untilMs: 5e12 });
    expect(ok).toMatchObject({ type: "pauseNotifications", ok: true });
    expect(r.notifier.get().pausedUntilMs).toBe(5e12);
    for (const untilMs of ["soon", -1, Number.POSITIVE_INFINITY, undefined]) {
      const bad = await handle(deps, { type: "pauseNotifications", requestId: "2", untilMs });
      expect(bad).toMatchObject({ ok: false, code: "invalidRequest" });
    }
    await handle(deps, { type: "pauseNotifications", requestId: "3", untilMs: null });
    expect(r.notifier.get().pausedUntilMs).toBeNull();
    const failed = await handle(deps, {
      type: "bannerFailed",
      requestId: "4",
      reason: "x".repeat(500),
    });
    expect(failed).toMatchObject({ type: "bannerFailed", ok: true });
    expect(r.events.at(-1)).toEqual({ type: "notificationTestFailed", reason: "x".repeat(200) });
    r.notifier.stop();
  });
});

describe("the menu's Notifications items (ADR 0108)", () => {
  const day = 86_400_000;
  const hour = 3_600_000;
  const cet = () => 60;
  const now = 10 * day + 13 * hour; // 14:00 local

  it("offers the two pauses, or says the pause and offers Resume", () => {
    expect(pauseMenu({ enabled: true, untilMs: null }, now, cet)).toEqual([
      { label: "Pause for an Hour", choice: "hour" },
      { label: "Pause Until Tomorrow", choice: "tomorrow" },
    ]);
    expect(pauseMenu({ enabled: true, untilMs: now + 30 * 60_000 }, now, cet)).toEqual([
      { label: "Paused until 14:30" },
      { label: "Resume", choice: "resume" },
    ]);
    // A pause that is over offers to pause again.
    expect(pauseMenu({ enabled: true, untilMs: now - 1 }, now, cet)[0]?.choice).toBe("hour");
    expect(pauseMenu({ enabled: false, untilMs: null }, now, cet)).toEqual([
      { label: "Notifications Are Off" },
    ]);
  });

  it("sets the time when chosen, by the same rule as Settings", () => {
    expect(pauseTarget("hour", now, cet)).toBe(now + hour);
    expect(pauseTarget("tomorrow", now, cet)).toBe(11 * day + 7 * hour);
    expect(pauseTarget("resume", now, cet)).toBeNull();
  });
});

describe("how the app runs, for Settings (ADR 0108)", () => {
  const plist = (id: string) =>
    `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key>\n\t<string>${id}</string></dict></plist>`;

  it("tells its own bundle from the stock runtime by the running bundle's id", () => {
    const read = (files: Record<string, string>) => (path: string) => files[path] ?? null;
    expect(
      noticeSystem(
        "darwin",
        "/Apps/Matters.app/Contents/MacOS/Electron",
        read({ "/Apps/Matters.app/Contents/Info.plist": plist(MATTERS_BUNDLE_ID) }),
      ),
    ).toEqual({ platform: "macos", app: "own" });
    expect(
      noticeSystem(
        "darwin",
        "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        read({
          "/repo/node_modules/electron/dist/Electron.app/Contents/Info.plist":
            plist("com.github.Electron"),
        }),
      ),
    ).toEqual({ platform: "macos", app: "runtime" });
    expect(noticeSystem("darwin", "/usr/bin/electron", read({}))).toEqual({
      platform: "macos",
      app: "unknown",
    });
    expect(noticeSystem("win32", "C:\\x.exe", read({}))).toEqual({
      platform: "windows",
      app: "unknown",
    });
    expect(bundleOf("/a/b.app/Contents/MacOS/c")).toBe("/a/b.app");
    expect(bundleIdOf("<key>CFBundleName</key><string>x</string>")).toBeNull();
  });

  it("opens System Settings at a fixed address of the Notifications pane", () => {
    expect(NOTIFICATION_SETTINGS_URL).toBe(
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=app.getmatters.Matters",
    );
  });

  it("passes on only the two questions, from the page itself", async () => {
    const asked: unknown[] = [];
    const posted: unknown[] = [];
    const page = {};
    const bridge = createNoticeBridge(
      {
        invoke: async (channel, ...args) => {
          asked.push([channel, ...args]);
          return { platform: "macos", app: "own" };
        },
        post: (message) => posted.push(message),
      },
      page,
    );
    bridge.message({
      source: page,
      data: { mattersNoticeSystem: { requestId: "r1", action: "status" } },
    });
    bridge.message({
      source: page,
      data: { mattersNoticeSystem: { requestId: "r2", action: "https://example.com" } },
    });
    bridge.message({
      source: {},
      data: { mattersNoticeSystem: { requestId: "r3", action: "openSettings" } },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([["matters:notice-system", "status"]]);
    expect(posted).toEqual([
      { mattersNoticeSystemAnswer: { requestId: "r2", answer: null } },
      { mattersNoticeSystemAnswer: { requestId: "r1", answer: { platform: "macos", app: "own" } } },
    ]);
  });
});

describe("the stack of notices in the window (ADR 0071, rule 7)", () => {
  const text = (key: number): NoticeText => ({
    key,
    threadId: `t${key}`,
    accountId: "a1",
    title: `T${key}`,
    body: "",
  });

  it("puts new ones on top, shows three and counts the rest", () => {
    let s = push(EMPTY, [text(1), text(2)], 6);
    s = push(s, [text(3), text(4), text(1)], 6);
    expect(s.notices.map((x) => x.key)).toEqual([3, 4, 1, 2]);
    expect(moreText(s)).toBe("1 more");
    expect(moreText(clear(s))).toBe("");
  });

  it("lets time run out only for the shown ones, and keeps the cards themselves", () => {
    let s = push(EMPTY, [text(1), text(2), text(3), text(4)], 1);
    const first = s.notices[0];
    s = tick(s, 500);
    expect(s.notices[0]).toBe(first);
    expect(s.left[s.notices[3]?.id ?? 0]).toBe(1000);
    s = tick(s, 500);
    expect(s.notices.map((x) => x.key)).toEqual([4]);
    const forever = push(EMPTY, [text(9)], 0);
    expect(tick(forever, 60_000)).toBe(forever);
    expect(dismiss(forever, forever.notices[0]?.id ?? 0).notices).toEqual([]);
  });
});
