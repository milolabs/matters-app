import type {
  Message,
  NotificationPrefs,
  SavedView,
  TalkActOffer,
  TalkMessageOffer,
  TalkViewOffer,
} from "@matters/core";
import { actMatches, COUNT_CAP, DEFAULT_NOTIFICATION_PREFS } from "@matters/core";
import { makeMessage } from "@matters/testkit";
import { describe, expect, it } from "vitest";
import {
  actDone,
  actLine,
  actQuestion,
  actTooMany,
  bodyPreview,
  factLines,
  NOTIFY_FAILED,
  offerCount,
  prefillOf,
  resolveAct,
  runAct,
  savedViewFor,
  saveViewOffer,
  saveViewOffers,
  TOO_MANY,
  unknownLine,
  VIEW_NOTIFY,
} from "../src/renderer/talkOffers.ts";

// ADR 0102. What each press of an offer does, without a page.

const view = (name: string, query: string, over: Partial<TalkViewOffer> = {}): TalkViewOffer => ({
  kind: "view",
  name,
  query,
  why: "Keeps them together.",
  matches: 128,
  matchesCapped: false,
  unread: 12,
  ...over,
});
const saved = (id: string, name: string, query: string): SavedView => ({
  id,
  name,
  query,
  position: 0,
  createdMs: 1,
  updatedMs: 1,
});
const act = (over: Partial<TalkActOffer> = {}): TalkActOffer => ({
  kind: "act",
  action: "archive",
  query: "from:news.test",
  why: "Old news.",
  matches: 40,
  matchesCapped: false,
  unread: 5,
  ...over,
});

describe("view offers", () => {
  it("say how many messages and unread, with a plus past the cap", () => {
    expect(offerCount(view("a", "b"))).toBe("128 messages · 12 unread");
    expect(offerCount(view("a", "b", { matches: 500, matchesCapped: true }))).toBe(
      "500+ messages · 12+ unread",
    );
    expect(offerCount(view("a", "b", { matches: 1, unread: 0 }))).toBe("1 message");
  });

  it("are saved when a view has the same name, ignoring case, and the same query text; read from the views now", () => {
    const o = view("Invoices", "subject:invoice");
    expect(savedViewFor(o, [saved("v1", "invoices", " subject:invoice ")])?.id).toBe("v1");
    expect(savedViewFor(o, [saved("v1", "Invoices", "subject:invoices")])).toBeUndefined();
    expect(savedViewFor(o, [saved("v1", "Bills", "subject:invoice")])).toBeUndefined();
  });

  function prefsRig(failSet = false) {
    let prefs: NotificationPrefs = DEFAULT_NOTIFICATION_PREFS;
    const backend = {
      getNotificationPrefs: async () => prefs,
      setNotificationPrefs: async (next: NotificationPrefs) => {
        if (failSet) throw new Error("no");
        prefs = next;
        return next;
      },
    };
    return { backend, prefs: () => prefs };
  }

  it("save the view, and with notify turn on its every channel; the rest of the prefs stays", async () => {
    const r = prefsRig();
    const created: string[] = [];
    const create = async (name: string, query: string) => {
      created.push(name);
      return { ok: true as const, view: saved("v9", name, query) };
    };
    expect(
      await saveViewOffer(view("Accountant", "from:acc.test"), { create, backend: r.backend }),
    ).toEqual({ ok: true });
    expect(r.prefs().views).toEqual({});
    expect(
      await saveViewOffer(view("Accountant", "from:acc.test", { notify: true }), {
        create,
        backend: r.backend,
      }),
    ).toEqual({ ok: true });
    expect(r.prefs().views).toEqual({ v9: VIEW_NOTIFY });
    expect(r.prefs().kinds).toEqual(DEFAULT_NOTIFICATION_PREFS.kinds);
    expect(created).toEqual(["Accountant", "Accountant"]);
  });

  it("keep the view when its notifications cannot be written, and say so; a refused view says why", async () => {
    const r = prefsRig(true);
    const create = async (name: string, query: string) => ({
      ok: true as const,
      view: saved("v1", name, query),
    });
    expect(
      await saveViewOffer(view("A", "q", { notify: true }), { create, backend: r.backend }),
    ).toEqual({ ok: true, note: NOTIFY_FAILED });
    const refuse = async () => ({ ok: false as const, message: "You can have at most 50 views." });
    expect(
      await saveViewOffer(view("A", "q", { notify: true }), { create: refuse, backend: r.backend }),
    ).toEqual({ ok: false, message: "You can have at most 50 views." });
  });

  it("are saved all at once, those not saved yet, only views, and each failure is said by its place", async () => {
    const views: SavedView[] = [saved("v0", "Partner", "from:partner.test")];
    const tried: string[] = [];
    const save = async (o: TalkViewOffer) => {
      tried.push(o.name);
      if (o.name === "Taken") return { ok: false as const, message: "Taken." };
      views.push(saved(`v${views.length}`, o.name, o.query));
      return { ok: true as const };
    };
    const offers = [
      view("Partner", "from:partner.test"),
      act(),
      view("Taken", "x"),
      view("Bills", "bill"),
    ];
    const said = await saveViewOffers(offers, () => views, save);
    expect(tried).toEqual(["Taken", "Bills"]);
    expect([...said]).toEqual([[2, { ok: false, message: "Taken." }]]);
    tried.length = 0;
    await saveViewOffers(offers, () => views, save);
    expect(tried).toEqual(["Taken"]);
  });
});

/**
 * The backend's match of a clean-up over these messages, as `matchQuery` keeps them: newest
 * first, at most the cap, `capped` past it. The scope itself is tested in core.
 */
function matchRig(messages: Message[]) {
  const calls: string[] = [];
  const sorted = [...messages].sort((a, b) => b.key - a.key);
  return {
    calls,
    backend: {
      agentMatchAct: async (query: string) => {
        calls.push(query);
        return actMatches({
          messages: sorted.slice(0, COUNT_CAP),
          capped: sorted.length > COUNT_CAP,
        });
      },
    } satisfies Parameters<typeof resolveAct>[0],
  };
}

const read = { seen: true, flagged: false, answered: false, draft: false };
const mail = (n: number, thread: string, over: Partial<Message> = {}) =>
  makeMessage({ providerId: `m${n}`, threadId: thread, seq: n, subject: `S ${thread}`, ...over });

describe("clean-up offers", () => {
  it("say what they would do, with the code's count", () => {
    expect(actLine(act())).toBe("Archive 40 messages");
    expect(actLine(act({ action: "trash", matches: 1 }))).toBe("Move 1 message to Trash");
    expect(actLine(act({ action: "markRead", unread: 5 }))).toBe("Mark 5 unread messages read");
    expect(actLine(act({ matches: 500, matchesCapped: true }))).toBe("Archive 500+ messages");
  });

  it("are not offered to run past the cap: only to show", () => {
    expect(actTooMany(act())).toBe(false);
    expect(actTooMany(act({ matchesCapped: true }))).toBe(true);
    expect(actTooMany(act({ matches: COUNT_CAP + 1 }))).toBe(true);
  });

  it("act on what the backend matches when pressed, in the scope of the count, each thread once with its account", async () => {
    const r = matchRig([
      mail(1, "a"),
      mail(2, "a", { flags: read }),
      mail(3, "b", { accountId: "acc2" }),
    ]);
    const got = await resolveAct(r.backend, "from:news.test");
    expect(got.tooMany).toBe(false);
    expect(got.messages).toHaveLength(3);
    expect(got.threads).toEqual([
      { threadId: "b", accountId: "acc2", subject: "S b" },
      { threadId: "a", accountId: "acc1", subject: "S a" },
    ]);
    expect(r.calls).toEqual(["from:news.test"]);
    expect(actQuestion("archive", got)).toBe(
      "Archive 2 threads? They hold the 3 messages that match, and move whole.",
    );
    expect(actQuestion("trash", got)).toBe(
      "Move 2 threads to Trash? They hold the 3 messages that match, and move whole.",
    );
    expect(actQuestion("markRead", got)).toBe("Mark 2 messages read?");
  });

  it("say too many when more than the cap match at the press, and do nothing", async () => {
    const many = Array.from({ length: COUNT_CAP + 3 }, (_, i) => mail(i + 1, `t${i % 7}`));
    const r = matchRig(many);
    const got = await resolveAct(r.backend, "x");
    expect(got.tooMany).toBe(true);
    expect(r.calls).toHaveLength(1);
    const paths = {
      moveThreads: async () => "moved" as const,
      markSeen: async () => {},
    };
    expect(await runAct("archive", got, paths)).toEqual({ ok: false, message: TOO_MANY });
  });

  it("run through the list's own paths: one move of all the threads, or one mark of the unread", async () => {
    const r = matchRig([mail(1, "a"), mail(2, "a", { flags: read }), mail(3, "b")]);
    const got = await resolveAct(r.backend, "x");
    const moved: unknown[] = [];
    const marked: unknown[] = [];
    const paths = {
      moveThreads: async (subjects: unknown, action: unknown) => {
        moved.push([subjects, action]);
        return "moved" as const;
      },
      markSeen: async (keys: readonly number[], seen: boolean) => {
        marked.push([keys, seen]);
      },
    };
    expect(await runAct("trash", got, paths)).toEqual({ ok: true });
    expect(moved).toEqual([[got.threads, "delete"]]);
    expect(actDone("trash", got)).toBe(
      "Moved 2 threads to Trash. Undo is in the tray at the bottom.",
    );
    expect(await runAct("markRead", got, paths)).toEqual({ ok: true });
    expect(marked).toEqual([[got.messages.filter((m) => !m.seen).map((m) => m.key), true]]);
    expect(actDone("markRead", got)).toBe("Marked 2 messages read.");
  });

  it("say so when nothing is left to do, or the move did not work", async () => {
    const r = matchRig([mail(1, "a", { flags: read })]);
    const got = await resolveAct(r.backend, "x");
    expect(actQuestion("markRead", got)).toBeNull();
    const failing = { moveThreads: async () => "failed" as const, markSeen: async () => {} };
    expect(await runAct("archive", got, failing)).toMatchObject({ ok: false });
    expect(await runAct("markRead", got, failing)).toMatchObject({ ok: false });
    const empty = await resolveAct(matchRig([]).backend, "x");
    expect(actQuestion("archive", empty)).toBeNull();
  });
});

describe("message offers", () => {
  const offer: TalkMessageOffer = {
    kind: "message",
    to: ["anna@north.test"],
    unknownTo: ["x@far.test"],
    subject: "Late",
    body: "Hi Anna,\n\nI will be late.\nSorry.\nSee you.",
    why: "Asked.",
  };

  it("show the first lines, name who was left out, and open the composer with only what was kept", () => {
    expect(bodyPreview(offer.body)).toBe("Hi Anna,\nI will be late.\nSorry.\n…");
    expect(unknownLine(offer)).toBe("Not added: x@far.test — you have not written to them before.");
    expect(unknownLine({ ...offer, unknownTo: [] })).toBeNull();
    expect(prefillOf(offer)).toEqual({
      to: ["anna@north.test"],
      subject: "Late",
      body: offer.body,
    });
  });
});

describe("the counts under an answer", () => {
  it("are lines of the code's numbers: each count with its query, and the overview's first senders", () => {
    expect(
      factLines([
        { kind: "count", query: "from:anna", matches: 500, capped: true, unread: 3 },
        {
          kind: "overview",
          months: 3,
          senders: [
            { key: "anna@north.test", name: "Anna", messages: 9, unread: 0 },
            { key: "bot@shop.test", messages: 4, unread: 4 },
          ],
          domains: [{ key: "north.test", messages: 9, unread: 0 }],
        },
      ]),
    ).toEqual([
      { label: "Counted", query: "from:anna", count: "500+ messages · 3+ unread" },
      { label: "Wrote most, last 3 months: Anna <anna@north.test>", count: "9 messages" },
      { label: "Wrote most, last 3 months: bot@shop.test", count: "4 messages · 4 unread" },
    ]);
  });
});
